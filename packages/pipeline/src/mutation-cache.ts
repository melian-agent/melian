import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CacheScratch } from "./cache-scratch.ts";

const bound = 16 * 1024 * 1024;
// The partition's file wraps a report of up to `bound` with the head that wrote it and that run's leave.
const wrapping = 1024;
// How long a publish may hold the partition's lock before another takes it as a crashed holder's, and how often a waiting
// publish looks again. A publish holds it for a read, a git ancestry check and a rename.
export const staleLockMs = 120_000;
const lockPollMs = 50;

// What a partition is shared by: the heads of one review target, judged against one base under one base policy, with one
// installation and one Stryker. The head is not part of it, so a later head reuses the last judged head's results.
export interface MutationCacheKey {
	readonly base: string;
	readonly policy: string;
	readonly target: string;
	readonly inputs: string;
	readonly installation: string;
}

/** Whose leave ran a head's tests: a writer pushed it, or the reviewer vouched for it with `--trust-head`. */
export type HeadTrust = "writer" | "reviewer";

// The head whose results a partition holds, the leave its tests ran under, and whether they are a cold run's of that
// head: a plain review of the same head may then keep the cold run's standing.
export interface JudgedHead {
	readonly head: string;
	readonly trust: HeadTrust;
	readonly cold: boolean;
}

// The text of a file, read through one no-follow open: a regular file within `limit` that parses, or undefined. What was
// checked is what is returned, so nothing can be swapped in between. The text is dropped in the catch, not returned from
// it, so a file that does not parse cannot fall through as read.
async function jsonText(path: string, limit: number): Promise<string | undefined> {
	let text: string | undefined;
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > limit) return undefined;
			text = await file.readFile("utf8");
			JSON.parse(text);
		} finally {
			await file.close();
		}
	} catch {
		text = undefined;
	}
	return text;
}

// The run writes a staged copy in its scratch; only a run that still holds authority publishes a completed partition.
export class MutationCache {
	readonly directory: string;
	readonly file: string;
	readonly #root: string;
	private constructor(root: string, directory: string) {
		this.#root = root;
		this.directory = directory;
		this.file = join(directory, "partition.json");
	}

	static async open(root: string, key: MutationCacheKey): Promise<MutationCache> {
		await CacheScratch.open(root);
		const name = createHash("sha256")
			.update(JSON.stringify({ version: 3, key }))
			.digest("hex");
		const directory = join(root, "mutation", name);
		await mkdir(directory, { recursive: true });
		const cache = new MutationCache(root, await realpath(directory));
		if ((await cache.#read()) === undefined) await rm(cache.file, { recursive: true, force: true });
		return cache;
	}

	// The last judged head's report, when a run under `trust` may build on it: that run was trusted the same way, and
	// `ancestor` says the judged head is in this head's history. Otherwise why the run starts cold.
	async earlier(
		trust: HeadTrust,
		ancestor: (judged: string) => Promise<boolean>,
	): Promise<{ readonly judged: JudgedHead; readonly report: string } | { readonly cold: string }> {
		const stored = await this.#read();
		if (stored === undefined) return { cold: "this review target has no earlier judged head" };
		const judged = stored.head.slice(0, 12);
		if (stored.trust !== trust)
			return { cold: `the run that judged ${judged} was trusted as ${String(stored.trust)}, not as ${trust}` };
		if (!(await ancestor(stored.head)))
			return { cold: `the last judged head ${judged} is not in this head's history, which was rewritten` };
		return { judged: { head: stored.head, trust, cold: stored.cold }, report: stored.report };
	}

	// Writes `report` where Stryker reads its incremental file, and a second copy a whole-suite repeat starts from, so the
	// repeat reuses the earlier head's results and not the related run's.
	async stage(directory: string, report: string | undefined): Promise<{ staged: string; earlier: string }> {
		const staged = join(directory, "incremental.json");
		const earlier = join(directory, "earlier.json");
		await mkdir(directory, { recursive: true });
		for (const path of [staged, earlier]) {
			await rm(path, { recursive: true, force: true });
			if (report !== undefined) await writeFile(path, report);
		}
		return { staged, earlier };
	}

	// The head's tests ran beside the staged file, so it is taken only as a regular file within the bound that parses. A
	// run of an older head, such as one a crash left pending and a later review resumed, finishing after a newer head's
	// run, must not put its results back in place of the newer ones: `ancestor` says whether this head is in the held
	// head's history.
	// The read of the held head, the check and the rename happen under one lock, so another run cannot publish a newer
	// head between this run's check and its rename.
	async publish(
		staged: string,
		judged: JudgedHead,
		seen: string | undefined,
		ancestor: (older: string, newer: string) => Promise<boolean>,
	): Promise<void> {
		const report = await jsonText(staged, bound);
		if (report === undefined) return;
		const scratch = await CacheScratch.open(this.#root);
		const temporary = scratch.file(this.file);
		await writeFile(
			temporary,
			`{"version":3,"head":${JSON.stringify(judged.head)},"trust":${JSON.stringify(judged.trust)},"cold":${judged.cold},"report":${report}}`,
		);
		await this.#locked(async () => {
			if (await this.#replaces(judged.head, seen, ancestor)) await rename(temporary, this.file);
		});
		await rm(temporary, { force: true });
	}

	// A directory made with mkdir is the lock: making it fails while another holds it. A lock older than `staleLockMs`
	// is a crashed holder's, and is removed.
	async #locked(use: () => Promise<void>): Promise<void> {
		const lock = join(this.directory, "partition.lock");
		for (;;) {
			try {
				await mkdir(lock);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				// A lock gone between the two calls reads as just made, and the next attempt takes it.
				const made = (await stat(lock).catch(() => undefined))?.mtimeMs ?? Date.now();
				if (Date.now() - made > staleLockMs) await rmdir(lock).catch(() => undefined);
				else await sleep(lockPollMs);
			}
		}
		try {
			await use();
		} finally {
			await rmdir(lock);
		}
	}

	// Whether a run of `head` may replace what the partition holds: nothing, its own head, or a head in its history. A
	// newer head of its own line it never replaces, as a late run of an older head must not. A head of another line, after
	// a force-push, it replaces only when it already held that head when the run began (`seen`): the run then started
	// cold because of it. Otherwise the other line is a late run's, as a run of the old line finishing after a force-push
	// published the new one.
	async #replaces(
		head: string,
		seen: string | undefined,
		ancestor: (older: string, newer: string) => Promise<boolean>,
	): Promise<boolean> {
		const held = (await this.#read())?.head;
		if (held === undefined || held === head || (await ancestor(held, head))) return true;
		if (await ancestor(head, held)) return false;
		return held === seen;
	}

	// The head the partition holds now, which `publish` compares with what it holds when the run ends.
	async held(): Promise<string | undefined> {
		return (await this.#read())?.head;
	}

	async #read(): Promise<{ head: string; trust: unknown; cold: boolean; report: string } | undefined> {
		const text = await jsonText(this.file, bound + wrapping);
		if (text === undefined) return undefined;
		// Any JSON but null destructures; a number or a string simply has none of these fields.
		const parsed = JSON.parse(text) as { head?: unknown; trust?: unknown; cold?: unknown; report?: unknown } | null;
		if (parsed === null) return undefined;
		const { head, trust, cold, report } = parsed;
		if (typeof head !== "string" || !/^[0-9a-f]{40,64}$/.test(head)) return undefined;
		if (typeof report !== "object" || report === null) return undefined;
		return { head, trust, cold: cold === true, report: JSON.stringify(report) };
	}
}

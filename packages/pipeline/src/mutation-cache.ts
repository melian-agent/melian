import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CacheScratch } from "./cache-scratch.ts";

const bound = 16 * 1024 * 1024;
// The partition's file wraps a report of up to `bound` with the head that wrote it and that run's leave.
const wrapping = 1024;

/**
 * What a partition is shared by: the heads of one review target, such as a pull request, judged against one base under
 * one base policy, with one installation and one Stryker. The head is not part of it: a later head reuses the last judged head's results.
 */
export interface MutationCacheKey {
	readonly base: string;
	readonly policy: string;
	readonly target: string;
	readonly inputs: string;
	readonly installation: string;
}

/** Whose leave ran a head's tests: a writer pushed it, or the reviewer vouched for it with `--trust-head`. */
export type HeadTrust = "writer" | "reviewer";

/** The head whose results a partition holds, and the leave its tests ran under. */
export interface JudgedHead {
	readonly head: string;
	readonly trust: HeadTrust;
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

	/**
	 * The last judged head's report, when a run under `trust` may build on it: that run was trusted the same way, and
	 * `ancestor` says the judged head is in this head's history. Otherwise why the run starts cold.
	 */
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
		return { judged: { head: stored.head, trust }, report: stored.report };
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
	async publish(staged: string, judged: JudgedHead, ancestor: (held: string) => Promise<boolean>): Promise<void> {
		const report = await jsonText(staged, bound);
		if (report === undefined) return;
		const held = (await this.#read())?.head;
		if (held !== undefined && held !== judged.head && (await ancestor(held))) return;
		const scratch = await CacheScratch.open(this.#root);
		const temporary = scratch.file(this.file);
		await writeFile(
			temporary,
			`{"version":3,"head":${JSON.stringify(judged.head)},"trust":${JSON.stringify(judged.trust)},"report":${report}}`,
		);
		await rename(temporary, this.file);
	}

	async #read(): Promise<{ head: string; trust: unknown; report: string } | undefined> {
		const text = await jsonText(this.file, bound + wrapping);
		if (text === undefined) return undefined;
		// Any JSON but null destructures; a number or a string simply has none of these fields.
		const parsed = JSON.parse(text) as { head?: unknown; trust?: unknown; report?: unknown } | null;
		if (parsed === null) return undefined;
		const { head, trust, report } = parsed;
		if (typeof head !== "string" || !/^[0-9a-f]{40,64}$/.test(head)) return undefined;
		if (typeof report !== "object" || report === null) return undefined;
		return { head, trust, report: JSON.stringify(report) };
	}
}

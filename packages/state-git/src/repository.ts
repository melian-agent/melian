import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type GitResult, git, RecordError } from "@melian-agent/core";
import { checkConfiguration, writeConfiguration } from "./configuration.ts";

// Settings that would run a program, sign, or start work in the background, set on every command so that no
// configuration of the user's or this repository's turns them back on. The configuration check covers the keys a
// command line cannot clear, such as a credential helper or `include.path`.
const overrides = [
	// A hook, such as reference-transaction, would run as Melian on every ref this repository updates.
	"core.hooksPath=/dev/null",
	"core.fsmonitor=false",
	// commit-tree and push sign when these ask, which runs `gpg.program`.
	"commit.gpgSign=false",
	"push.gpgSign=false",
	// A fetch starts gc or maintenance, which can detach and outlive the call's deadline.
	"gc.auto=0",
	"maintenance.auto=false",
	"fetch.recurseSubmodules=false",
	// An `ext::` URL runs a command, and the URL is the clone's `origin`, which Melian did not write.
	"protocol.ext.allow=never",
].flatMap((setting) => ["-c", setting]);

const environment = {
	LC_ALL: "C",
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "Melian",
	GIT_AUTHOR_EMAIL: "melian@invalid",
	GIT_COMMITTER_NAME: "Melian",
	GIT_COMMITTER_EMAIL: "melian@invalid",
};

// Another process's fetch or ref update on this repository holds these locks for a moment.
const contention = /shallow\.lock|cannot lock ref|Unable to create '.*\.lock'/;

// A refusal because the branch moved: the client saw a newer tip than its lease, or the remote's ref moved, or was
// locked by another push, between its advertisement and the update. Anything else, such as a hook that declined, is
// no race and no retry clears it.
const lostRace =
	/\t\[rejected\] \((stale info|fetch first|non-fast-forward|already exists)\)|\t\[remote rejected\] \((failed to update ref|cannot lock ref|incorrect old value)/;

/** One entry of a commit's tree, as `ls-tree -r -z` gives it. */
export type TreeEntry = { readonly mode: string; readonly type: string; readonly oid: string; readonly path: Buffer };

/** A file a commit adds, by its bytes, or removes, by `null`. */
export type TreeChange = { readonly path: string; readonly bytes: string | null };

/** How a push ended: it landed, a newer tip refused it, or it ran past its deadline and may have landed. */
export type PushOutcome = "landed" | "stale" | "timedOut";

function unreachable(message: string, result?: GitResult, cause?: unknown): RecordError {
	const said = result?.stderr.trim();
	return new RecordError("unreachable", said ? `${message}: ${said}` : message, { cause });
}

/**
 * The bare repository Melian keeps beside a clone, at `records.git` in its state directory, which holds fetches of the
 * branch's tip and the commits Melian builds on them. Its configuration is Melian's alone, checked before every command.
 */
export class RecordRepository {
	readonly path: string;

	private constructor(path: string) {
		this.path = path;
	}

	/** Opens the repository at `path`, creating it with Melian's configuration when it is not there. */
	static async open(path: string): Promise<RecordRepository> {
		const found = await lstat(path).catch((cause: unknown) => {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
				throw unreachable(`${path} cannot be read`, undefined, cause);
		});
		if (found === undefined) await RecordRepository.#create(path);
		else if (!found.isDirectory()) throw unreachable(`${path} is not a directory`);
		const repository = new RecordRepository(path);
		await checkConfiguration(path);
		return repository;
	}

	// Built under a name of its own and renamed, so two processes opening at once never share a half-made repository.
	static async #create(path: string): Promise<void> {
		const building = `${path}.${randomUUID()}`;
		try {
			await mkdir(dirname(path), { recursive: true });
			const made = await git(dirname(path), ["init", "--bare", "--quiet", building], { env: environment });
			if (made.code !== 0) throw unreachable(`${path} cannot be created`, made);
			await writeConfiguration(building);
			await rename(building, path).catch(async (cause: unknown) => {
				const code = (cause as NodeJS.ErrnoException).code;
				if (code !== "EEXIST" && code !== "ENOTEMPTY") throw cause;
			});
		} catch (cause) {
			if (cause instanceof RecordError) throw cause;
			throw unreachable(`${path} cannot be created`, undefined, cause);
		} finally {
			await rm(building, { recursive: true, force: true });
		}
	}

	async run(args: readonly string[], options: { input?: string; deadlineMs?: number; index?: string } = {}) {
		await checkConfiguration(this.path);
		return git(this.path, ["--git-dir", this.path, ...overrides, ...args], {
			...(options.input === undefined ? {} : { input: options.input }),
			...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
			env: { ...environment, ...(options.index === undefined ? {} : { GIT_INDEX_FILE: options.index }) },
		});
	}

	async #succeed(args: readonly string[], options: { input?: string; index?: string } = {}): Promise<string> {
		const result = await this.run(args, options);
		if (result.code !== 0) throw unreachable(`git ${args[0]} failed in ${this.path}`, result);
		return result.stdout;
	}

	/**
	 * Fetches `branch`'s tip from `url`, `depth` commits deep, and returns its object ID, or `undefined` when the branch
	 * does not exist. Each fetch writes a ref of its own and deletes it, so concurrent fetches never share one.
	 */
	async fetch(url: string, branch: string, deadlineMs: number, depth = 1): Promise<string | undefined> {
		const ref = `refs/melian/fetch/${randomUUID()}`;
		const started = Date.now();
		for (;;) {
			const left = deadlineMs - (Date.now() - started);
			if (left <= 0) throw unreachable(`fetching ${branch} from ${url} ran past its deadline`);
			const result = await this.run(
				[
					"fetch",
					"--quiet",
					"--no-tags",
					"--no-write-fetch-head",
					"--no-auto-gc",
					"--no-auto-maintenance",
					`--depth=${depth}`,
					url,
					`+refs/heads/${branch}:${ref}`,
				],
				{ deadlineMs: left },
			);
			if (result.timedOut) throw unreachable(`fetching ${branch} from ${url} ran past its deadline`);
			if (result.code === 0) break;
			if (/couldn't find remote ref/.test(result.stderr)) return undefined;
			if (!contention.test(result.stderr)) throw unreachable(`fetching ${branch} from ${url} failed`, result);
		}
		const tip = (await this.#succeed(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
		await this.#deleteRef(ref);
		return tip;
	}

	async #deleteRef(ref: string): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			const result = await this.run(["update-ref", "-d", ref]);
			if (result.code === 0) return;
			if (!contention.test(result.stderr) || attempt === 20)
				throw unreachable(`deleting ${ref} failed in ${this.path}`, result);
			await new Promise((done) => setTimeout(done, 10));
		}
	}

	/** Every file of `commit`'s tree, by its raw path. */
	async entries(commit: string): Promise<TreeEntry[]> {
		const result = await this.run(["ls-tree", "-r", "-z", "--full-tree", commit]);
		if (result.code !== 0) throw unreachable(`listing ${commit} failed in ${this.path}`, result);
		const entries: TreeEntry[] = [];
		const bytes = result.stdoutBytes;
		for (let start = 0; start < bytes.length; ) {
			const end = bytes.indexOf(0, start);
			const line = bytes.subarray(start, end === -1 ? bytes.length : end);
			start = end === -1 ? bytes.length : end + 1;
			const tab = line.indexOf(9);
			const [mode, type, oid] = line.subarray(0, tab).toString("latin1").split(" ") as [string, string, string];
			entries.push({ mode, type, oid, path: Buffer.from(line.subarray(tab + 1)) });
		}
		return entries;
	}

	/** The sizes of the blobs `oids` name. */
	async sizes(oids: readonly string[]): Promise<Map<string, number>> {
		const sizes = new Map<string, number>();
		if (oids.length === 0) return sizes;
		const output = await this.#succeed(["cat-file", "--batch-check=%(objectname) %(objectsize)"], {
			input: `${oids.join("\n")}\n`,
		});
		for (const line of output.split("\n")) {
			const [oid, size] = line.split(" ");
			if (oid !== undefined && size !== undefined && /^\d+$/.test(size)) sizes.set(oid, Number(size));
		}
		return sizes;
	}

	/** The bytes of the blobs `oids` name. */
	async blobs(oids: readonly string[]): Promise<Map<string, Buffer>> {
		const blobs = new Map<string, Buffer>();
		if (oids.length === 0) return blobs;
		const result = await this.run(["cat-file", "--batch"], { input: `${oids.join("\n")}\n` });
		if (result.code !== 0) throw unreachable(`reading blobs failed in ${this.path}`, result);
		const bytes = result.stdoutBytes;
		for (let at = 0; at < bytes.length; ) {
			const newline = bytes.indexOf(10, at);
			const [oid, type, size] = bytes.subarray(at, newline).toString("latin1").split(" ");
			if (type !== "blob" || oid === undefined || size === undefined)
				throw unreachable(`object ${oid} is no blob in ${this.path}`);
			const start = newline + 1;
			blobs.set(oid, Buffer.from(bytes.subarray(start, start + Number(size))));
			at = start + Number(size) + 1;
		}
		return blobs;
	}

	/** Builds one commit on `parent`, or a root commit, that applies `changes` to its tree, and returns its object ID. */
	async commit(parent: string | undefined, changes: readonly TreeChange[]): Promise<string> {
		const index = join(this.path, `melian-index-${randomUUID()}`);
		try {
			await this.#succeed(parent === undefined ? ["read-tree", "--empty"] : ["read-tree", parent], { index });
			const lines: string[] = [];
			for (const change of changes) {
				if (change.bytes === null) {
					lines.push(`0 ${"0".repeat(40)}\t${change.path}`);
					continue;
				}
				const oid = (
					await this.#succeed(["hash-object", "-w", "--no-filters", "--stdin"], { input: change.bytes })
				).trim();
				lines.push(`100644 ${oid}\t${change.path}`);
			}
			await this.#succeed(["update-index", "-z", "--index-info"], {
				input: lines.map((line) => `${line}\0`).join(""),
				index,
			});
			const tree = (await this.#succeed(["write-tree"], { index })).trim();
			const args = ["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", "melian: records"];
			return (await this.#succeed(args)).trim();
		} finally {
			await rm(index, { force: true });
			await rm(`${index}.lock`, { force: true });
		}
	}

	/**
	 * Pushes `commit` to `branch` at `url`, leased on `expected`, the tip it was built on, or on no branch at all. A push
	 * a newer tip refused is `stale`; one stopped at `deadlineMs` is `timedOut`, and may have landed.
	 */
	async push(
		url: string,
		branch: string,
		commit: string,
		expected: string | undefined,
		deadlineMs: number,
	): Promise<PushOutcome> {
		const ref = `refs/heads/${branch}`;
		const result = await this.run(
			["push", "--porcelain", "--quiet", `--force-with-lease=${ref}:${expected ?? ""}`, url, `${commit}:${ref}`],
			{ deadlineMs },
		);
		if (result.timedOut) return "timedOut";
		if (result.code === 0) return "landed";
		const refused = result.stdout.split("\n").find((line) => line.startsWith("!\t"));
		if (refused !== undefined && lostRace.test(refused)) return "stale";
		throw unreachable(`pushing to ${branch} at ${url} failed`, {
			...result,
			stderr: [refused?.split("\t").slice(2).join(" "), result.stderr].filter(Boolean).join("\n"),
		});
	}

	/** Whether `ancestor` is `descendant` or an ancestor of it, in the history this repository holds. */
	async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
		const result = await this.run(["merge-base", "--is-ancestor", ancestor, descendant]);
		if (result.code === 0) return true;
		if (result.code === 1) return false;
		throw unreachable(`comparing ${ancestor} with ${descendant} failed in ${this.path}`, result);
	}

	/** How many commits this repository holds in `commit`'s history, itself included. */
	async depth(commit: string): Promise<number> {
		return Number((await this.#succeed(["rev-list", "--count", commit])).trim());
	}
}

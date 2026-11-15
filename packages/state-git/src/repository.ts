import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type GitResult, git, RecordError } from "@melian-agent/core";
import { checkConfiguration, writeConfiguration } from "./configuration.ts";
import type { Deadline } from "./deadline.ts";

// Settings that would run a program, set on every command so that no configuration of the user's or this repository's
// turns them back on. The configuration check covers the keys a command line cannot clear, such as a credential helper
// or `include.path`. A bare repository runs no fsmonitor and has no submodules, the fetch passes `--no-auto-gc` and
// `--no-auto-maintenance`, and the plumbing that builds a commit never starts either, so those need no setting here.
const overrides = [
	// A hook, such as reference-transaction, would run as Melian on every ref this repository updates.
	"core.hooksPath=/dev/null",
	// A push signs when this asks, which runs `gpg.program`. commit-tree never reads `commit.gpgSign`.
	"push.gpgSign=false",
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

// Another process's ref update on this repository holds these locks for a moment.
const contention = /cannot lock ref|Unable to create '.*\.lock'/;

// A refusal because the branch moved: the client saw a newer tip than its lease, or the remote's ref moved, was created,
// or was locked by another push, between its advertisement and the update. Anything else, such as a hook that declined,
// is no race and no retry clears it.
const lostRace =
	/\t\[rejected\] \((stale info|fetch first|non-fast-forward|already exists)\)|\t\[remote rejected\] \((failed to update ref|cannot lock ref|incorrect old value|reference already exists)/;

// One entry of a commit's tree, as `ls-tree -r -z` gives it.
export type TreeEntry = { readonly mode: string; readonly type: string; readonly oid: string; readonly path: Buffer };

// A file a commit adds, by its bytes, or removes, by `null`.
export type TreeChange = { readonly path: string; readonly bytes: string | null };

// How a push ended: it landed, a newer tip refused it, or it ran past its deadline and may have landed.
export type PushOutcome = "landed" | "stale" | "timedOut";

function unreachable(message: string, result?: GitResult, cause?: unknown): RecordError {
	const said = result?.stderr.trim();
	return new RecordError("unreachable", said ? `${message}: ${said}` : message, { cause });
}

// The bare repository Melian keeps beside a clone, at `records.git` in its state directory, which holds fetches of the
// branch's tip and the commits Melian builds on them. Its configuration is Melian's alone, checked before every command.
export class RecordRepository {
	readonly path: string;

	private constructor(path: string) {
		this.path = path;
	}

	// Opens the repository at `given`, creating it with Melian's configuration when it is not there. The path is made
	// absolute, since git runs inside the repository and would read a relative one from there.
	static async open(given: string, deadline: Deadline): Promise<RecordRepository> {
		const path = resolve(given);
		const found = await lstat(path).catch((cause: unknown) => {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
				throw unreachable(`${path} cannot be read`, undefined, cause);
		});
		if (found === undefined) await RecordRepository.#create(path, deadline);
		else if (!found.isDirectory()) throw unreachable(`${path} is not a directory`);
		const repository = new RecordRepository(path);
		await checkConfiguration(path);
		// An earlier build fetched one commit deep, and a plain fetch keeps that history shallow, so a landed push could
		// read as lost.
		if ((await repository.#succeed(["rev-parse", "--is-shallow-repository"], deadline)).trim() !== "false")
			throw unreachable(
				`${path} holds a shallow history an earlier Melian fetched; delete it, and the next call fetches the whole branch`,
			);
		return repository;
	}

	// Built under a name of its own and renamed, so two processes opening at once never share a half-made repository.
	static async #create(path: string, deadline: Deadline): Promise<void> {
		const building = `${path}.${randomUUID()}`;
		try {
			await mkdir(dirname(path), { recursive: true });
			const left = deadline.left();
			if (left <= 0) throw unreachable(`${path} cannot be created within its deadline`);
			const made = await git(dirname(path), ["init", "--bare", "--quiet", building], {
				env: environment,
				deadlineMs: left,
			});
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

	async run(
		args: readonly string[],
		deadline: Deadline,
		options: { input?: string; index?: string; maxBytes?: number } = {},
	) {
		await checkConfiguration(this.path);
		const left = deadline.left();
		if (left <= 0) throw unreachable(`git ${args[0]} in ${this.path} ran past its deadline`);
		return git(this.path, ["--git-dir", this.path, ...overrides, ...args], {
			...(options.input === undefined ? {} : { input: options.input }),
			...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
			deadlineMs: left,
			env: { ...environment, ...(options.index === undefined ? {} : { GIT_INDEX_FILE: options.index }) },
		});
	}

	async #succeed(
		args: readonly string[],
		deadline: Deadline,
		options: { input?: string; index?: string } = {},
	): Promise<string> {
		const result = await this.run(args, deadline, options);
		if (result.code !== 0) throw unreachable(`git ${args[0]} failed in ${this.path}`, result);
		return result.stdout;
	}

	// Fetches `branch` from `url`, its whole history, and returns its tip's object ID, or `undefined` when the branch does
	// not exist. Each fetch writes a ref of its own and deletes it, so concurrent fetches never share one.
	async fetch(url: string, branch: string, deadline: Deadline): Promise<string | undefined> {
		const ref = `refs/melian/fetch/${randomUUID()}`;
		const result = await this.run(
			[
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-write-fetch-head",
				"--no-auto-gc",
				"--no-auto-maintenance",
				"--end-of-options",
				url,
				`+refs/heads/${branch}:${ref}`,
			],
			deadline,
		);
		if (result.timedOut) throw unreachable(`fetching ${branch} from ${url} ran past its deadline`);
		if (result.code !== 0) {
			if (/couldn't find remote ref/.test(result.stderr)) return undefined;
			throw unreachable(`fetching ${branch} from ${url} failed`, result);
		}
		let tip: string;
		try {
			tip = (await this.#succeed(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], deadline)).trim();
		} catch (cause) {
			// The read's failure is the one to report; a ref this cannot delete is a leftover, as a killed call's is.
			await this.#deleteRef(ref, deadline).catch(() => {});
			throw cause;
		}
		await this.#deleteRef(ref, deadline);
		await this.#keepLast(tip, deadline);
		return tip;
	}

	// Points `refs/melian/last` at the tip, so the next fetch tells the remote what this repository holds and receives
	// only what is new; with no ref, it is sent the whole history again. It is a hint: nothing reads it to answer a call,
	// so a lost update costs one larger fetch, and a held lock is given up.
	async #keepLast(tip: string, deadline: Deadline): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			const result = await this.run(["update-ref", "refs/melian/last", tip], deadline);
			if (result.code === 0 || attempt === 20) return;
			await deadline.sleep(10);
		}
	}

	async #deleteRef(ref: string, deadline: Deadline): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			const result = await this.run(["update-ref", "-d", ref], deadline);
			if (result.code === 0) return;
			if (!contention.test(result.stderr) || attempt === 20)
				throw unreachable(`deleting ${ref} failed in ${this.path}`, result);
			await deadline.sleep(10);
		}
	}

	// Every file of `commit`'s tree, by its raw path, or undefined when the listing runs past `maxBytes`.
	async entries(commit: string, deadline: Deadline, maxBytes: number): Promise<TreeEntry[] | undefined> {
		const result = await this.run(["ls-tree", "-r", "-z", "--full-tree", commit], deadline, { maxBytes });
		if (result.truncated) return undefined;
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

	// The sizes of the blobs `oids` name.
	async sizes(oids: readonly string[], deadline: Deadline): Promise<Map<string, number>> {
		const sizes = new Map<string, number>();
		if (oids.length === 0) return sizes;
		const output = await this.#succeed(["cat-file", "--batch-check=%(objectname) %(objectsize)"], deadline, {
			input: `${oids.join("\n")}\n`,
		});
		for (const line of output.split("\n")) {
			const [oid, size] = line.split(" ");
			if (oid !== undefined && size !== undefined && /^\d+$/.test(size)) sizes.set(oid, Number(size));
		}
		return sizes;
	}

	// The bytes of the blobs `sizes` names, read no further than the sizes it gives.
	async blobs(sizes: ReadonlyMap<string, number>, deadline: Deadline): Promise<Map<string, Buffer>> {
		const blobs = new Map<string, Buffer>();
		if (sizes.size === 0) return blobs;
		const oids = [...sizes.keys()];
		// `cat-file --batch` prints a header line, the blob's bytes and a newline for each.
		const maxBytes = [...sizes].reduce((sum, [oid, size]) => sum + `${oid} blob ${size}\n`.length + size + 1, 0);
		const result = await this.run(["cat-file", "--batch"], deadline, { input: `${oids.join("\n")}\n`, maxBytes });
		if (result.truncated) throw unreachable(`reading blobs in ${this.path} gave more bytes than their sizes`);
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

	// Builds one commit on `parent`, or a root commit, that applies `changes` to its tree, and returns its object ID.
	async commit(parent: string | undefined, changes: readonly TreeChange[], deadline: Deadline): Promise<string> {
		const index = join(this.path, `melian-index-${randomUUID()}`);
		try {
			await this.#succeed(parent === undefined ? ["read-tree", "--empty"] : ["read-tree", parent], deadline, {
				index,
			});
			const lines: string[] = [];
			for (const change of changes) {
				if (change.bytes === null) {
					lines.push(`0 ${"0".repeat(40)}\t${change.path}`);
					continue;
				}
				const oid = (
					await this.#succeed(["hash-object", "-w", "--no-filters", "--stdin"], deadline, {
						input: change.bytes,
					})
				).trim();
				lines.push(`100644 ${oid}\t${change.path}`);
			}
			await this.#succeed(["update-index", "-z", "--index-info"], deadline, {
				input: lines.map((line) => `${line}\0`).join(""),
				index,
			});
			const tree = (await this.#succeed(["write-tree"], deadline, { index })).trim();
			const args = ["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", "melian: records"];
			return (await this.#succeed(args, deadline)).trim();
		} finally {
			await rm(index, { force: true });
			await rm(`${index}.lock`, { force: true });
		}
	}

	// Pushes `commit` to `branch` at `url`, leased on `expected`, the tip it was built on, or on no branch at all. A push
	// a newer tip refused is `stale`; one stopped at `deadline` is `timedOut`, and may have landed.
	async push(
		url: string,
		branch: string,
		commit: string,
		expected: string | undefined,
		deadline: Deadline,
	): Promise<PushOutcome> {
		const ref = `refs/heads/${branch}`;
		const result = await this.run(
			[
				"push",
				"--porcelain",
				"--quiet",
				`--force-with-lease=${ref}:${expected ?? ""}`,
				"--end-of-options",
				url,
				`${commit}:${ref}`,
			],
			deadline,
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

	// Whether `ancestor` is `descendant` or an ancestor of it, in the history this repository holds.
	async isAncestor(ancestor: string, descendant: string, deadline: Deadline): Promise<boolean> {
		const result = await this.run(["merge-base", "--is-ancestor", ancestor, descendant], deadline);
		if (result.code === 0) return true;
		if (result.code === 1) return false;
		throw unreachable(`comparing ${ancestor} with ${descendant} failed in ${this.path}`, result);
	}
}

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, opendir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ChangesetError, type GitResult, git, ProcessTable, RecordError, stderrLimit } from "@melian-agent/core";
import { checkConfiguration, writeConfiguration } from "./configuration.ts";
import type { Deadline } from "./deadline.ts";
import { Owner, type Processes } from "./owner.ts";

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
	// A local writer's `refs/replace/<commit>` would make every read and commit see an object the remote never sent.
	GIT_NO_REPLACE_OBJECTS: "1",
	// So would `info/grafts` for a commit's parents, which the landed check reads; the setting above leaves it on. No file
	// can sit under `/dev/null`, and git warns on every command when the graft file exists, even empty.
	GIT_GRAFT_FILE: "/dev/null/none",
};

// Another process's ref update on this repository holds these locks for a moment.
const contention = /cannot lock ref|Unable to create '.*\.lock'/;

// A refusal because the branch moved: the client saw a newer tip than its lease, or the remote's ref moved, was created,
// or was locked by another push, between its advertisement and the update. Anything else, such as a hook that declined,
// is no race and no retry clears it.
const lostRace =
	/\t\[rejected\] \((stale info|fetch first|non-fast-forward|already exists)\)|\t\[remote rejected\] \((failed to update ref|cannot lock ref|incorrect old value|reference already exists)/;

/** The most leftovers one sweep lists, across the state directory, `records.git` and the fetch refs. */
export const sweepBound = 1_000;

/**
 * What a store's sweep did with the leftovers of calls that ended before they removed what they made: the temporary
 * indexes, half-made repositories and fetch refs whose owner had gone, which it removed; those whose owner it cannot
 * tell, which it kept; and those it found stale but could not remove. `unread` says why it swept nothing, when the
 * process table could not be read or did not list this process, and `unswept` counts the stale leftovers it left when the call's deadline ran out,
 * which the next open removes. `unlisted` says it could not list every leftover: a listing failed, and it removed
 * nothing, or no time was left to list the fetch refs, and it counted the stale leftovers it had listed as unswept.
 * `bounded` says it stopped listing at `sweepBound` leftovers, so more may wait for a later open.
 */
export type Sweep = {
	removed: string[];
	kept: string[];
	failed: string[];
	unread?: string;
	unswept?: number;
	unlisted?: true;
	bounded?: true;
};

// A leftover as the sweep lists it: its name, the owner its name records, whether it is the kind of thing the store
// makes under that name and this process's user owns it, and how to remove it.
type Leftover = { name: string; owner: Owner | undefined; fits: boolean; remove(): Promise<void> };

// One entry of a commit's tree, as `ls-tree -r -z` gives it.
export type TreeEntry = { readonly mode: string; readonly type: string; readonly oid: string; readonly path: Buffer };

// A file a commit adds, by its bytes, or removes, by `null`.
export type TreeChange = { readonly path: string; readonly bytes: string | null };

// How a push ended: it landed, a newer tip refused it, or Melian stopped git before it ended, at its deadline or
// past the standard error core's git keeps, and it may have landed.
export type PushOutcome = "landed" | "stale" | "stopped";

// A command that talks to the remote quotes none of git's text or the remote's: git prints a URL's query, a URL the
// user's configuration rewrote, and whatever the remote sends, any of which may carry a token. This says where to look.
function seeGit(branch: string): string {
	return `run \`git ls-remote origin refs/heads/${branch}\` in the clone to see git's own words`;
}

// The class a porcelain `!` line gives, in Melian's words: `[remote rejected]` is the remote's, `[rejected]` git's own.
function refusal(line: string): string {
	const flag = line.split("\t")[2] ?? "";
	if (flag.startsWith("[remote rejected]")) return "the remote rejected it";
	if (flag.startsWith("[rejected]")) return "git rejected it";
	return "git refused it";
}

// Core's git stopped a command that wrote more standard error than it keeps, and gave no result to read.
function overflowed(error: unknown): boolean {
	return error instanceof ChangesetError && error.code === "gitOutputTooLarge";
}

function unreachable(message: string, result?: GitResult, cause?: unknown): RecordError {
	const said = result?.stderr.trim();
	return new RecordError("unreachable", said ? `${message}: ${said}` : message, { cause });
}

// The names in `directory` that start with `prefix`, in name order, and whether more than `room` of them are there, in
// which case it lists only the first `room` the directory gives and stops.
async function namesIn(directory: string, prefix: string, room: number): Promise<{ names: string[]; more: boolean }> {
	const names: string[] = [];
	for await (const entry of await opendir(directory)) {
		if (!entry.name.startsWith(prefix)) continue;
		if (names.length === room) return { names: names.sort(), more: true };
		names.push(entry.name);
	}
	return { names: names.sort(), more: false };
}

// An entry another call removed after the listing reads as gone; any other failure fails the listing, so the sweep
// reports it rather than skipping an entry it could not inspect.
async function statIfThere(path: string) {
	return lstat(path).catch((cause: unknown) => {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
	});
}

// The bare repository Melian keeps beside a clone, at `records.git` in its state directory, which holds fetches of the
// branch's tip and the commits Melian builds on them. Its configuration is Melian's alone, checked before every command.
export class RecordRepository {
	readonly path: string;
	readonly #owner: Owner | undefined;

	private constructor(path: string, owner: Owner | undefined) {
		this.path = path;
		this.#owner = owner;
	}

	// Opens the repository at `given`, creating it with Melian's configuration when it is not there. The path is made
	// absolute, since git runs inside the repository and would read a relative one from there. What a call makes is
	// named after this process as `processes` lists it, so a later sweep can tell when its maker has gone.
	static async open(
		given: string,
		deadline: Deadline,
		processes: Processes = new ProcessTable(),
	): Promise<RecordRepository> {
		const path = resolve(given);
		let owner: Owner | undefined;
		try {
			owner = Owner.current(processes.list());
		} catch {
			// With no table to read, a call names what it makes by a UUID alone, which no sweep removes.
		}
		const found = await lstat(path).catch((cause: unknown) => {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
				throw unreachable(`${path} cannot be read`, undefined, cause);
		});
		if (found === undefined) await RecordRepository.#create(path, deadline, owner);
		else if (!found.isDirectory()) throw unreachable(`${path} is not a directory`);
		const repository = new RecordRepository(path, owner);
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
	static async #create(path: string, deadline: Deadline, owner: Owner | undefined): Promise<void> {
		const building = `${path}.${owner?.name() ?? randomUUID()}`;
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

	#name(): string {
		return this.#owner?.name() ?? randomUUID();
	}

	// Removes what a call left when its owner has gone: a half-made repository beside this one, a temporary index or its
	// lock, or a fetch ref. It removes only what has the kind the store makes under that name, and follows no link.
	async sweep(deadline: Deadline, processes: Processes): Promise<Sweep> {
		// Listed before the table is read: a call still running when it is read made only what it is listed beside, and a
		// call that starts later made nothing the listing holds.
		// No failure inside the sweep fails the open: a listing that fails removes nothing and reports `unlisted`.
		const { leftovers, unlisted, bounded } = await this.#leftovers(deadline).catch(() => ({
			leftovers: [],
			unlisted: true,
			bounded: false,
		}));
		const sweep: Sweep = {
			removed: [],
			kept: [],
			failed: [],
			...(unlisted ? { unlisted: true } : {}),
			...(bounded ? { bounded: true } : {}),
		};
		let table: ReturnType<Processes["list"]> | undefined;
		try {
			table = processes.list();
			// A table that parses to nothing, or was read from another pid namespace, would read every pid as gone.
			if (!Owner.lists(table)) {
				sweep.unread = "it does not list this process";
				table = undefined;
			}
		} catch (error) {
			sweep.unread = error instanceof Error ? error.message : String(error);
		}
		for (const leftover of leftovers) {
			if (!leftover.fits || leftover.owner === undefined || !leftover.owner.isHere()) sweep.kept.push(leftover.name);
			else if (table === undefined) sweep.kept.push(leftover.name);
			else if (!leftover.owner.isGone(table)) sweep.kept.push(leftover.name);
			else if (unlisted || deadline.left() <= 0) sweep.unswept = (sweep.unswept ?? 0) + 1;
			else
				try {
					await leftover.remove();
					sweep.removed.push(leftover.name);
				} catch {
					sweep.failed.push(leftover.name);
				}
		}
		return sweep;
	}

	async #leftovers(deadline: Deadline): Promise<{ leftovers: Leftover[]; unlisted: boolean; bounded: boolean }> {
		const leftovers: Leftover[] = [];
		// What the sweep lists is bounded, so a directory holding many leftovers costs one open a bounded time and memory.
		let room = sweepBound;
		// A table can hide another user's processes, as `/proc` mounted with `hidepid` does, so only this user's own
		// entries are swept. Where the process has no user ID, as on Windows, nothing is.
		const uid = process.getuid?.();
		const ours = (found: Stats) => uid !== undefined && found.uid === uid;
		const state = dirname(this.path);
		const folder = `${basename(this.path)}.`;
		const folders = await namesIn(state, folder, room);
		room -= folders.names.length;
		for (const name of folders.names) {
			const found = await statIfThere(join(state, name));
			if (found === undefined) continue;
			leftovers.push({
				name,
				owner: Owner.parse(name.slice(folder.length)),
				fits: found.isDirectory() && ours(found),
				remove: () => rm(join(state, name), { recursive: true, force: true }),
			});
		}
		const index = "melian-index-";
		const indexes = await namesIn(this.path, index, room);
		room -= indexes.names.length;
		for (const name of indexes.names) {
			const found = await statIfThere(join(this.path, name));
			if (found === undefined) continue;
			leftovers.push({
				name: `${basename(this.path)}/${name}`,
				owner: Owner.parse(name.slice(index.length).replace(/\.lock$/, "")),
				fits: found.isFile() && ours(found),
				remove: () => rm(join(this.path, name), { force: true }),
			});
		}
		// A listing with no time left is not started, so the sweep is unlisted rather than past its deadline.
		const bounded = folders.more || indexes.more;
		if (deadline.left() <= 0) return { leftovers, unlisted: true, bounded };
		const fetch = "refs/melian/fetch/";
		// One more than there is room for says whether the refs run past the bound.
		const listed = await this.#succeed(
			["for-each-ref", "--sort=refname", "--format=%(refname)", `--count=${room + 1}`, fetch],
			deadline,
		);
		const refs = listed.split("\n").filter((line) => line !== "");
		for (const ref of refs.slice(0, room)) {
			// A packed ref has no file of its own to say who owns it, so it is kept.
			const found = await statIfThere(join(this.path, ref));
			leftovers.push({
				name: ref,
				owner: Owner.parse(ref.slice(fetch.length)),
				fits: found?.isFile() === true && ours(found),
				remove: () => this.#deleteRef(ref, deadline),
			});
		}
		return { leftovers, unlisted: false, bounded: bounded || refs.length > room };
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
		}).catch((cause: unknown) => {
			if (!overflowed(cause)) throw cause;
			throw unreachable(
				`git ${args[0]} in ${this.path} wrote more than ${stderrLimit} bytes to standard error`,
				undefined,
				cause,
			);
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
		const ref = `refs/melian/fetch/${this.#name()}`;
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
		).catch((cause: unknown) => {
			if (!(cause instanceof RecordError && overflowed(cause.cause))) throw cause;
			throw new RecordError(
				"unreachable",
				`fetching ${branch} from the clone's origin wrote more than ${stderrLimit} bytes to standard error; ${seeGit(branch)}`,
			);
		});
		if (result.timedOut) throw unreachable(`fetching ${branch} from the clone's origin ran past its deadline`);
		if (result.code !== 0) {
			if (/couldn't find remote ref/.test(result.stderr)) return undefined;
			throw new RecordError(
				"unreachable",
				`fetching ${branch} from the clone's origin failed, git exit ${result.code}; ${seeGit(branch)}`,
			);
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
			const result = await this.run(["update-ref", "-d", "--no-deref", ref], deadline);
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
		const index = join(this.path, `melian-index-${this.#name()}`);
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
	// a newer tip refused is `stale`; one Melian stopped before git ended is `stopped`, and may have landed.
	async push(
		url: string,
		branch: string,
		commit: string,
		expected: string | undefined,
		deadline: Deadline,
	): Promise<PushOutcome> {
		const ref = `refs/heads/${branch}`;
		let result: GitResult;
		try {
			result = await this.run(
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
		} catch (cause) {
			// A remote's hook can write after the ref is updated, so a push stopped for its standard error may have landed.
			if (cause instanceof RecordError && overflowed(cause.cause)) return "stopped";
			throw cause;
		}
		if (result.timedOut) return "stopped";
		if (result.code === 0) return "landed";
		const refused = result.stdout.split("\n").find((line) => line.startsWith("!\t"));
		if (refused !== undefined && lostRace.test(refused)) return "stale";
		// With no refusal of the ref, git may have stopped after the remote updated it, such as when the connection drops.
		const ended =
			refused === undefined
				? `failed, git exit ${result.code}, and may have landed; repeat the call, or`
				: `was refused: ${refusal(refused)}, git exit ${result.code};`;
		throw new RecordError("unreachable", `pushing to ${branch} on the clone's origin ${ended} ${seeGit(branch)}`);
	}

	// Whether `ancestor` is `descendant` or an ancestor of it, in the history this repository holds.
	async isAncestor(ancestor: string, descendant: string, deadline: Deadline): Promise<boolean> {
		const result = await this.run(["merge-base", "--is-ancestor", ancestor, descendant], deadline);
		if (result.code === 0) return true;
		if (result.code === 1) return false;
		throw unreachable(`comparing ${ancestor} with ${descendant} failed in ${this.path}`, result);
	}
}

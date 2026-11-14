import { execFile } from "node:child_process";
import { lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { running } from "./cache-scratch.ts";

const day = 86_400_000;
export const graphAgeDays = 7;
export const unreadableGraphAgeDays = 1;
export const mutationAgeDays = 14;
const entryLimit = 1024 * 1024;
const key = /^[0-9a-f]{64}$/;

/** What kind of rebuildable cache a removal takes, as the store retention decision names it. */
export type PruneKind = "graph" | "unreadable graph" | "orphan coverage" | "mutation partition";

/** One removal: the paths it takes, relative to the state directory, and the bytes they hold. */
export type PruneEntry = { kind: PruneKind; paths: string[]; bytes: number };

/** A static run that holds a worktree lock, so prune removes nothing beside it. */
export type LiveRun = { pid: number; worktree: string };

/** Git could not answer, or the state directory could not be read, so prune removes nothing. */
export class StorePruneError extends Error {
	readonly code: "gitFailed" | "unreadable";
	constructor(code: StorePruneError["code"], message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StorePruneError";
		this.code = code;
	}
}

type Worktrees = { heads: string[]; live: LiveRun[] };

function git(repoRoot: string, env: NodeJS.ProcessEnv, args: readonly string[], input?: string): Promise<string> {
	return new Promise((done, fail) => {
		const child = execFile(
			"git",
			["-C", repoRoot, ...args],
			{ env, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
			(error, stdout, stderr) =>
				error === null
					? done(stdout)
					: fail(new StorePruneError("gitFailed", `git ${args[0]} failed: ${stderr.trim() || error.message}`)),
		);
		child.stdin!.end(input);
	});
}

async function worktrees(repoRoot: string, env: NodeJS.ProcessEnv): Promise<Worktrees> {
	const output = await git(repoRoot, env, ["worktree", "list", "--porcelain", "-z"]);
	const heads = [...output.matchAll(/\0HEAD ([0-9a-f]+)/g)].map((match) => match[1]!);
	const live: LiveRun[] = [];
	for (const record of output.split("\0\0")) {
		const pid = Number(/\0locked melian-static pid (\d+)(?:\0|$)/.exec(record)?.[1]);
		if (running(pid)) live.push({ pid, worktree: record.slice("worktree ".length, record.indexOf("\0")) });
	}
	return { heads, live };
}

// Refs under refs/melian/pull/ are left out on purpose: they outlive a merge. A line git cannot resolve names no tree.
async function liveTrees(repoRoot: string, env: NodeJS.ProcessEnv, heads: readonly string[]): Promise<Set<string>> {
	const refs = await git(repoRoot, env, [
		"for-each-ref",
		"--format=%(objectname)^{tree}",
		"refs/heads",
		"refs/remotes",
	]);
	const commits = refs + heads.map((head) => `${head}^{tree}\n`).join("");
	return new Set((await git(repoRoot, env, ["cat-file", "--batch-check=%(objectname)"], commits)).split("\n"));
}

type Node = { name: string; path: string; directory: boolean; link: boolean };

async function children(path: string): Promise<Node[]> {
	try {
		if (!(await lstat(path)).isDirectory()) return [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return (await readdir(path, { withFileTypes: true }))
		.sort((a, b) => (a.name < b.name ? -1 : 1))
		.map((entry) => ({
			name: entry.name,
			path: join(path, entry.name),
			directory: entry.isDirectory(),
			link: entry.isSymbolicLink(),
		}));
}

// The bytes a tree holds and its newest modification, never following a link.
async function measure(path: string): Promise<{ bytes: number; newest: number }> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: 0, newest: 0 };
		throw error;
	}
	let bytes = info.isDirectory() ? 0 : info.size;
	let newest = info.mtimeMs;
	if (info.isDirectory())
		for (const child of await readdir(path)) {
			const inner = await measure(join(path, child));
			bytes += inner.bytes;
			newest = Math.max(newest, inner.newest);
		}
	return { bytes, newest };
}

// A scratch name CacheScratch sweeps, which prune leaves to it.
function scratch(name: string): boolean {
	return name.startsWith(".") || /\.[0-9a-f-]{36}\.tmp$/.test(name);
}

// The tree and creation time a graph's entry records, "unreadable" when every reader of this format treats it as a miss,
// or "unknown" for a format a later build may read.
async function graphEntry(
	directory: string,
	name: string,
): Promise<{ tree: string; created: number } | "unreadable" | "unknown"> {
	let text: string;
	try {
		const path = join(directory, "entry.json");
		const info = await lstat(path);
		if (!info.isFile() || info.size > entryLimit) return "unreadable";
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unreadable";
		throw error;
	}
	let entry: { format_version?: unknown; key?: unknown; parts?: { tree?: unknown }; created?: unknown };
	try {
		entry = JSON.parse(text);
	} catch {
		return "unreadable";
	}
	if (typeof entry !== "object" || entry === null) return "unreadable";
	if (entry.format_version !== 1) return "unknown";
	const tree = entry.parts?.tree;
	const created = typeof entry.created === "string" ? Date.parse(entry.created) : Number.NaN;
	if (entry.key !== name || typeof tree !== "string" || !Number.isFinite(created)) return "unreadable";
	return { tree, created };
}

/** A plan to remove one state directory's rebuildable cache, read without changing anything. */
export class StorePrune {
	readonly root: string;
	readonly entries: readonly PruneEntry[];
	/** Names, relative to the state directory, that prune does not recognise and so keeps. */
	readonly kept: readonly string[];
	/** The changeset files prune always keeps: each `.sqlite` file with its `-wal` and `-shm`. */
	readonly changesets: { files: number; bytes: number };
	/** Live static runs; while any holds a lock, apply removes nothing. */
	readonly live: readonly LiveRun[];
	readonly #repoRoot: string;
	readonly #env: NodeJS.ProcessEnv;
	readonly #now: number;
	private constructor(
		fields: Pick<StorePrune, "root" | "entries" | "kept" | "changesets" | "live">,
		repoRoot: string,
		env: NodeJS.ProcessEnv,
		now: number,
	) {
		this.root = fields.root;
		this.entries = fields.entries;
		this.kept = fields.kept;
		this.changesets = fields.changesets;
		this.live = fields.live;
		this.#repoRoot = repoRoot;
		this.#env = env;
		this.#now = now;
	}

	/** Reads the state directory and git, and plans what the retention decision allows prune to remove. */
	static async open(
		repoRoot: string,
		options: { root: string; now?: number; env?: NodeJS.ProcessEnv },
	): Promise<StorePrune> {
		const root = resolve(options.root);
		const now = options.now ?? Date.now();
		const env = Object.fromEntries(
			Object.entries(options.env ?? process.env).filter(([name]) => !name.startsWith("GIT_")),
		);
		const { heads, live } = await worktrees(repoRoot, env);
		const trees = await liveTrees(repoRoot, env, heads);
		const entries: PruneEntry[] = [];
		const kept: string[] = [];
		const changesets = { files: 0, bytes: 0 };
		const relative = (path: string) => path.slice(root.length + 1);
		const add = async (kind: PruneKind, paths: string[]) => {
			let bytes = 0;
			for (const path of paths) bytes += (await measure(join(root, path))).bytes;
			entries.push({ kind, paths, bytes });
		};
		try {
			for (const node of await children(root)) {
				if (node.name.includes(".sqlite") && !node.link) {
					changesets.files += node.name.endsWith(".sqlite") ? 1 : 0;
					changesets.bytes += (await measure(node.path)).bytes;
				} else if (
					node.link ||
					!node.directory ||
					!["graphs", "coverage", "mutation", "tools", "scripted"].includes(node.name)
				)
					kept.push(node.name);
			}
			const graphs = new Set<string>();
			for (const node of await children(join(root, "graphs"))) {
				if (scratch(node.name)) continue;
				if (node.link || !node.directory || !key.test(node.name)) {
					kept.push(relative(node.path));
					continue;
				}
				const entry = await graphEntry(node.path, node.name);
				if (entry === "unknown") kept.push(relative(node.path));
				if (entry === "unreadable") {
					if (now - (await lstat(node.path)).mtimeMs > unreadableGraphAgeDays * day)
						await add("unreadable graph", [`graphs/${node.name}`]);
					else graphs.add(node.name);
				} else if (entry !== "unknown" && now - entry.created > graphAgeDays * day && !trees.has(entry.tree))
					await add("graph", [`graphs/${node.name}`, `coverage/${node.name}`]);
				else graphs.add(node.name);
			}
			for (const node of await children(join(root, "coverage"))) {
				if (scratch(node.name)) continue;
				if (node.link || !node.directory || !key.test(node.name)) kept.push(relative(node.path));
				else if (!graphs.has(node.name) && !entries.some((entry) => entry.paths.includes(`coverage/${node.name}`)))
					await add("orphan coverage", [`coverage/${node.name}`]);
			}
			for (const node of await children(join(root, "mutation"))) {
				if (scratch(node.name)) continue;
				if (node.link || !node.directory || !key.test(node.name)) kept.push(relative(node.path));
				else if (now - (await measure(node.path)).newest > mutationAgeDays * day)
					await add("mutation partition", [`mutation/${node.name}`]);
			}
		} catch (error) {
			throw new StorePruneError(
				"unreadable",
				`Melian cannot read its state directory at ${root}: ${(error as Error).message}`,
				{
					cause: error,
				},
			);
		}
		return new StorePrune({ root, entries, kept, changesets, live }, repoRoot, env, now);
	}

	/**
	 * Removes every planned entry, stopping at the first live static run it reads before a removal. Refs and graph entries
	 * are not read again, so a race costs a rebuild; that holds only while every entry is rebuildable cache. A path goes
	 * by a `.prune-<pid>-` rename beside it, so a crashed prune leaves only scratch for `CacheScratch` to sweep.
	 */
	async apply(): Promise<{ removed: PruneEntry[]; live: LiveRun[] }> {
		const removed: PruneEntry[] = [];
		if (this.live.length > 0) return { removed, live: [...this.live] };
		const linked = (path: string) =>
			lstat(path).then(
				(info) => info.isSymbolicLink(),
				() => false,
			);
		for (const entry of this.entries) {
			const { live } = await worktrees(this.#repoRoot, this.#env);
			if (live.length > 0) return { removed, live };
			if (entry.kind === "mutation partition") {
				const { newest } = await measure(join(this.root, entry.paths[0] ?? ""));
				if (this.#now - newest <= mutationAgeDays * day) continue;
			}
			const sources = entry.paths.map((path) => join(this.root, path));
			// A folder swapped for a link since the plan would carry the rename out of the state directory.
			let swapped = await linked(this.root);
			for (const source of sources) swapped ||= await linked(dirname(source));
			if (swapped) continue;
			for (const source of sources) {
				const moved = join(dirname(source), `.prune-${process.pid}-${crypto.randomUUID()}`);
				try {
					await rename(source, moved);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				await rm(moved, { recursive: true, force: true });
			}
			removed.push(entry);
		}
		return { removed, live: [] };
	}
}

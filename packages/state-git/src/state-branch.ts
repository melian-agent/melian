import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitFailure, gitOutput, gitOutputBytes } from "@melian-agent/core";
import { type Lease, StateBranchError, StateIndex } from "./state-index.ts";

const branch = "refs/heads/melian/state";
const indexFile = "index.json";
const changesetsTree = "changesets";
// Pi's JSONL storage writes exactly these: its main log and one sidecar per document and task.
const storageFile = /^(?:main|(?:doc|task)-(?:0|[1-9]\d*))\.jsonl$/;
const changesetName = /^[a-z0-9][a-z0-9-]{0,63}$/;
const attemptsLimit = 3;
const defaultLeaseMs = 2 * 60 * 60 * 1000;
const takeoverMs = 10 * 1000;
// Git records who pushed the branch; the commits themselves need only some identity.
const identity = {
	GIT_AUTHOR_NAME: "Melian state",
	GIT_AUTHOR_EMAIL: "state@melian.invalid",
	GIT_COMMITTER_NAME: "Melian state",
	GIT_COMMITTER_EMAIL: "state@melian.invalid",
};

/** Where a state branch lives, where this clone keeps its copies of changesets, and who this clone is. */
export interface StateBranchOptions {
	/** A clone of the repository; its object database holds what the branch is built from. */
	readonly repoRoot: string;
	/** The remote, by name or URL, that holds `melian/state`. */
	readonly remote: string;
	/** The directory holding this clone's copy of each changeset's storage. */
	readonly directory: string;
	/** This clone's identity, so a run in the same clone may take over a lease a crashed run left. */
	readonly holder: string;
	readonly now?: () => number;
	/** How long a lease stays live after it is taken. */
	readonly leaseMs?: number;
}

/** Another run holds the changeset's lease, so this one must not write it. */
export class LeaseHeld extends Error {
	readonly code = "leaseHeld";
	readonly lease: Lease;

	constructor(changeset: string, lease: Lease) {
		super(
			`another run holds ${changeset} on the state branch: run ${lease.run} in clone ${lease.holder}, since ${lease.heartbeat}; wait for it to finish, or for its lease to expire`,
		);
		this.name = "LeaseHeld";
		this.lease = lease;
	}
}

/** Another melian process in this clone is working on the changeset, so this one must not open its copy. */
export class CopyInUse extends Error {
	readonly code = "copyInUse";

	constructor(changeset: string) {
		super(`another melian process in this clone is working on ${changeset}; wait for it to finish`);
		this.name = "CopyInUse";
	}
}

// One process's hold on this clone's copy of a changeset: a Unix socket it listens on while it works. The kernel
// frees it when the process dies, and a stopped or stalled process keeps it, so no clock guesses who is alive. A
// socket file nobody listens on is a crashed process's; the takeover runs under an exclusive file, so two processes
// that both find it stale cannot both unlink a fresh one.
class CopyLock {
	readonly #server: Server;

	private constructor(server: Server) {
		this.#server = server;
	}

	static async take(directory: string, changeset: string, run: string): Promise<CopyLock> {
		// A socket's path is limited to about a hundred bytes, so it lives in the temporary directory, named by a hash.
		const name = createHash("sha256").update(`${directory}\0${changeset}`).digest("hex").slice(0, 16);
		const path = join(tmpdir(), `melian-${name}.sock`);
		for (let attempt = 0; attempt < 3; attempt++) {
			const server = await listen(path);
			if (server !== undefined) return new CopyLock(server);
			if (await answers(path)) throw new CopyInUse(changeset);
			const takeover = `${path}.take`;
			const took = await writeFile(takeover, `${run}\n`, { flag: "wx" }).then(
				() => true,
				async (error: NodeJS.ErrnoException) => {
					if (error.code !== "EEXIST") throw error;
					// A takeover is a few system calls; one ten seconds old belongs to a process that died inside it.
					const age = await stat(takeover).then(
						(info) => Date.now() - info.mtimeMs,
						() => 0,
					);
					if (age > takeoverMs) await rm(takeover, { force: true });
					return false;
				},
			);
			if (!took) continue;
			try {
				if (!(await answers(path))) await rm(path, { force: true });
			} finally {
				await rm(takeover, { force: true });
			}
		}
		throw new CopyInUse(changeset);
	}

	release(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.#server.listening) resolve();
			else this.#server.close(() => resolve());
		});
	}
}

// Listens on the socket, or answers undefined when its file already exists.
function listen(path: string): Promise<Server | undefined> {
	return new Promise((resolve, reject) => {
		const server = createServer((socket) => socket.destroy());
		server.once("error", (error: NodeJS.ErrnoException) =>
			error.code === "EADDRINUSE" ? resolve(undefined) : reject(error),
		);
		server.listen(path, () => {
			server.unref();
			resolve(server);
		});
	});
}

// Whether a live process listens on the socket.
function answers(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

/** What a push did: stored the changeset on the branch, or was refused because the branch moved under it. */
export type PushResult =
	| { readonly kind: "pushed"; readonly commit: string }
	| { readonly kind: "refused"; readonly reason: string };

interface Entry {
	readonly mode: string;
	readonly type: string;
	readonly sha: string;
	readonly name: string;
}

function entries(listing: Buffer): Entry[] {
	return listing
		.toString("utf8")
		.split("\0")
		.filter((line) => line !== "")
		.map((line) => {
			const tab = line.indexOf("\t");
			const [mode, type, sha] = line.slice(0, tab).split(" ") as [string, string, string];
			return { mode, type, sha, name: line.slice(tab + 1) };
		});
}

const mktreeLine = (entry: Entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.name}\0`;

/**
 * The `melian/state` branch of a remote, which carries each changeset's Pi JSONL storage in its own directory beside
 * an index of leases. This clone keeps a copy of each changeset it works on; the branch decides whose copy stands.
 */
export class StateBranch {
	readonly #options: StateBranchOptions;
	readonly #run = randomUUID();

	constructor(options: StateBranchOptions) {
		this.#options = options;
	}

	get run(): string {
		return this.#run;
	}

	/**
	 * Takes the changeset's lease, refusing with `CopyInUse` while another process in this clone works on it and with
	 * `LeaseHeld` while another clone's run holds a live lease, and leaves this clone's copy as the branch has it. A copy
	 * the branch has moved past, because another run pushed since this clone last did, is set aside and replaced by the
	 * branch's. Close the checkout when the work is done, pushed or not.
	 */
	async checkout(changeset: string): Promise<StateCheckout> {
		if (!changesetName.test(changeset))
			throw new StateBranchError("invalidBranch", `"${changeset}" is not a changeset name`);
		const lock = await CopyLock.take(this.#options.directory, changeset, this.#run);
		try {
			return await this.#checkout(changeset, lock);
		} catch (error) {
			await lock.release();
			throw error;
		}
	}

	async #checkout(changeset: string, lock: CopyLock): Promise<StateCheckout> {
		// This clone's lock is held, so a live lease of this clone's is one a crashed run left.
		const { stored } = await this.#withRetry(async (index) => {
			const held = index.lease(changeset);
			if (held !== undefined && held.holder !== this.#options.holder && this.#live(held))
				throw new LeaseHeld(changeset, held);
			const lease = {
				run: this.#run,
				holder: this.#options.holder,
				heartbeat: this.#now(),
				attempts: (held?.attempts ?? 0) + 1,
			};
			return { index: index.leased(changeset, lease) };
		});
		return StateCheckout.restore(this, changeset, stored(changeset), lock);
	}

	/** @internal */
	async push(changeset: string, synced: string, tree: () => Promise<string>): Promise<PushResult> {
		try {
			const { tip } = await this.#withRetry(async (index, stored) => {
				const held = index.lease(changeset);
				if (held?.run !== this.#run)
					throw new Refusal("another run took the changeset's lease after this one's expired");
				if ((stored(changeset) ?? "none") !== synced)
					throw new Refusal("another run pushed the changeset since this one fetched it");
				return { index: index.released(changeset), tree: { changeset, sha: await tree() } };
			});
			return { kind: "pushed", commit: tip };
		} catch (error) {
			if (error instanceof Refusal) return { kind: "refused", reason: error.message };
			throw error;
		}
	}

	/** @internal Writes the changeset's directory into the clone's object database and names its tree. */
	async snapshot(directory: string): Promise<string> {
		const found = await readdir(directory, { withFileTypes: true });
		const stray = found.find((entry) => !entry.isFile() || !storageFile.test(entry.name));
		if (stray !== undefined)
			throw new StateBranchError(
				"invalidCopy",
				`this clone's copy of ${directory.split("/").at(-1)} holds ${JSON.stringify(stray.name)}, which Pi's storage never writes, so Melian will not push part of it`,
			);
		const names = found.map((entry) => entry.name).sort();
		const paths = names.map((name) => join(directory, name));
		const shas =
			names.length === 0 ? [] : (await this.#git(["hash-object", "-w", "--", ...paths])).trim().split("\n");
		const tree = names.map((name, i) => mktreeLine({ mode: "100644", type: "blob", sha: shas[i]!, name })).join("");
		return (await this.#git(["mktree", "-z"], tree)).trim();
	}

	/** @internal Writes a tree of the branch into a fresh directory, refusing anything Pi's storage would not write. */
	async materialize(tree: string, directory: string): Promise<void> {
		const files = entries(await gitOutputBytes(this.#options.repoRoot, ["ls-tree", "-z", tree]));
		const stray = files.find(
			(entry) => entry.type !== "blob" || entry.mode !== "100644" || !storageFile.test(entry.name),
		);
		if (stray !== undefined)
			throw new StateBranchError(
				"invalidBranch",
				`the state branch holds ${JSON.stringify(stray.name)} in ${directory.split("/").at(-1)}, which Melian never writes`,
			);
		await mkdir(directory, { recursive: true });
		for (const entry of files)
			await writeFile(
				join(directory, entry.name),
				await gitOutputBytes(this.#options.repoRoot, ["cat-file", "blob", entry.sha]),
			);
	}

	get directory(): string {
		return this.#options.directory;
	}

	#now(): string {
		return new Date((this.#options.now ?? Date.now)()).toISOString();
	}

	#live(lease: Lease): boolean {
		return (
			Date.parse(lease.heartbeat) + (this.#options.leaseMs ?? defaultLeaseMs) > (this.#options.now ?? Date.now)()
		);
	}

	async #git(args: readonly string[], input?: string): Promise<string> {
		const result = await git(this.#options.repoRoot, args, {
			...(input === undefined ? {} : { input }),
			env: identity,
		});
		if (result.code !== 0) throw gitFailure(args, result);
		return result.stdout;
	}

	// Fetches the branch, lets `change` decide the next index and tree, and pushes them with a lease on the tip it
	// fetched. A push the branch refused because it moved is tried again from a fresh fetch, so a run on another
	// changeset never blocks this one; `change` sees the new tip each time and decides again.
	async #withRetry(
		change: (
			index: StateIndex,
			stored: (changeset: string) => string | undefined,
		) => Promise<{ index: StateIndex; tree?: { changeset: string; sha: string } }>,
	): Promise<{ tip: string; stored: (changeset: string) => string | undefined }> {
		for (let attempt = 1; ; attempt++) {
			const tip = await this.#fetch();
			const { index, changesets } = await this.#read(tip);
			const stored = (id: string) => changesets.get(id)?.sha;
			const next = await change(index, stored);
			const commit = await this.#compose(tip, next.index, changesets, next.tree);
			if (await this.#push(commit, tip)) {
				const after = new Map(changesets);
				if (next.tree !== undefined)
					after.set(next.tree.changeset, {
						mode: "040000",
						type: "tree",
						sha: next.tree.sha,
						name: next.tree.changeset,
					});
				return { tip: commit, stored: (id) => after.get(id)?.sha };
			}
			if (attempt === attemptsLimit)
				throw new StateBranchError("pushFailed", `the state branch moved under ${attemptsLimit} pushes in a row`);
		}
	}

	async #fetch(): Promise<string | undefined> {
		// A ref of this run's own, and no FETCH_HEAD, so runs on other changesets in this clone never contend for one.
		const fetched = `refs/melian/state/${this.#run}`;
		const args = [
			"fetch",
			"--quiet",
			"--no-tags",
			"--no-write-fetch-head",
			this.#options.remote,
			`+${branch}:${fetched}`,
		];
		const result = await git(this.#options.repoRoot, args);
		if (result.code !== 0) {
			if (/couldn't find remote ref/i.test(result.stderr)) return undefined;
			throw new StateBranchError("fetchFailed", `git fetch of melian/state failed: ${result.stderr.trim()}`);
		}
		const tip = (await gitOutput(this.#options.repoRoot, ["rev-parse", "--verify", `${fetched}^{commit}`])).trim();
		await gitOutput(this.#options.repoRoot, ["update-ref", "-d", fetched]);
		return tip;
	}

	async #read(tip: string | undefined): Promise<{ index: StateIndex; changesets: Map<string, Entry> }> {
		if (tip === undefined) return { index: StateIndex.empty(), changesets: new Map() };
		// A branch this build cannot read whole is refused, never read as empty: the next push would delete the rest.
		const top = entries(await gitOutputBytes(this.#options.repoRoot, ["ls-tree", "-z", tip]));
		const indexEntry = top.find((entry) => entry.name === indexFile);
		const treeEntry = top.find((entry) => entry.name === changesetsTree);
		if (
			top.length !== 2 ||
			indexEntry?.mode !== "100644" ||
			indexEntry.type !== "blob" ||
			treeEntry?.mode !== "040000" ||
			treeEntry.type !== "tree"
		)
			throw new StateBranchError(
				"invalidBranch",
				`the state branch's root holds ${JSON.stringify(top.map((entry) => `${entry.type} ${entry.name}`))}, where this build reads only the blob index.json and the tree changesets`,
			);
		const index = StateIndex.parse(await gitOutput(this.#options.repoRoot, ["cat-file", "blob", indexEntry.sha]));
		const changesets = new Map<string, Entry>();
		for (const entry of entries(await gitOutputBytes(this.#options.repoRoot, ["ls-tree", "-z", treeEntry.sha]))) {
			if (entry.mode !== "040000" || entry.type !== "tree" || !changesetName.test(entry.name))
				throw new StateBranchError(
					"invalidBranch",
					`the state branch's changesets hold the ${entry.type} ${JSON.stringify(entry.name)}, which is no changeset`,
				);
			changesets.set(entry.name, entry);
		}
		return { index, changesets };
	}

	async #compose(
		tip: string | undefined,
		index: StateIndex,
		changesets: ReadonlyMap<string, Entry>,
		tree: { changeset: string; sha: string } | undefined,
	): Promise<string> {
		const all = new Map(changesets);
		if (tree !== undefined)
			all.set(tree.changeset, { mode: "040000", type: "tree", sha: tree.sha, name: tree.changeset });
		const changesetsSha = (await this.#git(["mktree", "-z"], [...all.values()].map(mktreeLine).join(""))).trim();
		const indexSha = (
			await this.#git(["hash-object", "-w", "--stdin"], `${JSON.stringify(index, null, "\t")}\n`)
		).trim();
		const root = (
			await this.#git(
				["mktree", "-z"],
				[
					{ mode: "100644", type: "blob", sha: indexSha, name: indexFile },
					{ mode: "040000", type: "tree", sha: changesetsSha, name: changesetsTree },
				]
					.map(mktreeLine)
					.join(""),
			)
		).trim();
		return (
			await this.#git(["commit-tree", root, ...(tip === undefined ? [] : ["-p", tip]), "-m", `melian: ${this.#run}`])
		).trim();
	}

	// True when the remote took the commit; false when it refused because the branch is no longer at `tip`.
	async #push(commit: string, tip: string | undefined): Promise<boolean> {
		const args = [
			"push",
			"--porcelain",
			this.#options.remote,
			`${commit}:${branch}`,
			`--force-with-lease=${branch}:${tip ?? ""}`,
		];
		const result = await git(this.#options.repoRoot, args);
		if (result.code === 0) return true;
		// The lease names the tip this run fetched, so "stale info" means another run pushed since; a ref the remote could
		// not lock is another run's push to it landing at the same moment.
		const line = result.stdout.split("\n").find((each) => each.startsWith(`!\t${commit}:${branch}\t`));
		if (
			line?.includes("[rejected] (stale info)") ||
			(line?.includes("[remote rejected] (failed to update ref)") && result.stderr.includes("cannot lock ref"))
		)
			return false;
		throw new StateBranchError("pushFailed", `git push of melian/state failed: ${result.stderr.trim()}`);
	}
}

class Refusal extends Error {}

/**
 * One changeset of the state branch, leased to this run: its storage in this clone's copy, and the push that stores
 * the copy back on the branch and releases the lease.
 */
export class StateCheckout {
	readonly changeset: string;
	readonly directory: string;
	/** Where this clone's copy was set aside, when the branch had moved past it. */
	readonly setAside: string | undefined;
	readonly #branch: StateBranch;
	readonly #synced: string;
	readonly #lock: CopyLock;

	private constructor(
		branch: StateBranch,
		changeset: string,
		synced: string,
		setAside: string | undefined,
		lock: CopyLock,
	) {
		this.#branch = branch;
		this.#lock = lock;
		this.changeset = changeset;
		this.directory = join(branch.directory, changeset);
		this.#synced = synced;
		this.setAside = setAside;
	}

	/** @internal */
	static async restore(
		branch: StateBranch,
		changeset: string,
		stored: string | undefined,
		lock: CopyLock,
	): Promise<StateCheckout> {
		const directory = join(branch.directory, changeset);
		const marker = `${directory}.synced`;
		const onBranch = stored ?? "none";
		const synced = await readFile(marker, "utf8").then(
			(text) => text.trim(),
			() => undefined,
		);
		const local = await readdir(directory).then(
			() => true,
			() => false,
		);
		if (local && synced === onBranch) return new StateCheckout(branch, changeset, onBranch, undefined, lock);
		let setAside: string | undefined;
		if (local) {
			setAside = `${directory}.set-aside-${Date.now()}`;
			await rename(directory, setAside);
		}
		await rm(directory, { recursive: true, force: true });
		if (onBranch === "none") await mkdir(directory, { recursive: true });
		else await branch.materialize(onBranch, directory);
		await writeFile(marker, `${onBranch}\n`);
		return new StateCheckout(branch, changeset, onBranch, setAside, lock);
	}

	/**
	 * Stores this clone's copy on the branch and releases the lease. Close the storage opened over `directory` first. A push the branch refuses,
	 * because another run moved the changeset, keeps the copy here; the next checkout sets it aside for the branch's.
	 */
	async push(): Promise<PushResult> {
		let tree = "";
		const result = await this.#branch.push(this.changeset, this.#synced, async () => {
			tree = await this.#branch.snapshot(this.directory);
			return tree;
		});
		if (result.kind === "pushed") await writeFile(`${this.directory}.synced`, `${tree}\n`);
		return result;
	}

	/** Lets another process in this clone open the copy. A lease left on the branch expires, or the next run takes it. */
	close(): Promise<void> {
		return this.#lock.release();
	}
}

import { createCipheriv, createDecipheriv, createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { git, gitFailure, gitOutput, gitOutputBytes, Lease, type LeaseHolder } from "@melian-agent/core";
import { StateBranchError, StateIndex } from "./state-index.ts";

const branch = "refs/heads/melian/state";
const indexFile = "index.json";
const changesetsTree = "changesets";
// Pi's JSONL storage writes exactly these: its main log and one sidecar per document and task.
const storageFile = /^(?:main|(?:doc|task)-(?:0|[1-9]\d*))\.jsonl$/;
const changesetName = /^[a-z0-9][a-z0-9-]{0,63}$/;
const attemptsLimit = 3;
const defaultLeaseMs = 2 * 60 * 60 * 1000;
const sealVersion = 1;
const sqliteBusy = 5;
// Git records who pushed the branch; the commits themselves need only some identity.
// Git translates what it prints, and Melian reads its fetch and push output to tell a missing branch or a lost race
// from a failure, so every command runs in the C locale, which git never translates. No command may prompt for
// credentials, so a remote that asks for them fails the fetch or push rather than waits for an answer nobody gives.
const untranslated = {
	LC_ALL: "C",
	LANGUAGE: "C",
	GIT_TERMINAL_PROMPT: "0",
	// Git's own limit: a transfer slower than a byte a second for a minute fails, so the branch reads as out of reach.
	GIT_CONFIG_COUNT: "2",
	GIT_CONFIG_KEY_0: "http.lowSpeedLimit",
	GIT_CONFIG_VALUE_0: "1",
	GIT_CONFIG_KEY_1: "http.lowSpeedTime",
	GIT_CONFIG_VALUE_1: "60",
};
const identity = {
	...untranslated,
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
	/** The writers' 32-byte key, which every file on the branch is encrypted under. */
	readonly key: Uint8Array;
	readonly now?: () => number;
	/** How long a lease stays live after it is taken. */
	readonly leaseMs?: number;
	/**
	 * Opens the copy in `directory` with the storage that wrote it, and rejects when that storage finds it damaged. A
	 * checkout keeps this clone's copy only when it opens; otherwise it sets the copy aside for the branch's.
	 */
	readonly validate: (directory: string) => Promise<void>;
}

/** Another run holds the changeset's lease, so this one must not write it. */
export class LeaseHeld extends Error {
	readonly code = "leaseHeld";
	readonly lease: Lease;

	constructor(changeset: string, lease: Lease) {
		super(
			`another run holds ${changeset} on the state branch: run ${lease.holder.run} in clone ${lease.holder.clone}, until ${lease.expiresAt}; wait for it to finish, or for its lease to expire`,
		);
		this.name = "LeaseHeld";
		this.lease = lease;
	}
}

// Seals each file the branch holds under the writers' key, so a repository reader learns nothing from it: the
// publisher secret that signs Melian's markers lives in the storage. AES-256-GCM binds a file to its changeset and
// name. Its nonce is derived from the key and the content, so an unchanged file seals to the same blob on every push,
// and two contents never share a nonce.
class Seal {
	readonly #encrypt: Buffer;
	readonly #nonce: Buffer;
	readonly commitment: string;

	constructor(key: Uint8Array) {
		if (key.length !== 32)
			throw new StateBranchError(
				"invalidKey",
				"the state key must be 32 bytes, as a writers' key from Melian's secrets file is",
			);
		this.#encrypt = createHmac("sha256", key).update("melian-state encrypt").digest();
		this.#nonce = createHmac("sha256", key).update("melian-state nonce").digest();
		this.commitment = createHmac("sha256", key).update("melian-state key commitment").digest("hex");
	}

	seal(name: string, plain: Buffer): Buffer {
		const nonce = createHmac("sha256", this.#nonce).update(name).update("\0").update(plain).digest().subarray(0, 12);
		const cipher = createCipheriv("aes-256-gcm", this.#encrypt, nonce).setAAD(Buffer.from(name));
		const body = Buffer.concat([cipher.update(plain), cipher.final()]);
		return Buffer.concat([Buffer.from([sealVersion]), nonce, cipher.getAuthTag(), body]);
	}

	open(name: string, sealed: Buffer): Buffer | undefined {
		if (sealed.length < 29 || sealed[0] !== sealVersion) return undefined;
		try {
			const decipher = createDecipheriv("aes-256-gcm", this.#encrypt, sealed.subarray(1, 13)).setAAD(
				Buffer.from(name),
			);
			decipher.setAuthTag(sealed.subarray(13, 29));
			return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
		} catch {
			return undefined;
		}
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

// One process's hold on this clone's copy of a changeset: an exclusive SQLite transaction on a lock file beside it,
// held until the checkout closes. SQLite's lock is the operating system's: the kernel frees it when the process dies,
// and a stopped or stalled process keeps it, so nothing guesses from a clock and nothing is ever taken over.
class CopyLock {
	readonly #database: DatabaseSync;

	private constructor(database: DatabaseSync) {
		this.#database = database;
	}

	static async take(directory: string, changeset: string): Promise<CopyLock> {
		await mkdir(directory, { recursive: true });
		const database = new DatabaseSync(join(directory, `${changeset}.lock`), { timeout: 0 });
		try {
			database.exec("BEGIN EXCLUSIVE");
		} catch (error) {
			database.close();
			if ((error as { errcode?: number }).errcode === sqliteBusy) throw new CopyInUse(changeset);
			throw error;
		}
		return new CopyLock(database);
	}

	release(): void {
		if (!this.#database.isOpen) return;
		this.#database.exec("ROLLBACK");
		this.#database.close();
	}
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
	readonly #seal: Seal;

	constructor(options: StateBranchOptions) {
		if (options.holder.length === 0 || options.holder.length > 200)
			throw new StateBranchError("invalidHolder", "a state branch holder must be 1 to 200 characters");
		this.#options = options;
		this.#seal = new Seal(options.key);
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
		const lock = await CopyLock.take(this.#options.directory, changeset);
		try {
			return await this.#checkout(changeset, lock);
		} catch (error) {
			lock.release();
			throw error;
		}
	}

	async #checkout(changeset: string, lock: CopyLock): Promise<StateCheckout> {
		// This clone's lock is held, so a live lease of this clone's is one a crashed run left.
		let taken: Lease | undefined;
		const { stored } = await this.#withRetry(async (index, onBranch) => {
			const held = index.lease(changeset);
			if (held?.live(this.#now()) && held.holder.clone !== this.#options.holder)
				throw new LeaseHeld(changeset, held);
			// A copy this build cannot read is refused before the lease goes over it.
			const tree = onBranch(changeset);
			if (tree !== undefined) await this.#open(changeset, tree);
			taken = Lease.take(held, this.#holder, this.#now(), this.#options.leaseMs ?? defaultLeaseMs);
			return { index: index.leased(changeset, taken), lease: taken };
		});
		const lease = taken!;
		try {
			return await StateCheckout.restore(this, changeset, stored(changeset), lock, lease);
		} catch (error) {
			// The lease is taken, so a restore that failed would hold every other clone off until it expired.
			const expired = await this.#expire(changeset, lease).then(
				() => undefined,
				(failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
			);
			if (expired === undefined || !(error instanceof Error)) throw error;
			const until = new Date(this.#now() + (this.#options.leaseMs ?? defaultLeaseMs)).toISOString();
			error.message = `${error.message}; the lease, generation ${lease.generation}, stays on melian/state until ${until}, since expiring it failed: ${expired}`;
			throw error;
		}
	}

	/** @internal */
	async push(changeset: string, synced: string, lease: Lease, tree: () => Promise<string>): Promise<PushResult> {
		try {
			const { tip } = await this.#withRetry(async (index, stored) => {
				// A write lands only under the latest lease, so a run that outlived its lease is refused.
				this.#fenced(index, changeset, lease);
				if ((stored(changeset) ?? "none") !== synced)
					throw new Refusal("another run pushed the changeset since this one fetched it");
				return {
					index: index.wrote(changeset).released(changeset, this.#now()),
					tree: { changeset, sha: await tree() },
					lease,
				};
			});
			return { kind: "pushed", commit: tip };
		} catch (error) {
			if (error instanceof Refusal) return { kind: "refused", reason: error.message };
			throw error;
		}
	}

	/** @internal Seals the changeset's directory into the clone's object database and names its tree. */
	async snapshot(changeset: string, directory: string): Promise<string> {
		const found = await readdir(directory, { withFileTypes: true });
		const stray = found.find((entry) => !entry.isFile() || !storageFile.test(entry.name));
		if (stray !== undefined)
			throw new StateBranchError(
				"invalidCopy",
				`this clone's copy of ${directory.split("/").at(-1)} holds ${JSON.stringify(stray.name)}, which Pi's storage never writes, so Melian will not push part of it`,
			);
		const names = found.map((entry) => entry.name).sort();
		const shas: string[] = [];
		for (const name of names) {
			const sealed = this.#seal.seal(`${changeset}/${name}`, await readFile(join(directory, name)));
			shas.push((await this.#git(["hash-object", "-w", "--stdin"], sealed)).trim());
		}
		const tree = names.map((name, i) => mktreeLine({ mode: "100644", type: "blob", sha: shas[i]!, name })).join("");
		return (await this.#git(["mktree", "-z"], tree)).trim();
	}

	/** @internal Writes a tree of the branch into a fresh directory, refusing anything Pi's storage would not write. */
	async materialize(changeset: string, tree: string, directory: string): Promise<void> {
		const opened = await this.#open(changeset, tree);
		await mkdir(directory, { recursive: true });
		for (const [name, plain] of opened) await writeFile(join(directory, name), plain);
	}

	/**
	 * @internal Whether the copy in `directory` still holds the tree's commits, whole. Pi only appends to its main log,
	 * and trims only a torn last line, so a copy that grew from the tree starts its main log with the tree's; Pi reads a
	 * missing main log as an empty store, so this is checked first. Pi's own storage then judges the rest.
	 */
	async intact(changeset: string, tree: string, directory: string): Promise<boolean> {
		const main = (await this.#open(changeset, tree)).find(([name]) => name === "main.jsonl")?.[1];
		if (main !== undefined) {
			const local = await readFile(join(directory, "main.jsonl")).catch(() => undefined);
			if (local === undefined || local.length < main.length || !local.subarray(0, main.length).equals(main))
				return false;
		}
		return this.#options.validate(directory).then(
			() => true,
			() => false,
		);
	}

	// Every file of a changeset's tree, opened under the key, or a refusal naming the first this build cannot read.
	async #open(changeset: string, tree: string): Promise<[string, Buffer][]> {
		const files = entries(await gitOutputBytes(this.#options.repoRoot, ["ls-tree", "-z", tree]));
		const stray = files.find((entry) => entry.mode !== "100644" || !storageFile.test(entry.name));
		if (stray !== undefined)
			throw new StateBranchError(
				"invalidBranch",
				`the state branch holds ${JSON.stringify(stray.name)} in ${changeset}, which Melian never writes`,
			);
		const opened: [string, Buffer][] = [];
		for (const entry of files) {
			const sealed = await gitOutputBytes(this.#options.repoRoot, ["cat-file", "blob", entry.sha]);
			const plain = this.#seal.open(`${changeset}/${entry.name}`, sealed);
			if (plain === undefined)
				throw new StateBranchError(
					"invalidBranch",
					`this clone's state key cannot read ${entry.name} in ${changeset}; the branch was written under another key, or the file was moved`,
				);
			opened.push([entry.name, plain]);
		}
		return opened;
	}

	// Expires the changeset's lease, if it is still the one this run took; a lease another run has since taken is not
	// this run's to expire.
	async #expire(changeset: string, lease: Lease): Promise<void> {
		await this.#withRetry(async (index) => {
			this.#fenced(index, changeset, lease);
			return { index: index.released(changeset, this.#now()), lease };
		}).catch((error: unknown) => {
			if (!(error instanceof Refusal)) throw error;
		});
	}

	// The fence: the changeset's lease in the index, if it is still the one this run took, by incarnation and
	// generation; a record created afresh since has another incarnation, whatever its generation.
	#fenced(index: StateIndex, changeset: string, lease: Lease): Lease {
		const held = index.lease(changeset);
		if (held === undefined || !held.admits(lease.incarnation, lease.generation) || !held.heldBy(this.#holder))
			throw new Refusal(
				held !== undefined && held.incarnation !== lease.incarnation
					? `the changeset's lease record was created afresh, as incarnation ${held.incarnation}, after this one's ${lease.incarnation}`
					: `another run took the changeset's lease, at generation ${held?.generation ?? "none"}, after this one's ${lease.generation}`,
			);
		return held;
	}

	get directory(): string {
		return this.#options.directory;
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	get #holder(): LeaseHolder {
		return { clone: this.#options.holder, run: this.#run };
	}

	async #git(args: readonly string[], input?: string | Uint8Array): Promise<string> {
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
		) => Promise<{ index: StateIndex; tree?: { changeset: string; sha: string }; lease?: Lease }>,
	): Promise<{ tip: string; stored: (changeset: string) => string | undefined }> {
		for (let attempt = 1; ; attempt++) {
			const tip = await this.#fetch();
			const { index, changesets } = await this.#read(tip);
			const stored = (id: string) => changesets.get(id)?.sha;
			const next = await change(index, stored);
			const message = `melian: run ${this.#run}${next.lease === undefined ? "" : `, incarnation ${next.lease.incarnation}, generation ${next.lease.generation}`}`;
			const commit = await this.#compose(
				tip,
				next.index.keyed(this.#seal.commitment),
				changesets,
				next.tree,
				message,
			);
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
		const result = await git(this.#options.repoRoot, args, { env: untranslated });
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
		// A branch this build cannot read whole is refused, never read as empty: the next push would delete the rest. A
		// git mode names its object's type: 100644 a plain blob, 040000 a tree.
		const top = entries(await gitOutputBytes(this.#options.repoRoot, ["ls-tree", "-z", tip]));
		const indexEntry = top.find((entry) => entry.name === indexFile);
		const treeEntry = top.find((entry) => entry.name === changesetsTree);
		if (top.length !== 2 || indexEntry?.mode !== "100644" || treeEntry?.mode !== "040000")
			throw new StateBranchError(
				"invalidBranch",
				`the state branch's root holds ${JSON.stringify(top.map((entry) => `${entry.type} ${entry.name}`))}, where this build reads only the blob index.json and the tree changesets`,
			);
		const index = StateIndex.parse(await gitOutput(this.#options.repoRoot, ["cat-file", "blob", indexEntry.sha]));
		// Checked on every read, so neither a new changeset nor a cached copy is ever written under another key.
		// The first push writes the commitment, so a branch that has a tip and none was written by something else.
		if (index.key === undefined)
			throw new StateBranchError(
				"invalidBranch",
				"the state branch's index.json commits to no writers' key, as only a branch before its first push does",
			);
		if (index.key !== this.#seal.commitment)
			throw new StateBranchError(
				"invalidBranch",
				"this clone's state key is not the key the branch was written under; check the writers' key in Melian's secrets file",
			);
		const changesets = new Map<string, Entry>();
		for (const entry of entries(await gitOutputBytes(this.#options.repoRoot, ["ls-tree", "-z", treeEntry.sha]))) {
			if (entry.mode !== "040000" || !changesetName.test(entry.name))
				throw new StateBranchError(
					"invalidBranch",
					`the state branch's changesets hold the ${entry.type} ${JSON.stringify(entry.name)}, which is no changeset`,
				);
			changesets.set(entry.name, entry);
		}
		// A written changeset whose tree is gone would read as a new, empty store, and the next push would keep it so.
		const lost = index.writtenChangesets().find((id) => !changesets.has(id));
		if (lost !== undefined)
			throw new StateBranchError(
				"invalidBranch",
				`the state branch's index.json records a write of ${lost}, whose tree the branch does not hold`,
			);
		return { index, changesets };
	}

	async #compose(
		tip: string | undefined,
		index: StateIndex,
		changesets: ReadonlyMap<string, Entry>,
		tree: { changeset: string; sha: string } | undefined,
		message: string,
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
		return (await this.#git(["commit-tree", root, ...(tip === undefined ? [] : ["-p", tip]), "-m", message])).trim();
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
		const result = await git(this.#options.repoRoot, args, { env: untranslated });
		if (result.code === 0) return true;
		// The lease names the tip this run fetched, so "stale info" means another run pushed since; the branch's ref the
		// remote could not lock is another run's push to it landing at the same moment. Git versions word that rejection's
		// porcelain line differently, so the remote's own error decides it; the push names no other ref.
		const line = result.stdout.split("\n").find((each) => each.startsWith(`!\t${commit}:${branch}\t`));
		if (line?.includes("[rejected] (stale info)") || result.stderr.includes(`cannot lock ref '${branch}'`))
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
	readonly #lease: Lease;

	private constructor(
		branch: StateBranch,
		changeset: string,
		synced: string,
		setAside: string | undefined,
		lock: CopyLock,
		lease: Lease,
	) {
		this.#branch = branch;
		this.#lock = lock;
		this.#lease = lease;
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
		lease: Lease,
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
		if (
			local &&
			synced === onBranch &&
			(onBranch === "none" || (await branch.intact(changeset, onBranch, directory)))
		)
			return new StateCheckout(branch, changeset, onBranch, undefined, lock, lease);
		let setAside: string | undefined;
		if (local) {
			setAside = `${directory}.set-aside-${Date.now()}`;
			await rename(directory, setAside);
		}
		await rm(directory, { recursive: true, force: true });
		if (onBranch === "none") await mkdir(directory, { recursive: true });
		else await branch.materialize(changeset, onBranch, directory);
		await writeFile(marker, `${onBranch}\n`);
		return new StateCheckout(branch, changeset, onBranch, setAside, lock, lease);
	}

	/** The lease's generation this checkout writes under, within its incarnation. */
	get generation(): number {
		return this.#lease.generation;
	}

	/** The incarnation of the changeset's lease record this checkout writes under. */
	get incarnation(): string {
		return this.#lease.incarnation;
	}

	/**
	 * Stores this clone's copy on the branch under this checkout's generation, and releases the lease. Close the storage
	 * opened over `directory` first. A push the branch refuses, because another run took the lease or moved the
	 * changeset, keeps the copy here; the next checkout sets it aside for the branch's.
	 */
	async push(): Promise<PushResult> {
		let tree = "";
		const result = await this.#branch.push(this.changeset, this.#synced, this.#lease, async () => {
			tree = await this.#branch.snapshot(this.changeset, this.directory);
			return tree;
		});
		if (result.kind === "pushed") await writeFile(`${this.directory}.synced`, `${tree}\n`);
		return result;
	}

	/** Lets another process in this clone open the copy. A lease left on the branch expires, or the next run takes it. */
	close(): void {
		this.#lock.release();
	}
}

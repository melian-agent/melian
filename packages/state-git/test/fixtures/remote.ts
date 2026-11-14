import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, GitRecordStore, type GitRecordStoreOptions } from "../../src/index.ts";

const isolated = {
	...process.env,
	GIT_CONFIG_COUNT: "0",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@invalid",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@invalid",
	LC_ALL: "C",
};

/** An entry a test writes to the branch by hand: a file's bytes, at a mode, or `null` to remove it. */
export type Planted = { readonly bytes: string | Buffer; readonly mode?: "100644" | "100755" | "120000" } | null;

/** A bare repository in a temporary directory, standing for the remote, with a host directory per handle. */
export class Remote {
	readonly root: string;
	readonly path: string;
	readonly url: string;
	readonly branch = "melian/state";
	readonly #stores: GitRecordStore[] = [];
	#hosts = 0;

	private constructor(root: string) {
		this.root = root;
		this.path = join(root, "remote.git");
		this.url = `file://${this.path}`;
	}

	static async create(): Promise<Remote> {
		const remote = new Remote(await mkdtemp(join(tmpdir(), "melian-state-git-")));
		remote.git(["init", "--bare", "--quiet", remote.path], remote.root);
		return remote;
	}

	git(args: readonly string[], cwd = this.path, options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {}) {
		return execFileSync("git", args, {
			cwd,
			env: { ...isolated, ...options.env },
			...(options.input === undefined ? {} : { input: options.input }),
		})
			.toString()
			.trim();
	}

	/** A new host's directory, as a second clone's state directory would be. */
	host(): string {
		return join(this.root, `host-${++this.#hosts}`);
	}

	async open(options: Partial<GitRecordStoreOptions> & { clock?: Clock } = {}): Promise<GitRecordStore> {
		const store = await GitRecordStore.open({ directory: this.host(), remote: this.url, ...options });
		this.#stores.push(store);
		return store;
	}

	tip(branch = this.branch): string | undefined {
		try {
			return this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
		} catch {
			return undefined;
		}
	}

	/** Commits `entries` onto the branch by hand, as a writer outside Melian would, and returns the commit. */
	plant(entries: Readonly<Record<string, Planted>>, branch = this.branch): string {
		const index = join(this.root, `plant-index-${process.pid}-${Date.now()}`);
		const env = { GIT_INDEX_FILE: index };
		const parent = this.tip(branch);
		this.git(parent === undefined ? ["read-tree", "--empty"] : ["read-tree", parent], this.path, { env });
		for (const [path, entry] of Object.entries(entries)) {
			if (entry === null) {
				this.git(["update-index", "--force-remove", "--", path], this.path, { env });
				continue;
			}
			const oid = this.git(["hash-object", "-w", "--no-filters", "--stdin"], this.path, { input: entry.bytes });
			this.git(["update-index", "--add", "--cacheinfo", `${entry.mode ?? "100644"},${oid},${path}`], this.path, {
				env,
			});
		}
		const tree = this.git(["write-tree"], this.path, { env });
		const commit = this.git(["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", "planted"]);
		this.git(["update-ref", `refs/heads/${branch}`, commit]);
		execFileSync("rm", ["-f", index]);
		return commit;
	}

	/** The paths of every file on the branch's tip. */
	files(branch = this.branch): string[] {
		const tip = this.tip(branch);
		if (tip === undefined) return [];
		return this.git(["ls-tree", "-r", "--name-only", "--full-tree", tip]).split("\n").filter(Boolean);
	}

	async close(): Promise<void> {
		for (const store of this.#stores) await store.close();
		await rm(this.root, { recursive: true, force: true });
	}
}

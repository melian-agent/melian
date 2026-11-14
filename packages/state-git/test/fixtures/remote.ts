import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RecordEnvelope, type RecordJson, SharedRecord } from "@melian-agent/core";
import { testPayloads } from "@melian-agent/core/testing";
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
		const store = await GitRecordStore.open({
			directory: this.host(),
			remote: this.url,
			payloads: testPayloads,
			...options,
		});
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
		return this.plantRaw(
			Object.entries(entries).map(([path, entry]) => [Buffer.from(path), entry]),
			branch,
		);
	}

	/** Commits entries at raw paths, which need not be UTF-8, onto the branch, and returns the commit. */
	plantRaw(entries: readonly (readonly [Buffer, Planted])[], branch = this.branch): string {
		const index = join(this.root, `plant-index-${process.pid}-${Date.now()}`);
		const env = { GIT_INDEX_FILE: index };
		const parent = this.tip(branch);
		this.git(parent === undefined ? ["read-tree", "--empty"] : ["read-tree", parent], this.path, { env });
		const lines = entries.map(([path, entry]) => {
			const line =
				entry === null
					? `0 ${"0".repeat(40)}\t`
					: `${entry.mode ?? "100644"} ${this.git(["hash-object", "-w", "--no-filters", "--stdin"], this.path, { input: entry.bytes })}\t`;
			return Buffer.concat([Buffer.from(line), path, Buffer.from("\0")]);
		});
		this.git(["update-index", "-z", "--index-info"], this.path, { env, input: Buffer.concat(lines) });
		const tree = this.git(["write-tree"], this.path, { env });
		const commit = this.git(["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", "planted"]);
		this.git(["update-ref", `refs/heads/${branch}`, commit]);
		execFileSync("rm", ["-f", index]);
		return commit;
	}

	/** The object ID of the file at `path` on the branch's tip. */
	oid(path: string, branch = this.branch): string {
		return this.git(["rev-parse", `refs/heads/${branch}:${path}`]);
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

export const changeset = "pull-0123456789abcdef";
export const other = "range-0123456789abcdef";

/** A check record in `within`, keyed by `key`. */
export function check(key: string, within = changeset, payload: RecordJson = {}): RecordEnvelope {
	return { v: 1, changeset: within, kind: "check", key, payload };
}

/** The path and bytes a store files `envelope` under. */
export function filed(envelope: RecordEnvelope): { path: string; bytes: string } {
	const record = SharedRecord.parse(envelope, testPayloads);
	return { path: record.path, bytes: record.bytes };
}

export function keys(records: readonly RecordEnvelope[]): string[] {
	return records.map((record) => record.key).sort();
}

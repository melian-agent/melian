// A bare remote and clones of it, each with its own store directory, for state branch tests.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { backgroundContext, defineDoc, openJsonlStorage, type Storage } from "@melian-agent/pipeline";
import { createSession } from "@melian-agent/pipeline/testing";
import { gitIn, isolatedGitEnv, removeDirectory, temporaryDirectory } from "../../../core/test/fixtures/repo.ts";
import { StateBranch, type StateBranchOptions, type StateCheckout } from "../../src/index.ts";

export const context = backgroundContext;
export const changeset = "pull-0123456789abcdef";

export class Remote {
	readonly root = temporaryDirectory();
	readonly bare = join(this.root, "remote.git");
	// The writers' key every clone of this remote shares unless a test gives it another.
	readonly key = randomBytes(32);
	#clones = 0;

	constructor() {
		gitIn(this.root, "init", "--quiet", "--bare", this.bare);
	}

	/** A clone of the remote, with a store directory and a holder of its own. */
	clone(options: Partial<StateBranchOptions> = {}): Clone {
		return new Clone(this, `clone-${++this.#clones}`, options);
	}

	/** The commit `melian/state` points at on the remote, or undefined before anything pushed it. */
	tip(): string | undefined {
		try {
			return gitIn(this.bare, "rev-parse", "--verify", "--quiet", "refs/heads/melian/state");
		} catch {
			return undefined;
		}
	}

	/** The tree the remote holds for a changeset. */
	stored(id = changeset): string {
		return gitIn(this.bare, "rev-parse", `refs/heads/melian/state:changesets/${id}`);
	}

	index(): unknown {
		return JSON.parse(gitIn(this.bare, "cat-file", "blob", "refs/heads/melian/state:index.json"));
	}

	close(): void {
		removeDirectory(this.root);
	}
}

// Opens a copy with Pi's storage, as the CLI does, which refuses one whose committed records are missing.
export async function validate(directory: string): Promise<void> {
	await (await openJsonlStorage(directory, context)).close(context);
}

export class Clone {
	readonly repoRoot: string;
	readonly directory: string;
	readonly holder: string;
	readonly #remote: Remote;
	readonly #options: Partial<StateBranchOptions>;

	constructor(remote: Remote, name: string, options: Partial<StateBranchOptions>) {
		this.#remote = remote;
		this.repoRoot = join(remote.root, name);
		this.directory = join(this.repoRoot, ".git", "melian", "state");
		this.holder = name;
		this.#options = options;
		gitIn(remote.root, "init", "--quiet", this.repoRoot);
	}

	/** A fresh branch handle, as a new process in this clone opens one. */
	branch(options: Partial<StateBranchOptions> = {}): StateBranch {
		return new StateBranch({
			repoRoot: this.repoRoot,
			remote: this.#remote.bare,
			directory: this.directory,
			holder: this.holder,
			key: this.#remote.key,
			validate,
			...this.#options,
			...options,
		});
	}

	has(path: string): boolean {
		return existsSync(join(this.directory, path));
	}
}

export const noteDoc = defineDoc({
	kind: "test.note",
	version: 1,
	scope: "session",
	initial: (): { notes: string[] } => ({ notes: [] }),
});

/** Appends a note to the storage's session document, as a review's task commits do. */
export async function note(storage: Storage, text: string): Promise<void> {
	const session = createSession(storage);
	await session.commit(async (tx) => {
		(await tx.doc(noteDoc)).notes.push(text);
	}, context);
	await session.close(context);
}

export async function notes(storage: Storage): Promise<readonly string[]> {
	const session = createSession(storage);
	try {
		return (await session.snapshot(noteDoc, context))?.notes ?? [];
	} finally {
		await session.close(context);
	}
}

/** Runs git in `root` with `input` on its standard input. */
export function gitWith(root: string, input: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		env: { ...process.env, ...isolatedGitEnv },
		encoding: "utf8",
		input,
	}).trim();
}

/**
 * Moves the remote's branch to a commit that replaces one changeset's files and keeps the index, as a writer that
 * ignores the lease, or an older build, would.
 */
export function replaceChangeset(remote: Remote, files: Record<string, string>, id = changeset): void {
	const bare = remote.bare;
	const tip = remote.tip()!;
	const blobs = Object.entries(files)
		.map(([name, content]) => `100644 blob ${gitWith(bare, content, "hash-object", "-w", "--stdin")}\t${name}\n`)
		.join("");
	const tree = gitWith(bare, blobs, "mktree");
	const others = gitIn(bare, "ls-tree", `${tip}:changesets`)
		.split("\n")
		.filter((line) => line !== "" && !line.endsWith(`\t${id}`));
	const changesets = gitWith(
		bare,
		[...others, `040000 tree ${tree}\t${id}`].map((line) => `${line}\n`).join(""),
		"mktree",
	);
	const index = gitIn(bare, "rev-parse", `${tip}:index.json`);
	const root = gitWith(bare, `100644 blob ${index}\tindex.json\n040000 tree ${changesets}\tchangesets\n`, "mktree");
	const commit = gitIn(bare, "commit-tree", root, "-p", tip, "-m", "replaced");
	gitIn(bare, "update-ref", "refs/heads/melian/state", commit);
}

/** Opens the storage in a checkout's copy, as the CLI does through the pipeline. */
export function storageOf(checkout: StateCheckout): Promise<Storage> {
	return openJsonlStorage(checkout.directory, context);
}

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineDoc } from "@melian-agent/pipeline";
import { createSession } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { LeaseHeld, StateBranchError } from "../src/index.ts";
import {
	type Clone,
	changeset,
	context,
	gitWith,
	note,
	notes,
	Remote,
	replaceChangeset,
	storageOf,
} from "./fixtures/state.ts";

let remote: Remote;

// Checks the changeset out in a child process that exits without closing it, as a crashed review does.
function crash(clone: Clone): void {
	const fixture = fileURLToPath(new URL("./fixtures/crash-checkout.ts", import.meta.url));
	const args = [clone.repoRoot, remote.bare, clone.directory, clone.holder, changeset, remote.key.toString("hex")];
	execFileSync(process.execPath, ["--conditions=@melian-agent/source", fixture, ...args], {
		env: { ...process.env, ...isolatedGitEnv },
	});
}

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	remote = new Remote();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	remote.close();
});

describe("a changeset on the state branch", () => {
	it("restores in a fresh clone what another clone pushed", async () => {
		const first = await remote.clone().branch().checkout(changeset);
		await note(await storageOf(first), "marker secret 0123");
		await note(await storageOf(first), "ledger comment 42");
		const pushed = await first.push();
		expect(pushed).toEqual({ kind: "pushed", commit: remote.tip() });

		const fresh = await remote.clone().branch().checkout(changeset);
		expect(fresh.setAside).toBeUndefined();
		expect(await notes(await storageOf(fresh))).toEqual(["marker secret 0123", "ledger comment 42"]);
		expect(remote.index()).toEqual({
			version: 1,
			key: expect.stringMatching(/^[0-9a-f]{64}$/),
			changesets: {
				[changeset]: {
					lease: {
						holder: { clone: "clone-2", run: expect.any(String) },
						takenAt: expect.any(String),
						expiresAt: expect.any(String),
						generation: 2,
					},
					written: 1,
				},
			},
		});
	});

	it("keeps this clone's copy when nobody else pushed the changeset since", async () => {
		const clone = remote.clone();
		const first = await clone.branch().checkout(changeset);
		await note(await storageOf(first), "pushed");
		expect(await first.push()).toMatchObject({ kind: "pushed" });
		first.close();
		const second = await clone.branch().checkout(changeset);
		await note(await storageOf(second), "kept locally");
		second.close();
		const third = await clone.branch().checkout(changeset);
		expect(third.setAside).toBeUndefined();
		expect(await notes(await storageOf(third))).toEqual(["pushed", "kept locally"]);
	});

	it("leaves other changesets on the branch as they were", async () => {
		const clone = remote.clone();
		const other = await clone.branch().checkout("pull-fedcba9876543210");
		await note(await storageOf(other), "other");
		await other.push();
		const before = remote.stored("pull-fedcba9876543210");
		const mine = await clone.branch().checkout(changeset);
		await note(await storageOf(mine), "mine");
		await mine.push();
		expect(remote.stored("pull-fedcba9876543210")).toBe(before);
		expect(gitIn(remote.bare, "ls-tree", "--name-only", "refs/heads/melian/state:changesets").split("\n")).toEqual([
			changeset,
			"pull-fedcba9876543210",
		]);
	});
});

describe("the lease", () => {
	const start = Date.parse("2026-11-07T00:00:00Z");
	const hour = 60 * 60 * 1000;

	it("refuses a run when another clone holds a live lease, and writes nothing", async () => {
		await remote
			.clone({ now: () => start })
			.branch()
			.checkout(changeset);
		const tip = remote.tip();
		const late = remote.clone({ now: () => start + 2 * hour - 1 });
		const refusal = await late
			.branch()
			.checkout(changeset)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(refusal).toBeInstanceOf(LeaseHeld);
		expect((refusal as LeaseHeld).message).toMatch(
			/^another run holds pull-0123456789abcdef on the state branch: run [0-9a-f-]{36} in clone clone-1, until 2026-11-07T02:00:00\.000Z; wait for it to finish, or for its lease to expire$/,
		);
		expect(remote.tip()).toBe(tip);
		expect(late.has(changeset)).toBe(false);
	});

	it("takes a lease two hours old", async () => {
		await remote
			.clone({ now: () => start })
			.branch()
			.checkout(changeset);
		await remote
			.clone({ now: () => start + 2 * hour })
			.branch()
			.checkout(changeset);
		expect(remote.index()).toMatchObject({
			changesets: {
				[changeset]: {
					lease: {
						holder: { clone: "clone-2" },
						takenAt: "2026-11-07T02:00:00.000Z",
						expiresAt: "2026-11-07T04:00:00.000Z",
						generation: 2,
					},
				},
			},
		});
	});

	it("takes a lease of its own clone's, which a crashed run left, and counts the attempt", async () => {
		const clone = remote.clone({ now: () => start });
		crash(clone);
		const rerun = clone.branch();
		await rerun.checkout(changeset);
		expect(remote.index()).toMatchObject({
			changesets: { [changeset]: { lease: { holder: { clone: "clone-1", run: rerun.run }, generation: 2 } } },
		});
	});

	it("is released by the push", async () => {
		const checkout = await remote.clone().branch().checkout(changeset);
		await checkout.push();
		const { changesets } = remote.index() as {
			changesets: Record<string, { lease: { expiresAt: string }; written: number }>;
		};
		expect(changesets[changeset]!.written).toBe(1);
		expect(Date.parse(changesets[changeset]!.lease.expiresAt)).toBeLessThanOrEqual(Date.now());
	});
});

describe("two runs racing one changeset", () => {
	const start = Date.parse("2026-11-07T00:00:00Z");
	const expired = start + 2 * 60 * 60 * 1000;

	it("refuses the loser's push, keeps its copy, and resumes it from the winner's", async () => {
		const loserClone = remote.clone({ now: () => start });
		const loser = await loserClone.branch().checkout(changeset);
		await note(await storageOf(loser), "lens A");
		await note(await storageOf(loser), "lens B");
		const winner = await remote
			.clone({ now: () => expired })
			.branch()
			.checkout(changeset);
		await note(await storageOf(winner), "lens A");
		expect(await winner.push()).toMatchObject({ kind: "pushed" });
		const won = remote.tip();

		expect(await loser.push()).toEqual({
			kind: "refused",
			reason: "another run took the changeset's lease, at generation 2, after this one's 1",
		});
		expect(remote.tip()).toBe(won);
		expect(await notes(await storageOf(loser))).toEqual(["lens A", "lens B"]);
		loser.close();

		const resumed = await loserClone.branch({ now: () => expired + 1 }).checkout(changeset);
		expect(resumed.setAside).toMatch(/\/pull-0123456789abcdef\.set-aside-\d+$/);
		const storage = await storageOf(resumed);
		expect(await notes(storage)).toEqual(["lens A"]);
		await note(await storageOf(resumed), "lens B");
		expect(await resumed.push()).toMatchObject({ kind: "pushed" });
		expect(await notes(await storageOf(await remote.clone().branch().checkout(changeset)))).toEqual([
			"lens A",
			"lens B",
		]);
	});

	it("refuses a push when the changeset moved on the branch under this run's own lease", async () => {
		const checkout = await remote.clone().branch().checkout(changeset);
		await note(await storageOf(checkout), "mine");
		replaceChangeset(remote, { "main.jsonl": "" });
		const moved = remote.tip();
		expect(await checkout.push()).toEqual({
			kind: "refused",
			reason: "another run pushed the changeset since this one fetched it",
		});
		expect(remote.tip()).toBe(moved);
	});
});

describe("what the branch holds", () => {
	it("refuses a file Pi's storage never writes, and writes none of the changeset locally", async () => {
		const writer = await remote.clone().branch().checkout(changeset);
		await writer.push();
		replaceChangeset(remote, { "main.jsonl": "", "post-checkout": "#!/bin/sh\n" });
		const clone = remote.clone();
		const error = await clone
			.branch()
			.checkout(changeset)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(StateBranchError);
		expect(error).toMatchObject({
			code: "invalidBranch",
			message: 'the state branch holds "post-checkout" in pull-0123456789abcdef, which Melian never writes',
		});
		expect(clone.has(changeset)).toBe(false);
	});

	it.each(["doc-01.jsonl", "task-x.jsonl", "main.jsonl.reclaim", "main.json"])(
		"refuses %s, which is not a name Pi's storage writes",
		async (name) => {
			await (await remote.clone().branch().checkout(changeset)).push();
			replaceChangeset(remote, { [name]: "" });
			await expect(remote.clone().branch().checkout(changeset)).rejects.toMatchObject({ code: "invalidBranch" });
		},
	);

	it("restores every file the writer pushed, byte for byte", async () => {
		const writer = await remote.clone().branch().checkout(changeset);
		await note(await storageOf(writer), "one");
		await note(await storageOf(writer), "two");
		await writer.push();
		const written = readdirSync(writer.directory).sort();
		expect(written).toEqual(expect.arrayContaining(["main.jsonl", expect.stringMatching(/^doc-\d+\.jsonl$/)]));
		const restored = await remote.clone().branch().checkout(changeset);
		expect(readdirSync(restored.directory).sort()).toEqual(written);
		for (const name of written)
			expect(readFileSync(join(restored.directory, name))).toEqual(readFileSync(join(writer.directory, name)));
	});

	it("refuses a store whose document a newer build wrote, rather than overwrite it", async () => {
		const newer = defineDoc({
			kind: "test.note",
			version: 2,
			scope: "session",
			initial: () => ({ notes: [] as string[] }),
		});
		const writer = await remote.clone().branch().checkout(changeset);
		const session = createSession(await storageOf(writer));
		await session.commit(async (tx) => {
			(await tx.doc(newer)).notes.push("from a newer build");
		}, context);
		await session.close(context);
		await writer.push();
		const stored = remote.stored();

		const older = await remote.clone().branch().checkout(changeset);
		await expect(notes(await storageOf(older))).rejects.toThrow(
			/^Document \d+ \(test\.note\) has newer version 2 than 1$/,
		);
		await older.push();
		expect(remote.stored()).toBe(stored);
	});

	it("names a fetch that fails", async () => {
		const clone = remote.clone();
		const error = await clone
			.branch({ remote: join(remote.root, "absent.git") })
			.checkout(changeset)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(StateBranchError);
		expect(error).toMatchObject({
			code: "fetchFailed",
			message: expect.stringMatching(/^git fetch of melian\/state failed: /),
		});
	});
});

describe("Codex's review of d449ec6", () => {
	it("refuses a second process in the same clone while the first works on the changeset", async () => {
		const clone = remote.clone();
		const first = await clone.branch().checkout(changeset);
		const tip = remote.tip();
		await expect(clone.branch().checkout(changeset)).rejects.toMatchObject({
			code: "copyInUse",
			message: "another melian process in this clone is working on pull-0123456789abcdef; wait for it to finish",
		});
		expect(remote.tip()).toBe(tip);
		first.close();
		await expect(clone.branch().checkout(changeset)).resolves.toBeDefined();
	});

	it("keeps the copy for a live process however long it stalls", async () => {
		const clone = remote.clone();
		await clone.branch().checkout(changeset);
		const stalled = Date.now() + 60 * 60 * 1000;
		vi.spyOn(Date, "now").mockReturnValue(stalled);
		await expect(clone.branch().checkout(changeset)).rejects.toMatchObject({ code: "copyInUse" });
	});

	it("takes over the copy a crashed process left", async () => {
		const clone = remote.clone();
		crash(clone);
		await expect(clone.branch().checkout(changeset)).resolves.toBeDefined();
	});

	it("checks two changesets out of one clone at once", async () => {
		const clone = remote.clone();
		for (let round = 0; round < 5; round++) {
			const ids = [`pull-${String(2 * round).padStart(16, "0")}`, `pull-${String(2 * round + 1).padStart(16, "0")}`];
			const checkouts = await Promise.all(ids.map((id) => clone.branch().checkout(id)));
			await Promise.all(
				checkouts.map(async (checkout) => {
					await checkout.push();
					checkout.close();
				}),
			);
		}
		expect(
			gitIn(remote.bare, "ls-tree", "--name-only", "refs/heads/melian/state:changesets").split("\n"),
		).toHaveLength(10);
	});

	it.each([
		["no index.json", (_index: string, changesets: string) => `040000 tree ${changesets}\tchangesets\n`],
		["no changesets tree", (index: string) => `100644 blob ${index}\tindex.json\n`],
		[
			"index.json as a tree",
			(_index: string, changesets: string) =>
				`040000 tree ${changesets}\tindex.json\n040000 tree ${changesets}\tchangesets\n`,
		],
		[
			"changesets as a blob",
			(index: string) => `100644 blob ${index}\tindex.json\n100644 blob ${index}\tchangesets\n`,
		],
		[
			"an entry this build does not know",
			(index: string, changesets: string) =>
				`100644 blob ${index}\tindex.json\n040000 tree ${changesets}\tchangesets\n100644 blob ${index}\tledger.json\n`,
		],
	])("refuses a branch with %s, and pushes nothing", async (_name, root) => {
		await (await remote.clone().branch().checkout(changeset)).push();
		const bare = remote.bare;
		const index = gitIn(bare, "rev-parse", "refs/heads/melian/state:index.json");
		const changesets = gitIn(bare, "rev-parse", "refs/heads/melian/state:changesets");
		const tree = gitWith(bare, root(index, changesets), "mktree");
		const commit = gitIn(bare, "commit-tree", tree, "-p", remote.tip()!, "-m", "malformed");
		gitIn(bare, "update-ref", "refs/heads/melian/state", commit);
		await expect(remote.clone().branch().checkout(changeset)).rejects.toMatchObject({ code: "invalidBranch" });
		expect(remote.tip()).toBe(commit);
	});

	it.each([
		[
			"a blob",
			(tree: string, blob: string) =>
				`100644 blob ${blob}\tpull-fedcba9876543210\n040000 tree ${tree}\t${changeset}\n`,
		],
		[
			"a name no changeset has",
			(tree: string) => `040000 tree ${tree}\tPull Request\n040000 tree ${tree}\t${changeset}\n`,
		],
	])("refuses a changesets tree holding %s, and pushes nothing", async (_name, listing) => {
		await (await remote.clone().branch().checkout(changeset)).push();
		const bare = remote.bare;
		const tree = gitIn(bare, "rev-parse", `refs/heads/melian/state:changesets/${changeset}`);
		const index = gitIn(bare, "rev-parse", "refs/heads/melian/state:index.json");
		const changesets = gitWith(bare, listing(tree, index), "mktree");
		const root = gitWith(bare, `100644 blob ${index}\tindex.json\n040000 tree ${changesets}\tchangesets\n`, "mktree");
		const commit = gitIn(bare, "commit-tree", root, "-p", remote.tip()!, "-m", "malformed");
		gitIn(bare, "update-ref", "refs/heads/melian/state", commit);
		await expect(remote.clone().branch().checkout(changeset)).rejects.toMatchObject({ code: "invalidBranch" });
		expect(remote.tip()).toBe(commit);
	});

	it.each([
		["a file Pi's storage never writes", (directory: string) => writeFileSync(join(directory, "notes.txt"), "")],
		["a directory", (directory: string) => mkdirSync(join(directory, "doc-1.jsonl"))],
	])("refuses to push a copy holding %s, rather than push part of it", async (_name, plant) => {
		const checkout = await remote.clone().branch().checkout(changeset);
		await note(await storageOf(checkout), "kept");
		const tip = remote.tip();
		plant(checkout.directory);
		await expect(checkout.push()).rejects.toMatchObject({ code: "invalidCopy" });
		expect(remote.tip()).toBe(tip);
	});
});

describe("Codex's review of a7e009f", () => {
	const blobs = (): string[] =>
		gitIn(remote.bare, "ls-tree", "-r", "refs/heads/melian/state:changesets")
			.split("\n")
			.map((line) => line.split(/\s+/)[2]!);

	it("puts nothing on the branch that reads without the writers' key", async () => {
		const checkout = await remote.clone().branch().checkout(changeset);
		await note(await storageOf(checkout), "marker secret 0123");
		await checkout.push();
		const stored = blobs().map((sha) => execFileSync("git", ["cat-file", "blob", sha], { cwd: remote.bare }));
		expect(stored.length).toBeGreaterThan(0);
		for (const blob of stored) {
			expect(blob.includes("marker secret")).toBe(false);
			expect(blob.includes("test.note")).toBe(false);
		}
	});

	it("refuses a branch this clone's key cannot read, and writes nothing locally", async () => {
		const checkout = await remote.clone().branch().checkout(changeset);
		await note(await storageOf(checkout), "marker secret 0123");
		await checkout.push();
		const stranger = remote.clone({ key: randomBytes(32) });
		await expect(stranger.branch().checkout(changeset)).rejects.toMatchObject({
			code: "invalidBranch",
			message:
				"this clone's state key is not the key the branch was written under; check the writers' key in Melian's secrets file",
		});
		expect(stranger.has(changeset)).toBe(false);
	});

	it("refuses a file moved to another changeset or name on the branch", async () => {
		const checkout = await remote.clone().branch().checkout(changeset);
		await note(await storageOf(checkout), "marker secret 0123");
		await checkout.push();
		const main = gitIn(remote.bare, "rev-parse", `refs/heads/melian/state:changesets/${changeset}/main.jsonl`);
		const moved = execFileSync("git", ["cat-file", "blob", main], { cwd: remote.bare, encoding: "latin1" });
		replaceChangeset(remote, { "main.jsonl": moved }, "pull-fedcba9876543210");
		await expect(remote.clone().branch().checkout("pull-fedcba9876543210")).rejects.toMatchObject({
			code: "invalidBranch",
			message:
				"this clone's state key cannot read main.jsonl in pull-fedcba9876543210; the branch was written under another key, or the file was moved",
		});
	});

	it("keeps an unchanged file's blob from one push to the next", async () => {
		const clone = remote.clone();
		const first = await clone.branch().checkout(changeset);
		await note(await storageOf(first), "one");
		await first.push();
		first.close();
		const before = new Set(blobs());
		const second = await clone.branch().checkout(changeset);
		await second.push();
		expect(new Set(blobs())).toEqual(before);
	});

	it.each([31, 33])("refuses a key of %i bytes", (length) => {
		expect(() => remote.clone({ key: randomBytes(length) }).branch()).toThrow(
			"the state key must be 32 bytes, as a writers' key from Melian's secrets file is",
		);
	});
});

describe("Codex's review of edc438b", () => {
	it("refuses a new changeset from a clone whose key is not the branch's, and moves nothing", async () => {
		await (await remote.clone().branch().checkout(changeset)).push();
		const tip = remote.tip();
		await expect(
			remote
				.clone({ key: randomBytes(32) })
				.branch()
				.checkout("pull-fedcba9876543210"),
		).rejects.toMatchObject({
			code: "invalidBranch",
			message:
				"this clone's state key is not the key the branch was written under; check the writers' key in Melian's secrets file",
		});
		expect(remote.tip()).toBe(tip);
	});

	it("refuses a cached copy when this clone's key changed, and moves nothing", async () => {
		const clone = remote.clone();
		const first = await clone.branch().checkout(changeset);
		await note(await storageOf(first), "kept");
		await first.push();
		first.close();
		const tip = remote.tip();
		await expect(clone.branch({ key: randomBytes(32) }).checkout(changeset)).rejects.toMatchObject({
			code: "invalidBranch",
		});
		expect(remote.tip()).toBe(tip);
	});

	it.each([
		["empty", ""],
		["201 characters long", "x".repeat(201)],
	])("refuses a holder that is %s before any git command", (_name, holder) => {
		expect(() => remote.clone({ holder }).branch()).toThrow(
			expect.objectContaining({
				code: "invalidHolder",
				message: "a state branch holder must be 1 to 200 characters",
			}),
		);
		expect(remote.tip()).toBeUndefined();
	});

	it("takes a holder of exactly 200 characters", async () => {
		await remote
			.clone({ holder: "x".repeat(200) })
			.branch()
			.checkout(changeset);
		expect(remote.index()).toMatchObject({
			changesets: { [changeset]: { lease: { holder: { clone: "x".repeat(200) } } } },
		});
	});
});

describe("what the mutation inventory found untested", () => {
	it.each(["xmain.jsonl", "main.jsonlx", "doc-1a.jsonl", "task-01.jsonl"])(
		"refuses %s on the branch",
		async (name) => {
			await (await remote.clone().branch().checkout(changeset)).push();
			replaceChangeset(remote, { [name]: "" });
			await expect(remote.clone().branch().checkout(changeset)).rejects.toMatchObject({ code: "invalidBranch" });
		},
	);

	it.each(["xmain.jsonl", "main.jsonlx", "doc-1a.jsonl"])("refuses to push a copy holding %s", async (name) => {
		const checkout = await remote.clone().branch().checkout(changeset);
		writeFileSync(join(checkout.directory, name), "");
		await expect(checkout.push()).rejects.toMatchObject({ code: "invalidCopy" });
	});

	it.each(["Pull-0123456789abcdef", "pull-0123/x", "pull-0123456789abcdef!", "-pull", "x".repeat(65)])(
		"refuses the changeset name %j before any git command",
		async (name) => {
			await expect(remote.clone().branch().checkout(name)).rejects.toMatchObject({
				code: "invalidBranch",
				message: `${JSON.stringify(name)} is not a changeset name`,
			});
			expect(remote.tip()).toBeUndefined();
		},
	);

	it("takes a changeset name of 64 characters", async () => {
		await expect(remote.clone().branch().checkout("p".repeat(64))).resolves.toBeDefined();
	});

	it("commits under Melian's own identity, whatever the clone's git configuration says", async () => {
		for (const key of Object.keys(isolatedGitEnv).filter((key) => /^GIT_(AUTHOR|COMMITTER)_/.test(key)))
			vi.stubEnv(key, undefined);
		await remote.clone().branch().checkout(changeset);
		expect(gitIn(remote.bare, "log", "-1", "--format=%an <%ae> | %cn <%ce>", "refs/heads/melian/state")).toBe(
			"Melian state <state@melian.invalid> | Melian state <state@melian.invalid>",
		);
	});

	it("names its errors", async () => {
		const clone = remote.clone();
		await clone.branch().checkout(changeset);
		const inUse = await clone
			.branch()
			.checkout(changeset)
			.catch((error: Error) => error);
		const held = await remote
			.clone()
			.branch()
			.checkout(changeset)
			.catch((error: Error) => error);
		const invalid = await clone
			.branch()
			.checkout("Bad")
			.catch((error: Error) => error);
		expect([inUse, held, invalid].map((error) => (error as Error).name)).toEqual([
			"CopyInUse",
			"LeaseHeld",
			"StateBranchError",
		]);
	});

	it.each([
		[
			"index.json as an executable",
			(index: string, changesets: string) =>
				`100755 blob ${index}\tindex.json\n040000 tree ${changesets}\tchangesets\n`,
		],
		[
			"index.json as a symlink",
			(index: string, changesets: string) =>
				`120000 blob ${index}\tindex.json\n040000 tree ${changesets}\tchangesets\n`,
		],
	])("refuses a branch with %s", async (_name, root) => {
		await (await remote.clone().branch().checkout(changeset)).push();
		const bare = remote.bare;
		const index = gitIn(bare, "rev-parse", "refs/heads/melian/state:index.json");
		const changesets = gitIn(bare, "rev-parse", "refs/heads/melian/state:changesets");
		const tree = gitWith(bare, root(index, changesets), "mktree");
		gitIn(
			bare,
			"update-ref",
			"refs/heads/melian/state",
			gitIn(bare, "commit-tree", tree, "-p", remote.tip()!, "-m", "m"),
		);
		await expect(remote.clone().branch().checkout(changeset)).rejects.toMatchObject({ code: "invalidBranch" });
	});

	it("refuses an executable storage file on the branch", async () => {
		await (await remote.clone().branch().checkout(changeset)).push();
		const bare = remote.bare;
		const blob = gitWith(bare, "", "hash-object", "-w", "--stdin");
		const own = gitWith(bare, `100755 blob ${blob}\tmain.jsonl\n`, "mktree");
		const index = gitIn(bare, "rev-parse", "refs/heads/melian/state:index.json");
		const changesets = gitWith(bare, `040000 tree ${own}\t${changeset}\n`, "mktree");
		const root = gitWith(bare, `100644 blob ${index}\tindex.json\n040000 tree ${changesets}\tchangesets\n`, "mktree");
		gitIn(
			bare,
			"update-ref",
			"refs/heads/melian/state",
			gitIn(bare, "commit-tree", root, "-p", remote.tip()!, "-m", "m"),
		);
		await expect(remote.clone().branch().checkout(changeset)).rejects.toMatchObject({ code: "invalidBranch" });
	});

	it("seals a file and commits to a key exactly as this format's first version does", async () => {
		const key = Buffer.alloc(32, 1);
		const checkout = await remote.clone({ key }).branch().checkout(changeset);
		writeFileSync(join(checkout.directory, "main.jsonl"), "melian\n");
		await checkout.push();
		const sealed = execFileSync("git", ["cat-file", "blob", `${remote.stored()}:main.jsonl`], { cwd: remote.bare });
		expect({ key: (remote.index() as { key: string }).key, sealed: sealed.toString("hex") }).toEqual(GOLDEN);
	});
});

// Computed apart from this code, from the format the state branch decision sets: for 32 bytes of 0x01, the commitment
// HMAC-SHA256(key, "melian-state key commitment"), and main.jsonl holding "melian\n" sealed as version 1, nonce, tag
// and ciphertext.
const GOLDEN = {
	key: "07fcf6ff72e5a96a2ab8c8a51825709a0ba3096d8b984f37d04b87d60606c56b",
	sealed: "0179f42154297f99b85f1a6d5af912a28f8e24aa9085d85478267ca04bbb4bf12357fcbd",
};

describe("the fencing generation", () => {
	it("rises with every taking, and every write records the one it was made under", async () => {
		const clone = remote.clone();
		const first = await clone.branch().checkout(changeset);
		expect(first.generation).toBe(1);
		await first.push();
		first.close();
		const second = await clone.branch().checkout(changeset);
		expect(second.generation).toBe(2);
		await second.push();
		expect(gitIn(remote.bare, "log", "-1", "--format=%s", "refs/heads/melian/state")).toMatch(
			/^melian: run [0-9a-f-]{36}, generation 2$/,
		);
		expect(remote.index()).toMatchObject({ changesets: { [changeset]: { lease: { generation: 2 }, written: 2 } } });
	});
});

describe("Codex's review of 1785bc4", () => {
	it("refuses a branch copy it cannot read before taking the lease, and moves nothing", async () => {
		const writer = await remote.clone().branch().checkout(changeset);
		await note(await storageOf(writer), "stored");
		await writer.push();
		replaceChangeset(remote, { "main.jsonl": "not sealed" });
		const tip = remote.tip();
		await expect(remote.clone().branch().checkout(changeset)).rejects.toMatchObject({ code: "invalidBranch" });
		expect(remote.tip()).toBe(tip);
	});
});

describe("Codex's review of 3e1df8b", () => {
	it("refuses an existing branch whose index commits to no key, and moves nothing", async () => {
		await (await remote.clone().branch().checkout(changeset)).push();
		const bare = remote.bare;
		const unkeyed = { ...(remote.index() as Record<string, unknown>) };
		delete unkeyed.key;
		const index = gitWith(bare, `${JSON.stringify(unkeyed)}\n`, "hash-object", "-w", "--stdin");
		const changesets = gitIn(bare, "rev-parse", "refs/heads/melian/state:changesets");
		const root = gitWith(bare, `100644 blob ${index}\tindex.json\n040000 tree ${changesets}\tchangesets\n`, "mktree");
		gitIn(
			bare,
			"update-ref",
			"refs/heads/melian/state",
			gitIn(bare, "commit-tree", root, "-p", remote.tip()!, "-m", "unkeyed"),
		);
		const tip = remote.tip();
		await expect(remote.clone().branch().checkout("pull-fedcba9876543210")).rejects.toMatchObject({
			code: "invalidBranch",
			message:
				"the state branch's index.json commits to no writers' key, as only a branch before its first push does",
		});
		expect(remote.tip()).toBe(tip);
	});
});

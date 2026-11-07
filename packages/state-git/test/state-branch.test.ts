import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createSession, defineDoc } from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { LeaseHeld, StateBranchError } from "../src/index.ts";
import { changeset, context, note, notes, Remote, replaceChangeset } from "./fixtures/state.ts";

let remote: Remote;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	remote = new Remote();
});

afterEach(() => {
	vi.unstubAllEnvs();
	remote.close();
});

describe("Pi's storage conformance on a state branch checkout", () => {
	registerStorageConformance({ describe, expect: (actual) => expect(actual), it }, "state-git", async (use) => {
		const own = new Remote();
		try {
			const checkout = await own.clone().branch().checkout(changeset);
			const storage = await checkout.openStorage(context);
			try {
				await use(storage);
			} finally {
				await storage.close(context).catch(() => {});
			}
			expect(await checkout.push()).toMatchObject({ kind: "pushed" });
		} finally {
			own.close();
		}
	});
});

describe("a changeset on the state branch", () => {
	it("restores in a fresh clone what another clone pushed", async () => {
		const first = await remote.clone().branch().checkout(changeset);
		await note(await first.openStorage(context), "marker secret 0123");
		await note(await first.openStorage(context), "ledger comment 42");
		const pushed = await first.push();
		expect(pushed).toEqual({ kind: "pushed", commit: remote.tip() });

		const fresh = await remote.clone().branch().checkout(changeset);
		expect(fresh.setAside).toBeUndefined();
		expect(await notes(await fresh.openStorage(context))).toEqual(["marker secret 0123", "ledger comment 42"]);
		expect(remote.index()).toEqual({
			version: 1,
			changesets: {
				[changeset]: {
					lease: { run: expect.any(String), holder: "clone-2", heartbeat: expect.any(String), attempts: 1 },
				},
			},
		});
	});

	it("keeps this clone's copy when nobody else pushed the changeset since", async () => {
		const clone = remote.clone();
		const first = await clone.branch().checkout(changeset);
		await note(await first.openStorage(context), "pushed");
		expect(await first.push()).toMatchObject({ kind: "pushed" });
		const second = await clone.branch().checkout(changeset);
		await note(await second.openStorage(context), "kept locally");
		const third = await clone.branch().checkout(changeset);
		expect(third.setAside).toBeUndefined();
		expect(await notes(await third.openStorage(context))).toEqual(["pushed", "kept locally"]);
	});

	it("leaves other changesets on the branch as they were", async () => {
		const clone = remote.clone();
		const other = await clone.branch().checkout("pull-fedcba9876543210");
		await note(await other.openStorage(context), "other");
		await other.push();
		const before = remote.stored("pull-fedcba9876543210");
		const mine = await clone.branch().checkout(changeset);
		await note(await mine.openStorage(context), "mine");
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
			/^another run holds pull-0123456789abcdef on the state branch: run [0-9a-f-]{36} in clone clone-1, since 2026-11-07T00:00:00\.000Z; wait for it to finish, or for its lease to expire$/,
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
				[changeset]: { lease: { holder: "clone-2", heartbeat: "2026-11-07T02:00:00.000Z", attempts: 2 } },
			},
		});
	});

	it("takes a lease of its own clone's, which a crashed run left, and counts the attempt", async () => {
		const clone = remote.clone({ now: () => start });
		const crashed = clone.branch();
		await crashed.checkout(changeset);
		const rerun = clone.branch();
		await rerun.checkout(changeset);
		expect(remote.index()).toMatchObject({
			changesets: { [changeset]: { lease: { run: rerun.run, holder: "clone-1", attempts: 2 } } },
		});
	});

	it("is released by the push", async () => {
		const checkout = await remote.clone().branch().checkout(changeset);
		await checkout.push();
		expect(remote.index()).toEqual({ version: 1, changesets: {} });
	});
});

describe("two runs racing one changeset", () => {
	const start = Date.parse("2026-11-07T00:00:00Z");
	const expired = start + 2 * 60 * 60 * 1000;

	it("refuses the loser's push, keeps its copy, and resumes it from the winner's", async () => {
		const loserClone = remote.clone({ now: () => start });
		const loser = await loserClone.branch().checkout(changeset);
		await note(await loser.openStorage(context), "lens A");
		await note(await loser.openStorage(context), "lens B");
		const winner = await remote
			.clone({ now: () => expired })
			.branch()
			.checkout(changeset);
		await note(await winner.openStorage(context), "lens A");
		expect(await winner.push()).toMatchObject({ kind: "pushed" });
		const won = remote.tip();

		expect(await loser.push()).toEqual({
			kind: "refused",
			reason: "another run took the changeset's lease after this one's expired",
		});
		expect(remote.tip()).toBe(won);
		expect(await notes(await loser.openStorage(context))).toEqual(["lens A", "lens B"]);

		const resumed = await loserClone.branch({ now: () => expired + 1 }).checkout(changeset);
		expect(resumed.setAside).toMatch(/\/pull-0123456789abcdef\.set-aside-\d+$/);
		const storage = await resumed.openStorage(context);
		expect(await notes(storage)).toEqual(["lens A"]);
		await note(await resumed.openStorage(context), "lens B");
		expect(await resumed.push()).toMatchObject({ kind: "pushed" });
		expect(await notes(await (await remote.clone().branch().checkout(changeset)).openStorage(context))).toEqual([
			"lens A",
			"lens B",
		]);
	});

	it("refuses a push when the changeset moved on the branch under this run's own lease", async () => {
		const checkout = await remote.clone().branch().checkout(changeset);
		await note(await checkout.openStorage(context), "mine");
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

	it.each(["main.jsonl", "doc-0.jsonl", "doc-17.jsonl", "task-3.jsonl"])("restores %s", async (name) => {
		await (await remote.clone().branch().checkout(changeset)).push();
		replaceChangeset(remote, { [name]: "" });
		const checkout = await remote.clone().branch().checkout(changeset);
		expect(readdirSync(checkout.directory)).toEqual([name]);
	});

	it("refuses a store whose document a newer build wrote, rather than overwrite it", async () => {
		const newer = defineDoc({
			kind: "test.note",
			version: 2,
			scope: "session",
			initial: () => ({ notes: [] as string[] }),
		});
		const writer = await remote.clone().branch().checkout(changeset);
		const session = createSession(await writer.openStorage(context));
		await session.commit(async (tx) => {
			(await tx.doc(newer)).notes.push("from a newer build");
		}, context);
		await session.close(context);
		await writer.push();
		const stored = remote.stored();

		const older = await remote.clone().branch().checkout(changeset);
		await expect(notes(await older.openStorage(context))).rejects.toThrow(
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

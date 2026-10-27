import {
	Comparison,
	MembershipError,
	PullRequestMembership,
	pullRequestChangesetId,
	type RoundMembership,
} from "@melian-agent/core";
import { PullRequestRoundsReader } from "@melian-agent/github";
import {
	CompareHarness,
	backgroundContext as context,
	createMemoryStorage,
	PullRequestRoundHistory,
	type PullRequestRoundSnapshot,
} from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Io } from "../src/commands.ts";
import { ComparisonStores } from "../src/comparison-stores.ts";
import { PullRequestComparison } from "../src/pull-request-comparison.ts";
import * as repository from "../src/repository.ts";
import * as target from "../src/target.ts";

const id = pullRequestChangesetId("github", { owner: "owner", name: "repo" }, 7);
const at = "2026-10-27T01:00:00.000Z";
const answer = {
	repository: { owner: "owner", name: "repo" },
	number: 7,
	base: "a".repeat(40),
	head: "b".repeat(40),
	merge: null,
	commits: ["b".repeat(40)],
	forcePushes: [],
	associated: {},
};
const old: RoundMembership = {
	id: "range-aaaaaaaaaaaaaaaa.r1",
	base: answer.base,
	head: answer.head,
	mintedAt: "2026-10-26T00:00:00Z",
	status: "member",
	reason: "exact pull request merge base",
};
const removed: RoundMembership = { ...old, id: "range-aaaaaaaaaaaaaaaa.r2", mintedAt: "2026-10-26T01:00:00Z" };
const added: RoundMembership = { ...old, id: "range-bbbbbbbbbbbbbbbb.r1", mintedAt: "2026-10-26T02:00:00Z" };
const rejected: RoundMembership = {
	...removed,
	status: "foreign",
	reason: "stored base is not an exact pull request merge base",
};
const previous: PullRequestRoundSnapshot = {
	version: 1,
	at,
	answer,
	members: [
		{ ...old, number: 1 },
		{ ...removed, number: 2 },
	],
	foreign: [],
	ambiguous: [],
	unattributed: [],
	warnings: [],
	audit: [],
};
const next: PullRequestRoundSnapshot = {
	...previous,
	version: 2,
	members: [
		{ ...old, number: 1 },
		{ ...added, number: 2 },
	],
	foreign: [rejected],
};
let io: Io;
let storage: ReturnType<typeof createMemoryStorage>;
let stores: ComparisonStores;
let write: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<PullRequestRoundSnapshot>>>;
let close: ReturnType<typeof vi.fn<() => Promise<void>>>;
const output = () =>
	vi
		.mocked(io.stdout)
		.mock.calls.map(([text]) => text)
		.join("");

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(at));
	io = { cwd: "/repo", env: { MELIAN_TEST_SCRIPT: "unit.json" }, color: false, stdout: vi.fn(), stderr: vi.fn() };
	storage = createMemoryStorage();
	write = vi.fn(async (..._args: unknown[]) => structuredClone(next));
	close = vi.fn(async () => {});
	stores = {
		repoRoot: "/repo",
		directory: "/state/scripted",
		candidates: [old, added, removed],
		histories: new Map([[id, PullRequestRoundHistory.from([previous])]]),
		entries: [added, old, removed].map((round) => ({
			changeset: round.id.split(".")[0]!,
			round: round.id,
			comparison: Comparison.of({ base: round.base, head: round.head }),
		})),
	};
	vi.spyOn(repository, "git").mockImplementation(async (_cwd, args) =>
		args[0] === "remote" ? "git@github.com:owner/repo.git" : "Melian Test <test@melian.invalid> 0 +0000",
	);
	vi.spyOn(repository, "openStorage").mockResolvedValue(storage);
	vi.spyOn(ComparisonStores, "read").mockResolvedValue(stores);
	vi.spyOn(target, "gitHubAccess").mockResolvedValue({ owner: "owner", repo: "repo", token: "scripted" });
	vi.spyOn(PullRequestRoundsReader, "open").mockReturnValue({ read: async () => structuredClone(answer) } as never);
	vi.spyOn(PullRequestMembership.prototype, "classify").mockImplementation(
		async (candidate) => structuredClone(candidate.id === removed.id ? rejected : candidate) as RoundMembership,
	);
	vi.spyOn(PullRequestMembership.prototype, "headAvailable").mockResolvedValueOnce(true).mockResolvedValue(false);
	vi.spyOn(CompareHarness, "open").mockResolvedValue({ refreshMembership: write, close } as never);
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	await storage.close(context);
});

it("passes exact membership facts and ownership to the writer and reports mixed additions and removals", async () => {
	expect(await (await PullRequestComparison.open(io, 7)).refresh(true)).toBe(0);
	expect(ComparisonStores.read).toHaveBeenCalledExactlyOnceWith(io, {
		repository: { owner: "owner", name: "repo" },
		pullRequest: 7,
	});
	expect(repository.openStorage).toHaveBeenCalledExactlyOnceWith(`/state/scripted/${id}.sqlite`);
	expect(write).toHaveBeenCalledExactlyOnceWith(
		answer,
		[old, added, rejected],
		"Melian Test <test@melian.invalid>",
		at,
		true,
	);
	expect(PullRequestMembership.prototype.headAvailable).toHaveBeenCalledExactlyOnceWith(answer.head);
	expect(output()).toContain("Membership snapshot 2: 1 added, 1 removed.");
	expect(output()).toContain(`Round 1:\n${stores.entries[1]!.comparison.render(undefined)}`);
	expect(output()).toContain(`Round 2:\n${stores.entries[0]!.comparison.render(undefined)}`);
	expect(close).toHaveBeenCalledExactlyOnceWith(context);
});
it("closes the writer when its atomic refresh rejects", async () => {
	write.mockRejectedValueOnce(new Error("atomic refresh failed"));
	await expect((await PullRequestComparison.open(io, 7)).refresh(true)).rejects.toThrow("atomic refresh failed");
	expect(close).toHaveBeenCalledExactlyOnceWith(context);
});
it("exports only members and orders comparison keys by snapshot number across stores", async () => {
	stores.histories.set(id, PullRequestRoundHistory.from([previous, next]));
	expect(await (await PullRequestComparison.open(io, 7)).export({ json: true })).toBe(0);
	const exported = JSON.parse(output()) as {
		comparisons: Record<string, unknown>;
		membership: PullRequestRoundSnapshot;
		history: PullRequestRoundSnapshot[];
	};
	expect(Object.keys(exported.comparisons)).toEqual([old.id, added.id]);
	expect(exported.membership).toEqual(next);
	expect(exported.history).toEqual([previous, next]);
	expect(CompareHarness.open).not.toHaveBeenCalled();
});

it("passes a previously owned unavailable head to the writer as unreachable", async () => {
	vi.mocked(PullRequestMembership.prototype.headAvailable).mockReset().mockResolvedValue(false);
	await (await PullRequestComparison.open(io, 7)).refresh(true);
	expect(write.mock.calls[0]?.[1]).toEqual([
		{ ...old, status: "unreachable", reason: "head unavailable after fetch" },
		added,
		rejected,
	]);
});
it("renders the comparison belonging to each member rather than its neighbour", async () => {
	for (const entry of stores.entries) vi.spyOn(entry.comparison, "render").mockReturnValue(`${entry.round}\n`);
	await (await PullRequestComparison.open(io, 7)).refresh(true);
	expect(output()).toContain(`Round 1:\n${old.id}\nRound 2:\n${added.id}\n`);
});
it("orders three exported members for every incoming storage order", async () => {
	const entries = [...stores.entries];
	stores.histories.set(
		id,
		PullRequestRoundHistory.from([{ ...next, members: [...next.members, { ...removed, number: 3 }] }]),
	);
	for (const order of [
		[0, 1, 2],
		[0, 2, 1],
		[1, 0, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0],
	]) {
		stores.entries.splice(0, stores.entries.length, ...order.map((index) => entries[index]!));
		vi.mocked(io.stdout).mockClear();
		await (await PullRequestComparison.open(io, 7)).export({ json: true });
		expect(Object.keys(JSON.parse(output()).comparisons)).toEqual([old.id, added.id, removed.id]);
	}
});
it("refuses export without a snapshot or an existing comparison in the pull request's own storage", async () => {
	stores.histories.clear();
	await expect((await PullRequestComparison.open(io, 7)).export({ json: true })).rejects.toThrow(
		'no membership snapshot; run melian compare "#7" first',
	);
});
it("exports legacy comparisons from only the pull request storage before its first snapshot", async () => {
	stores.histories.clear();
	stores.entries.splice(0, 2, ...stores.entries.slice(0, 2).map((entry) => ({ ...entry, changeset: id })));
	await (await PullRequestComparison.open(io, 7)).export({ json: true });
	const record = JSON.parse(output());
	expect(Object.keys(record.comparisons)).toEqual([added.id, old.id]);
	expect(record.membership).toBeUndefined();
	expect(record.history).toBeUndefined();
	vi.mocked(io.stdout).mockClear();
	await (await PullRequestComparison.open(io, 7)).export({ json: false });
	expect(output()).toContain("# Comparison review: pull request");
	expect(output()).not.toContain("member rounds (snapshot");
});
it("includes saved membership ahead of the offline markdown comparisons", async () => {
	stores.histories.set(id, PullRequestRoundHistory.from([next]));
	await (await PullRequestComparison.open(io, 7)).export({ json: false });
	expect(output()).toContain("Pull request #7: 2 member rounds (snapshot 2).");
	expect(output()).toContain("# Comparison review: pull request");
	expect(output()).toContain(`Foreign: ${rejected.id}: ${rejected.reason}`);
});

it.each([true, false])(
	"includes all conclusively owned records after the saved members offline (json %s)",
	async (json) => {
		stores.candidates.splice(
			0,
			stores.candidates.length,
			old,
			{ ...added, publication: { repository: answer.repository, pullRequest: 7 } },
			{
				...removed,
				provenance: { kind: "pull-request", repository: answer.repository, pullRequest: 8 },
				publication: { repository: answer.repository, pullRequest: 7 },
			},
		);
		stores.histories.set(id, PullRequestRoundHistory.from([{ ...previous, members: [{ ...old, number: 1 }] }]));
		const original = JSON.stringify(stores.histories.get(id)!.versions);
		await (await PullRequestComparison.open(io, 7)).export({ json });
		if (json) {
			const exported = JSON.parse(output());
			expect(Object.keys(exported.comparisons)).toEqual([old.id, added.id]);
			expect(JSON.stringify(exported.history)).toBe(original);
			expect(exported.membership.members).toEqual([{ ...old, number: 1 }]);
		} else {
			expect(output()).toContain(`Membership as of ${at}`);
			expect(output()).toContain("Additional stored records are included beyond snapshot 1");
			expect(output()).not.toContain(`Round 2: ${added.id}`);
		}
		expect(JSON.stringify(stores.histories.get(id)!.versions)).toBe(original);
		expect(io.stderr).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('run melian compare "#7" to refresh'));
		expect(target.gitHubAccess).not.toHaveBeenCalled();
		expect(CompareHarness.open).not.toHaveBeenCalled();
	},
);

it("refuses a former Git member newly owned by another pull request before any output", async () => {
	stores.candidates.splice(0, stores.candidates.length, {
		...old,
		publication: { repository: answer.repository, pullRequest: 8 },
	});
	const history = JSON.stringify(stores.histories.get(id)!.versions);
	await expect(
		(await PullRequestComparison.open(io, 7)).export({ json: true, out: "/cannot-write/existing.json" }),
	).rejects.toThrowError(MembershipError);
	await expect((await PullRequestComparison.open(io, 7)).export({ json: false })).rejects.toThrow(
		'compare refresh "#7"',
	);
	expect(JSON.stringify(stores.histories.get(id)!.versions)).toBe(history);
	expect(io.stdout).not.toHaveBeenCalled();
	expect(io.stderr).not.toHaveBeenCalled();
});

it("does not warn for ownership candidates without an added record and retains a missing unreachable member", async () => {
	stores.entries.splice(0, stores.entries.length, stores.entries[1]!);
	stores.candidates.splice(0, stores.candidates.length, {
		...added,
		publication: { repository: answer.repository, pullRequest: 7 },
	});
	stores.histories.set(
		id,
		PullRequestRoundHistory.from([{ ...previous, members: [{ ...old, status: "unreachable", number: 1 }] }]),
	);
	await (await PullRequestComparison.open(io, 7)).export({ json: true });
	expect(Object.keys(JSON.parse(output()).comparisons)).toEqual([old.id]);
	expect(io.stderr).not.toHaveBeenCalled();
});

it("orders new owned attributed records by ID after saved members while keeping unknown additions out", async () => {
	stores.histories.set(id, PullRequestRoundHistory.from([{ ...previous, members: [{ ...old, number: 1 }] }]));
	stores.candidates.splice(
		0,
		stores.candidates.length,
		...[added, removed].map((candidate) => ({
			...candidate,
			publication: { repository: answer.repository, pullRequest: 7 },
		})),
	);
	const entries = [...stores.entries];
	for (const indices of [
		[0, 1, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0],
	]) {
		stores.entries.splice(0, stores.entries.length, ...indices.map((index) => entries[index]!));
		vi.mocked(io.stdout).mockClear();
		await (await PullRequestComparison.open(io, 7)).export({ json: true });
		expect(Object.keys(JSON.parse(output()).comparisons)).toEqual([old.id, removed.id, added.id]);
	}
	stores.candidates.splice(0, stores.candidates.length);
	vi.mocked(io.stdout).mockClear();
	await (await PullRequestComparison.open(io, 7)).export({ json: true });
	expect(Object.keys(JSON.parse(output()).comparisons)).toEqual([old.id]);
});

it("preserves own-store compatibility without letting the filename override foreign ownership", async () => {
	stores.histories.clear();
	stores.entries.splice(0, stores.entries.length, ...stores.entries.map((entry) => ({ ...entry, changeset: id })));
	stores.candidates.splice(
		0,
		stores.candidates.length,
		{
			...added,
			provenance: { kind: "pull-request", repository: answer.repository, pullRequest: 8 },
			publication: { repository: answer.repository, pullRequest: 7 },
		},
		{ ...removed, publication: { repository: answer.repository, pullRequest: 7 } },
	);
	await (await PullRequestComparison.open(io, 7)).export({ json: true });
	const exported = JSON.parse(output());
	expect(Object.keys(exported.comparisons)).toEqual([old.id, removed.id]);
	expect(exported.membership).toBeUndefined();
	expect(exported.history).toBeUndefined();
	expect(io.stderr).not.toHaveBeenCalled();
});

it.each([true, false])(
	"includes newly eligible raw records without a new attributed comparison (json %s)",
	async (json) => {
		const own = { ...stores.entries[0]!, changeset: id, round: undefined, unattributed: "own-key" };
		const raw = { ...stores.entries[0]!, round: undefined, unattributed: "range-key" };
		const foreignRaw = { ...stores.entries[2]!, round: undefined, unattributed: "foreign-key" };
		stores.entries.splice(0, stores.entries.length, own, raw, foreignRaw);
		stores.candidates.splice(0, stores.candidates.length, {
			...added,
			publication: { repository: answer.repository, pullRequest: 7 },
		});
		stores.histories.set(id, PullRequestRoundHistory.from([{ ...previous, members: [] }]));
		await (await PullRequestComparison.open(io, 7)).export({ json });
		if (json) {
			const exported = JSON.parse(output());
			expect(exported.comparisons).toEqual({});
			expect(Object.keys(exported.unattributed)).toEqual(["own-key", "range-key"]);
			expect(exported.membership.members).toEqual([]);
			expect(exported.history).toHaveLength(1);
		} else expect(output()).toContain("Additional records have no snapshot numbers");
		expect(io.stderr).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("Additional stored records are included beyond snapshot 1"),
		);
	},
);

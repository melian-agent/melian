import { Comparison, PullRequestMembership, pullRequestChangesetId, type RoundMembership } from "@melian-agent/core";
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

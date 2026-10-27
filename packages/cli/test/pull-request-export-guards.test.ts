import { Comparison, ComparisonExport, type MembershipCandidate, pullRequestChangesetId } from "@melian-agent/core";
import { PullRequestRoundHistory } from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Io } from "../src/commands.ts";
import { ComparisonStores } from "../src/comparison-stores.ts";
import { PullRequestComparison } from "../src/pull-request-comparison.ts";
import * as repository from "../src/repository.ts";

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
const id = pullRequestChangesetId("github", answer.repository, answer.number);
const range = "range-aaaaaaaaaaaaaaaa";
const at = "2026-10-27T00:00:00Z";
let io: Io;
let stores: ComparisonStores;
const output = () =>
	vi
		.mocked(io.stdout)
		.mock.calls.map(([text]) => text)
		.join("");
beforeEach(() => {
	io = { cwd: "/repo", env: {}, color: false, stdout: vi.fn(), stderr: vi.fn() };
	stores = { repoRoot: "/repo", directory: "/state", candidates: [], entries: [], histories: new Map() };
	vi.spyOn(ComparisonStores, "read").mockResolvedValue(stores);
	vi.spyOn(repository, "git").mockResolvedValue("git@github.com:owner/repo.git");
});
afterEach(() => vi.restoreAllMocks());

it.each(["member", "unreachable"] as const)(
	"retains saved %s range-store raw records with unknown current ownership and no stale warning",
	async (status) => {
		const candidate: MembershipCandidate = {
			id: `${range}.r1`,
			base: answer.base,
			head: answer.head,
			provenance: { kind: "range" },
		};
		const history = PullRequestRoundHistory.from([]);
		history.refresh(
			answer,
			[{ ...candidate, status: "member", reason: "exact pull request merge base" }],
			"",
			at,
			false,
		);
		if (status === "unreachable")
			history.refresh(answer, [{ ...candidate, status, reason: "head unavailable after fetch" }], "", at, false);
		stores.histories.set(id, history);
		stores.candidates.push(candidate);
		const comparison = Comparison.of(candidate);
		const key = `${answer.base}..${answer.head}`;
		stores.entries.push({ changeset: range, unattributed: key, comparison });
		await (await PullRequestComparison.open(io, 7)).export({ json: true });
		const exported = JSON.parse(output());
		expect(exported.comparisons).toEqual({});
		expect(exported.unattributed).toEqual({ [key]: comparison.toJSON() });
		expect(exported.membership).toEqual(history.current());
		expect(exported.history).toEqual(history.versions);
		expect(io.stderr).not.toHaveBeenCalled();
		const raw = stores.entries[0]!;
		const attributed = { changeset: range, round: candidate.id, comparison };
		const expected = new ComparisonExport([raw, attributed], "#7", "https://github.com/owner/repo/pull/7").render();
		for (const entries of [
			[raw, attributed],
			[attributed, raw],
		]) {
			stores.entries.splice(0, stores.entries.length, ...entries);
			vi.mocked(io.stdout).mockClear();
			await (await PullRequestComparison.open(io, 7)).export({ json: false });
			expect(output()).toContain(expected);
			expect(io.stderr).not.toHaveBeenCalled();
		}
	},
);

it("does not call own-store raw compatibility records additions beyond a snapshot", async () => {
	const history = PullRequestRoundHistory.from([]);
	history.refresh(answer, [], "", at, false);
	stores.histories.set(id, history);
	stores.candidates.push({ id: `${id}.r1`, base: answer.base, head: answer.head, provenance: { kind: "range" } });
	stores.entries.push({ changeset: id, unattributed: "raw-key", comparison: Comparison.of(answer) });
	await (await PullRequestComparison.open(io, 7)).export({ json: true });
	expect(Object.keys(JSON.parse(output()).unattributed)).toEqual(["raw-key"]);
	expect(io.stderr).not.toHaveBeenCalled();
});

it("warns when a later owned comparison is in the same pull store as a saved member", async () => {
	const history = PullRequestRoundHistory.from([]);
	const first = {
		id: `${id}.r1`,
		base: answer.base,
		head: answer.head,
		publication: { repository: answer.repository, pullRequest: 7 },
	};
	const second = { ...first, id: `${id}.r2` };
	history.refresh(answer, [{ ...first, status: "member", reason: "stored pull request ownership" }], "", at, false);
	stores.histories.set(id, history);
	stores.candidates.push(first, second);
	stores.entries.push(
		...[first, second].map((round) => ({ changeset: id, round: round.id, comparison: Comparison.of(round) })),
	);
	for (const json of [true, false]) {
		vi.mocked(io.stdout).mockClear();
		vi.mocked(io.stderr).mockClear();
		await (await PullRequestComparison.open(io, 7)).export({ json });
		if (json) {
			const exported = JSON.parse(output());
			expect(Object.keys(exported.comparisons)).toEqual([first.id, second.id]);
			expect(exported.history).toEqual(history.versions);
		} else expect(output()).toContain(`Membership as of ${at}`);
		expect(io.stderr).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("Additional stored records are included beyond snapshot 1"),
		);
	}
});

it("keeps saved owned members in mint-time order when store scan order differs", async () => {
	const history = PullRequestRoundHistory.from([]);
	const first = {
		id: "range-bbbbbbbbbbbbbbbb.r1",
		base: answer.base,
		head: answer.head,
		publication: { repository: answer.repository, pullRequest: 7 },
		mintedAt: "2026-10-26T00:00:00Z",
	};
	const second = { ...first, id: "range-aaaaaaaaaaaaaaaa.r1", mintedAt: "2026-10-26T01:00:00Z" };
	const third = { ...first, id: "range-cccccccccccccccc.r1", mintedAt: "2026-10-26T02:00:00Z" };
	history.refresh(
		answer,
		[first, second].map((round) => ({ ...round, status: "member", reason: "stored pull request ownership" })),
		"",
		at,
		false,
	);
	stores.histories.set(id, history);
	stores.candidates.push(second, first, third);
	stores.entries.push(
		...[second, first, third].map((round) => ({
			changeset: round.id.split(".")[0]!,
			round: round.id,
			comparison: Comparison.of(round),
		})),
	);
	await (await PullRequestComparison.open(io, 7)).export({ json: true });
	expect(Object.keys(JSON.parse(output()).comparisons)).toEqual([first.id, second.id, third.id]);
});

it("keeps pre-snapshot mint order instead of sorting owned round IDs lexically", async () => {
	const first = {
		id: `${id}.r2`,
		base: answer.base,
		head: answer.head,
		publication: { repository: answer.repository, pullRequest: 7 },
		mintedAt: "2026-10-26T00:00:00Z",
	};
	const second = { ...first, id: `${id}.r10`, mintedAt: "2026-10-26T01:00:00Z" };
	stores.candidates.push(first, second);
	stores.entries.push(
		...[first, second].map((round) => ({ changeset: id, round: round.id, comparison: Comparison.of(round) })),
	);
	await (await PullRequestComparison.open(io, 7)).export({ json: true });
	expect(Object.keys(JSON.parse(output()).comparisons)).toEqual([first.id, second.id]);
	expect(io.stderr).not.toHaveBeenCalled();
});

import type { PullRequestRoundHeads, RoundMembership } from "@melian-agent/core";
import { PullRequestRoundHistory } from "@melian-agent/pipeline";
import { expect, it } from "vitest";

const answer: PullRequestRoundHeads = {
	repository: { owner: "owner", name: "repo" },
	number: 7,
	base: "a".repeat(40),
	head: "b".repeat(40),
	merge: null,
	commits: ["b".repeat(40)],
	forcePushes: [],
	associated: {},
};
const at = "2026-10-26T01:00:00Z";
const member: RoundMembership = {
	id: "range-0123456789abcdef.r1",
	base: answer.base,
	head: answer.head,
	mintedAt: at,
	status: "member",
	reason: "owned pull request round",
};

it("preserves precise missing-head and missing-storage reasons on retained members", () => {
	const second = { ...member, id: "range-0123456789abcdef.r2" };
	const history = PullRequestRoundHistory.from([]);
	history.refresh(answer, [member, second], "Alice", at, false);
	const missing = {
		...member,
		status: "foreign" as const,
		missingCommit: member.head,
		reason: "head unavailable after fetch",
	};
	const next = history.refresh(answer, [missing], "Bob", at, false);
	expect(next.members).toEqual([
		{ ...member, status: "unreachable", reason: missing.reason, number: 1 },
		{ ...second, status: "unreachable", reason: "storage or round is missing", number: 2 },
	]);
});
it("orders every legacy and minted pair independently of incoming storage order", () => {
	const legacy = { ...member, mintedAt: undefined };
	const ordered: RoundMembership[] = [
		{ ...legacy, id: "range-0123456789abcdef.kffffffffffffffff", date: 0 },
		{ ...legacy, id: "range-0123456789abcdef.kbbbbbbbbbbbbbbbb", date: 50 },
		{ ...legacy, id: "range-0123456789abcdef.kcccccccccccccccc", date: 50 },
		{ ...legacy, id: "range-0123456789abcdef.kaaaaaaaaaaaaaaaa", date: 100 },
		{ ...legacy, id: "range-0123456789abcdef.k0000000000000000" },
		{ ...member, id: "range-0123456789abcdef.r4", mintedAt: "2026-10-25T01:00:00Z" },
		{ ...member, id: "range-0123456789abcdef.r3", mintedAt: "2026-10-25T02:00:00Z" },
		{ ...member, id: "range-0123456789abcdef.r2", mintedAt: "2026-10-25T02:00:00Z" },
	];
	// The equal-time minted pair is ordered by round ID.
	[ordered[6], ordered[7]] = [ordered[7]!, ordered[6]!];
	for (let left = 0; left < ordered.length; left++)
		for (let right = left + 1; right < ordered.length; right++) {
			for (const input of [
				[ordered[left]!, ordered[right]!],
				[ordered[right]!, ordered[left]!],
			]) {
				const snapshot = PullRequestRoundHistory.from([]).refresh(answer, input, "Alice", at, false);
				expect(snapshot.members.map(({ id, number }) => ({ id, number }))).toEqual([
					{ id: ordered[left]!.id, number: 1 },
					{ id: ordered[right]!.id, number: 2 },
				]);
			}
		}
});
it("lists every rejected member and partitions two accepted removals from new ambiguous and unattributed rounds", () => {
	const second = { ...member, id: "range-0123456789abcdef.r2" };
	const third = { ...member, id: "range-0123456789abcdef.r3" };
	const history = PullRequestRoundHistory.from([]);
	history.refresh(answer, [member, second, third], "Alice", at, false);
	const rejected = [
		{ ...member, status: "ambiguous" as const, reason: "another pull request", otherPullRequests: [8] },
		{ ...second, status: "unattributed" as const, reason: "GitHub no longer names this head" },
	];
	const ambiguous = { ...third, id: "range-0123456789abcdef.r4", status: "ambiguous" as const };
	const unattributed = { ...third, id: "range-0123456789abcdef.r5", status: "unattributed" as const };
	const foreign = { ...third, id: "range-0123456789abcdef.r6", status: "foreign" as const };
	const facts = [...rejected, third, ambiguous, unattributed, foreign];
	expect(() => history.refresh(answer, facts, "Bob", at, false)).toThrow(
		`${member.id}: another pull request; ${second.id}: GitHub no longer names this head`,
	);
	const snapshot = history.refresh(answer, facts, "Bob", at, true);
	expect(snapshot.foreign).toEqual([...rejected.map((round) => ({ ...round, status: "foreign" })), foreign]);
	expect(snapshot.ambiguous).toEqual([ambiguous]);
	expect(snapshot.unattributed).toEqual([unattributed]);
	expect(snapshot.audit).toEqual(rejected.map((round) => ({ round: round.id, reason: round.reason, by: "Bob", at })));
});

it("does not warn about a force push whose before commit is present", () => {
	const snapshot = PullRequestRoundHistory.from([]).refresh(
		{ ...answer, forcePushes: [{ before: answer.base, after: answer.head }] },
		[member],
		"Alice",
		at,
		false,
	);
	expect(snapshot.warnings).toEqual([]);
});

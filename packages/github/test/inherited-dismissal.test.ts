import {
	Adjudication,
	defaultConfig,
	dismissalVersion,
	Finding,
	type FindingInput,
	type LedgerRound,
	Rendering,
	type Verdict,
} from "@melian-agent/core";
import { Ledger, marker, ReviewComment, renderResolvedReply, renderReviewBody } from "@melian-agent/github";
import { describe, expect, it } from "vitest";

// Issue #342: an inherited dismissal reads as inherited from its root wherever a dismissal shows, and never as the
// work of the root's dismisser; a person's own dismissal reads as before.
const base = "c".repeat(40);
const head = "a".repeat(40);
const short = head.slice(0, 12);
const secret = "11".repeat(32);
const links = { web: "https://github.com/melian-agent/example" };
const root = "0123456789abcdef";
const dismisser = "Tal <tal@melian.invalid>";

const input = (file: string): FindingInput => ({
	rule: "null-dereference",
	message: "The manager may be absent.",
	file,
	startLine: 3,
	snippet: "user.manager.name",
	occurrence: 0,
	cause: "introduced",
	severity: "P2",
	resolution: "acknowledge",
	explanation: { what: "The manager may be absent.", whyHere: "The change drops the check.", whatToDo: "Check it." },
	source: { check: "lens.correctness", version: "1" },
});

const dismissed = (file: string, dismissal: NonNullable<Finding["properties"]["dismissal"]>) => {
	const created = Finding.create({ ...input(file), status: "dismissed" });
	return Finding.from({ ...created.toJSON(), properties: { ...created.properties, dismissal } });
};

const human = dismissed("src/human.ts", {
	by: dismisser,
	reason: "Every user here has a manager.",
	at: "2026-11-01T00:00:00Z",
});
const inherited = dismissed("src/inherited.ts", {
	by: "melian",
	reason: "The loader sets every manager.",
	at: "2026-11-02T00:00:00Z",
	inheritedFrom: root,
});

const verdict: Verdict = new Adjudication({
	findings: [human, inherited],
	manifest: [],
	checks: [],
	config: defaultConfig,
}).adjudicate();

// Both were posted in a thread of their own at an earlier head, so this one resolves each with a reply.
const plan = verdict.publication(
	Object.fromEntries(
		[human, inherited].map((finding, index) => [
			finding.id,
			{
				ruleId: "null-dereference",
				path: finding.properties.path,
				line: 3,
				revision: "e".repeat(40),
				thread: String(100 + index),
			},
		]),
	),
	{},
	head,
);
const closed = (finding: Finding) => plan.resolved.find((each) => each.id === finding.id)!;

const humanLine = `Dismissed by ${dismisser} at 2026-11-01T00:00:00Z: Every user here has a manager.`;
const inheritedLine = `Dismissed, inherited from ${root}, at 2026-11-02T00:00:00Z: The loader sets every manager.`;

const terminal = (finding: Finding, line: string, file: string) =>
	[
		`${file}`,
		"",
		"  P2 | Needs acknowledgement | Correctness | Not verified | New in this change",
		`    ${line}`,
		"  The manager may be absent.",
		"    Why here: The change drops the check.",
		"    What to do: Check it.",
		`    Rule null-dereference | Line 3 | Finding ${finding.id} | Status dismissed`,
	].join("\n");

describe("an inherited dismissal beside a person's", () => {
	it("reads as inherited from the root in the terminal, and names only the person's dismisser", () => {
		const text = verdict.render(new Rendering({ all: true, ids: true }));
		expect(text).toBe(
			[
				"Verdict: passed",
				"",
				`melian/review: success (0 findings, 2 dismissed, 1 inherited from ${root}).`,
				"",
				"Dismissed: 2 findings",
				"",
				terminal(human, humanLine, "src/human.ts"),
				"",
				terminal(inherited, inheritedLine, "src/inherited.ts"),
				"",
				"No findings.",
				"",
			].join("\n"),
		);
		expect(text.split(dismisser)).toHaveLength(2);
	});

	it("says so in the published status", () => {
		expect(verdict.reviewStatus()).toEqual({
			state: "success",
			description: `0 findings, 2 dismissed, 1 inherited from ${root}`,
		});
		const alone = new Adjudication({ findings: [human], manifest: [], checks: [], config: defaultConfig });
		expect(alone.adjudicate().reviewStatus()).toEqual({ state: "success", description: "0 findings, 1 dismissed" });
		// A verdict stored before dismissals kept their record holds a dismissed finding with none.
		const legacy = Finding.create({ ...input("src/legacy.ts"), status: "dismissed" });
		const stored = new Adjudication({ findings: [legacy], manifest: [], checks: [], config: defaultConfig });
		expect(stored.adjudicate().reviewStatus()).toEqual({ state: "success", description: "0 findings, 1 dismissed" });
	});

	it("names each root once, and as many as fit in what GitHub's status leaves beside the reviewed base", () => {
		const status = (roots: readonly string[], people = 0) => {
			const findings = [
				...roots.map((from, index) =>
					dismissed(`src/inherited-${index}.ts`, { ...inherited.properties.dismissal!, inheritedFrom: from }),
				),
				...Array.from({ length: people }, (_, index) =>
					dismissed(`src/human-${index}.ts`, human.properties.dismissal!),
				),
			];
			return new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig })
				.adjudicate()
				.reviewStatus();
		};
		const id = (index: number) => index.toString(16).padStart(16, "0");
		const many = (count: number, distinct: number) =>
			Array.from({ length: count }, (_, index) => id(index % distinct));
		expect(status([id(1), id(1), id(2)])).toEqual({
			state: "success",
			description: `0 findings, 3 dismissed, 3 inherited from ${id(1)}, ${id(2)}`,
		});
		// Three roots would take 94 characters, one past the 93 that "; base <40 hex>" leaves of GitHub's 140.
		expect(status([id(1), id(2), id(3)])).toEqual({
			state: "success",
			description: `0 findings, 3 dismissed, 3 inherited from ${id(1)}, ${id(2)} and 1 more`,
		});
		const atBound = status(many(1000, 11)).description;
		expect(atBound).toBe(`0 findings, 1000 dismissed, 1000 inherited from ${id(0)}, ${id(1)} and 9 more`);
		expect(atBound).toHaveLength(93);
		// The same two roots and "and 10 more" would take 94, so one root is named and the rest counted.
		expect(status(many(1000, 12)).description).toBe(
			`0 findings, 1000 dismissed, 1000 inherited from ${id(0)} and 11 more`,
		);
		expect(status([id(1)], 9).description).toBe(`0 findings, 10 dismissed, 1 inherited from ${id(1)}`);
	});

	it("says so in the reply in each thread, and names no dismisser in either", () => {
		const reply = (finding: Finding) =>
			marker(head, "resolved", finding.id, secret, { dismissal: dismissalVersion(finding.properties.dismissal!) });
		expect(renderResolvedReply(closed(human), head, secret)).toBe(
			`${reply(human)}\nDismissed at \`${short}\`: Every user here has a manager.`,
		);
		expect(renderResolvedReply(closed(inherited), head, secret)).toBe(
			`${reply(inherited)}\nDismissed at \`${short}\`, inherited from \`${root}\`: The loader sets every manager.`,
		);
	});

	it("says so in the review body's fold and in its list of findings dismissed since the last review", () => {
		const body = renderReviewBody(
			{
				pullRequest: 7,
				revision: head,
				base,
				fingerprint: verdict.fingerprint(),
				round: 1,
				verdict,
				findings: [],
				stillOpen: 0,
				resolved: [closed(human), closed(inherited)].map(({ thread: _, ...rest }) => rest),
				secret,
			},
			links,
		);
		expect(body).toBe(
			[
				`${marker(head, "verdict", verdict.fingerprint(), secret, { round: 1 })}\nMelian reviewed \`${short}\`: **passed**.`,
				"No findings need attention.",
				`<details>\n<summary>Verification and status</summary>\n\nmelian/review: success (0 findings, 2 dismissed, 1 inherited from ${root}).\n\n</details>`,
				[
					"<details>",
					"<summary>2 dismissed, 2 reasons</summary>",
					"",
					"Dismissals attested by this publication:",
					"",
					`- \`${human.id}\` \`null-dereference\` in \`src/human.ts\`: Every user here has a manager.`,
					`- \`${inherited.id}\` \`null-dereference\` in \`src/inherited.ts\`, inherited from \`${root}\`: The loader sets every manager.`,
					"",
					"</details>",
				].join("\n"),
				[
					"Dismissed since the last review:",
					"",
					"- `null-dereference` in `src/human.ts` line 3: Every user here has a manager.",
					`- \`null-dereference\` in \`src/inherited.ts\` line 3, inherited from \`${root}\`: The loader sets every manager.`,
				].join("\n"),
			].join("\n\n"),
		);
		expect(body).not.toContain("Tal");
	});

	it("keeps an inherited dismissal apart from a person's that gives the same reason", () => {
		const same = dismissed("src/inherited.ts", {
			...inherited.properties.dismissal!,
			reason: human.properties.dismissal!.reason,
		});
		const both = new Adjudication({ findings: [human, same], manifest: [], checks: [], config: defaultConfig });
		const decided = both.adjudicate();
		const body = renderReviewBody(
			{
				pullRequest: 7,
				revision: head,
				base,
				fingerprint: decided.fingerprint(),
				round: 1,
				verdict: decided,
				findings: [],
				stillOpen: 0,
				resolved: [],
				secret,
			},
			links,
		);
		expect(body.match(/<details>\n<summary>2 dismissed[\s\S]*?<\/details>/)?.[0]).toBe(
			[
				"<details>",
				"<summary>2 dismissed, 1 reason</summary>",
				"",
				"Dismissals attested by this publication:",
				"",
				"- Every user here has a manager.",
				`  - \`${human.id}\` \`null-dereference\` in \`src/human.ts\``,
				`  - \`${same.id}\` \`null-dereference\` in \`src/inherited.ts\`, inherited from \`${root}\``,
				"",
				"</details>",
			].join("\n"),
		);
	});

	it("says so in the ledger's dismissals and closed findings", () => {
		const round: LedgerRound = {
			base,
			head,
			round: 1,
			verdict: verdict.toJSON(),
			resolved: [human, inherited].map((finding) => ({
				id: finding.id,
				ruleId: "null-dereference",
				path: finding.properties.path,
				line: 3,
				commit: head,
				reason: finding.properties.dismissal!.reason,
				...(finding === inherited ? { inheritedFrom: root } : {}),
			})),
		};
		round.resolved.push({ id: "fedcba9876543210", ruleId: "fixed", path: "src/fixed.ts", line: 1, commit: head });
		const text = Ledger.from(
			verdict,
			{ rounds: [round] },
			{ pullRequest: 7, secret, walkthrough: { enabled: false, collapsed: true, diagrams: false } },
		).render(links);
		const section = (heading: string) => text.split("\n\n### ").find((part) => part.startsWith(heading));
		expect(section("Dismissals")).toBe(
			[
				"Dismissals",
				`- ${human.id} \`null-dereference\`: Every user here has a manager.`,
				`- ${inherited.id} \`null-dereference\`, inherited from \`${root}\`: The loader sets every manager.`,
			].join("\n\n"),
		);
		expect(section("Closed findings")?.replace(/\n\n<!--[\s\S]*$/, "")).toBe(
			[
				"Closed findings",
				`- ${human.id}: Dismissed: Every user here has a manager.`,
				`- ${inherited.id}: Dismissed, inherited from \`${root}\`: The loader sets every manager.`,
				`- fedcba9876543210: Addressed in commit ${short}`,
			].join("\n\n"),
		);
		expect(text).not.toContain("Tal");
	});
});

describe("a restatement proposed as likely the same as a dismissed finding", () => {
	const created = Finding.create({ ...input("src/floor.ts"), source: { check: "lens.tests", version: "1" } });
	const proposed = Finding.from({
		...created.toJSON(),
		properties: { ...created.properties, likelyDismissedAs: { id: root } },
	});
	const note = `Likely the same as dismissed finding ${root}. To accept the match, run melian dismiss <range|#pr> ${proposed.id} --reason <text>.`;

	it("names the root and the command that accepts it in the terminal", () => {
		expect(proposed.render(new Rendering({ ids: true }))).toBe(
			[
				"  P2 | Needs acknowledgement | Tests | Not verified | New in this change",
				`    ${note}`,
				"  The manager may be absent.",
				"    Why here: The change drops the check.",
				"    What to do: Check it.",
				`    Rule null-dereference | Line 3 | Finding ${proposed.id} | Status new`,
			].join("\n"),
		);
	});

	it("names them in the inline comment", () => {
		expect(ReviewComment.from(proposed).render({ revision: head, base, links, secret, emoji: false })).toBe(
			[
				marker(head, "finding", proposed.id, secret),
				`[\`src/floor.ts\` line 3](https://github.com/melian-agent/example/blob/${head}/src/floor.ts#L3)`,
				"",
				"P2 | Needs acknowledgement | Tests | Not verified | New in this change",
				"",
				`Likely the same as dismissed finding ${root}. To accept the match, run melian dismiss &lt;range\\|\\#pr&gt; ${proposed.id} --reason &lt;text&gt;.`,
				"",
				"**The manager may be absent.**",
				"",
				"**Why here:** The change drops the check.",
				"",
				"**What to do:** Check it.",
				"",
				`Rule \`null-dereference\` | Finding \`${proposed.id}\``,
			].join("\n"),
		);
	});

	it("names them in the ledger's line for the finding", () => {
		const decided = new Adjudication({ findings: [proposed], manifest: [], checks: [], config: defaultConfig });
		const open = decided.adjudicate();
		const round: LedgerRound = { base, head, round: 1, verdict: open.toJSON(), resolved: [] };
		const text = Ledger.from(
			open,
			{ rounds: [round] },
			{ pullRequest: 7, secret, walkthrough: { enabled: false, collapsed: true, diagrams: false } },
		).render(links);
		expect(text.split("\n").filter((line) => line.startsWith(`- ${proposed.id}:`))).toEqual([
			`- ${proposed.id}: \`src/floor.ts\`:3 — \`null-dereference\` (acknowledge): The manager may be absent. Likely the same as dismissed finding ${root}. To accept the match, run melian dismiss &lt;range\\|\\#pr&gt; ${proposed.id} --reason &lt;text&gt;.`,
		]);
	});

	it("shows nothing of the kind for a finding with no likely root", () => {
		expect(created.render(new Rendering({ ids: true }))).not.toContain("Likely the same");
		expect(created.likelyDismissalNotes()).toEqual([]);
		expect(proposed.likelyDismissalNotes()).toEqual([note]);
	});
});

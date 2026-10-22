import {
	Adjudication,
	type ChangedFile,
	type CheckRecord,
	defaultConfig,
	Finding,
	type FindingInput,
	Revision,
	Verdict,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const finding = (input: Partial<FindingInput>): Finding =>
	Finding.create({ ...evalInput, trigger: undefined, startColumn: undefined, endColumn: undefined, ...input });

const hunk = (file: string, index: number, newStart: number, newLines: number) => ({
	file,
	index,
	oldStart: newStart,
	oldLines: 1,
	newStart,
	newLines,
	header: "",
	text: "",
});

const changed = (path: string, hunks: ReturnType<typeof hunk>[], extra: Partial<ChangedFile> = {}): ChangedFile => ({
	status: "modified",
	path,
	binary: false,
	hunks,
	...extra,
});

describe("Revision.diffLines", () => {
	it("lists each file's added lines at head, and nothing for deletions, binaries, or deleted files", () => {
		const files = [
			changed("src/run.ts", [
				hunk("src/run.ts", 0, 3, 2),
				hunk("src/run.ts", 1, 10, 0),
				hunk("src/run.ts", 2, 20, 1),
			]),
			changed("src/gone.ts", [hunk("src/gone.ts", 0, 0, 0)], { status: "deleted" }),
			changed("logo.png", [], { binary: true }),
			changed("only-deletes.ts", [hunk("only-deletes.ts", 0, 4, 0)]),
		];
		expect(Revision.from({ base: "a".repeat(40), head: "b".repeat(40), files: files }).diffLines()).toEqual({
			"src/run.ts": [
				[3, 4],
				[20, 20],
			],
		});
	});
});

describe("Finding.place", () => {
	const lines = {
		"src/run.ts": [
			[10, 14],
			[30, 30],
		] as [number, number][],
	};

	it("posts a finding inside the diff on its own lines", () => {
		expect(finding({ startLine: 12, endLine: 12 }).place(lines)).toEqual({
			kind: "lines",
			startLine: 12,
			line: 12,
		});
		expect(finding({ startLine: 11, endLine: 13 }).place(lines)).toEqual({
			kind: "lines",
			startLine: 11,
			line: 13,
		});
	});

	it("clips a finding that runs past a hunk to the changed lines", () => {
		expect(finding({ startLine: 8, endLine: 11 }).place(lines)).toEqual({
			kind: "lines",
			startLine: 10,
			line: 11,
		});
	});

	it("anchors a finding outside the diff to the nearest changed line of its file", () => {
		expect(finding({ startLine: 25, endLine: 25 }).place(lines)).toEqual({ kind: "nearest", line: 30 });
		expect(finding({ startLine: 2, endLine: 2 }).place(lines)).toEqual({ kind: "nearest", line: 10 });
		expect(finding({ startLine: 20, endLine: 20 }).place(lines)).toEqual({ kind: "nearest", line: 14 });
	});

	it("puts a finding in a file the change does not touch in the body", () => {
		expect(finding({ file: "src/other.ts" }).place(lines)).toEqual({ kind: "body" });
	});
});

function verdictOf(findings: readonly Finding[], checks: readonly CheckRecord[] = []): Verdict {
	return new Adjudication({
		findings,
		manifest: checks.map((check) => check.name),
		checks,
		config: defaultConfig,
	}).adjudicate();
}

describe("Verdict.publication", () => {
	const head = "b".repeat(40);
	const lines = { "src/run.ts": [[12, 12]] as [number, number][] };
	const open = finding({ snippet: "eval(input)" });
	const fixed = finding({ snippet: "eval(body)", startLine: 40, endLine: 40 });
	const fresh = finding({ snippet: "eval(query)", startLine: 50, endLine: 50, file: "src/api.ts" });
	const posted = (thread?: string) => ({
		ruleId: "no-eval",
		path: "src/run.ts",
		line: 12,
		revision: "a".repeat(40),
		...(thread === undefined ? {} : { thread }),
	});

	it("posts new findings, keeps open ones without reposting, and resolves the ones that went away", () => {
		const previous = { [open.properties.id]: posted("101"), [fixed.properties.id]: posted("102") };
		const plan = verdictOf([open, fresh]).publication(previous, lines, head);

		expect(plan.post.map((each) => [each.finding.properties.id, each.placement])).toEqual([
			[fresh.properties.id, { kind: "body" }],
		]);
		expect(plan.stillOpen).toEqual([open.properties.id]);
		expect(plan.resolved).toEqual([{ id: fixed.properties.id, ...posted("102") }]);
		expect(plan.open).toEqual({
			[open.properties.id]: posted("101"),
			[fresh.properties.id]: { ruleId: "no-eval", path: "src/api.ts", line: 50, revision: head },
		});
	});

	// Step 27, "Merge by shared cause": a later push can merge what an earlier one posted alone.
	it("keeps the thread of a report posted alone open once a later revision merges it under another", () => {
		const eslint = finding({ rule: "detect-eval", severity: "P3", source: { check: "static.eslint" } });
		const previous = { [eslint.properties.id]: posted("104") };
		const verdict = verdictOf([open, eslint]);
		expect(verdict.findings.block.map((each) => each.properties.alsoReportedAs?.map((member) => member.id))).toEqual([
			[eslint.properties.id],
		]);

		const plan = verdict.publication(previous, lines, head);

		expect(plan.resolved).toEqual([]);
		expect(plan.open[eslint.properties.id]).toEqual(posted("104"));
	});

	it("holds every live finding with its live members, never a dismissed report it lists", () => {
		const eslint = finding({ rule: "detect-eval", severity: "P3", source: { check: "static.eslint" } });
		const dismissal = { by: "Tal <tal@melian.invalid>", reason: "Constant input.", at: "2026-10-04T00:00:00Z" };
		const gone = Finding.from({
			...finding({ rule: "eval-call", source: { check: "lens.security-two" } }).toJSON(),
			properties: {
				...finding({ rule: "eval-call", source: { check: "lens.security-two" } }).properties,
				status: "dismissed",
				dismissal,
			},
		});
		const verdict = verdictOf([open, eslint, gone, fresh]);
		const expected = [open.properties.id, eslint.properties.id, fresh.properties.id].sort();
		expect([...verdict.held()].sort()).toEqual(expected);
		// As a verdict recorded before Melian marked a dismissed report it lists: the report is named, unmarked.
		const stored = verdict.toJSON();
		const unmarked = Verdict.from({
			...stored,
			findings: {
				...stored.findings,
				block: stored.findings.block.map((each) => ({
					...each,
					properties: {
						...each.properties,
						alsoReportedAs: each.properties.alsoReportedAs?.map(({ dismissed: _, ...other }) => other),
					},
				})),
			},
		});
		expect([...unmarked.held()].sort()).toEqual(expected);
	});

	it("resolves an open finding that was dismissed, with its dismissal, and never posts a dismissed one", () => {
		const dismissal = { by: "Tal <tal@melian.invalid>", reason: "Constant input.", at: "2026-10-04T00:00:00Z" };
		const as = (each: Finding): Finding =>
			Finding.from({ ...each.toJSON(), properties: { ...each.properties, status: "dismissed", dismissal } });
		const plan = verdictOf([as(fixed), as(fresh)]).publication({ [fixed.properties.id]: posted("102") }, lines, head);

		expect(plan).toMatchObject({ post: [], stillOpen: [] });
		expect(plan.resolved).toEqual([{ id: fixed.properties.id, ...posted("102"), dismissal }]);
		expect(plan.open).toEqual({});
	});

	it("resolves a posted finding with the dismissal of the finding it was merged into, not as gone", () => {
		const dismissal = { by: "Tal <tal@melian.invalid>", reason: "Constant input.", at: "2026-10-04T00:00:00Z" };
		const member = finding({
			snippet: "eval(body)",
			startLine: 40,
			endLine: 40,
			rule: "code-injection",
			severity: "P2",
			source: { check: "lens.contracts" },
		});
		const dismissed = [fixed, member].map(
			(each): Finding =>
				Finding.from({ ...each.toJSON(), properties: { ...each.properties, status: "dismissed", dismissal } }),
		);
		const verdict = verdictOf(dismissed);
		expect(verdict.dismissed.map((each) => each.properties.id)).toEqual([fixed.properties.id]);

		const plan = verdict.publication({ [member.properties.id]: posted("103") }, lines, head);

		expect(plan.resolved).toEqual([{ id: member.properties.id, ...posted("103"), dismissal }]);
		expect(plan.open).toEqual({});
	});

	it("maps a merged report dismissed on its own to its own dismissal, not the one of the finding it speaks through", () => {
		const own = { by: "Tal <tal@melian.invalid>", reason: "Constant input.", at: "2026-10-04T00:00:00Z" };
		const later = { by: "Tal <tal@melian.invalid>", reason: "Sandboxed.", at: "2026-10-04T01:00:00Z" };
		const member = finding({
			snippet: "eval(body)",
			startLine: 40,
			endLine: 40,
			rule: "code-injection",
			severity: "P2",
			source: { check: "lens.contracts" },
		});
		const dismissed = [
			Finding.from({
				...fixed.toJSON(),
				properties: { ...fixed.properties, status: "dismissed", dismissal: later },
			}),
			Finding.from({
				...member.toJSON(),
				properties: { ...member.properties, status: "dismissed", dismissal: own },
			}),
		];
		const verdict = verdictOf(dismissed);
		expect(verdict.dismissed.map((each) => each.properties.id)).toEqual([fixed.properties.id]);

		const plan = verdict.publication({ [member.properties.id]: posted("103") }, lines, head);

		expect(plan.dismissals).toEqual({ [fixed.properties.id]: later, [member.properties.id]: own });
		expect(plan.resolved).toEqual([{ id: member.properties.id, ...posted("103"), dismissal: own }]);
	});

	it("keeps a finding that turned silent on its thread, so it never gets a second one", () => {
		const quiet = finding({ severity: "nit" });
		const loud = finding({ severity: "P2" });
		const previous = { [loud.properties.id]: posted("101") };

		const silent = verdictOf([quiet]).publication(previous, lines, head);
		const again = verdictOf([loud]).publication(silent.open, lines, head);

		expect(silent).toMatchObject({ post: [], resolved: [], open: previous });
		expect(again).toMatchObject({ post: [], stillOpen: [loud.properties.id], resolved: [] });
	});

	it("places advisories in the body and retires every former thread, including merged reports", () => {
		const advisory = finding({ severity: "P3" });
		const member = finding({ rule: "detect-eval", severity: "P3", source: { check: "static.eslint" } });
		const verdict = verdictOf([advisory, member]);
		const previous = { [advisory.id]: posted("101"), [member.id]: posted("102") };
		const plan = verdict.publication(previous, lines, head);
		expect(plan.post.map(({ placement }) => placement)).toEqual([{ kind: "body" }]);
		expect(plan.resolved).toEqual(
			[
				{ id: advisory.id, ...posted("101") },
				{ id: member.id, ...posted("102") },
			].sort((left, right) => left.id.localeCompare(right.id)),
		);
		expect(Object.values(plan.open).every((entry) => entry.thread === undefined)).toBe(true);
		const again = verdict.publication(plan.open, lines, head);
		expect(again.post).toEqual([]);
		expect(again.resolved).toEqual([]);
		expect(again.stillOpen).toEqual(verdict.attention().map((finding) => finding.id));
	});

	it("starts a thread when a body finding becomes actionable on a changed line", () => {
		const acknowledge = finding({ severity: "P2" });
		const plan = verdictOf([acknowledge]).publication({ [acknowledge.id]: posted() }, lines, head);
		expect(plan.post.map(({ placement }) => placement)).toEqual([{ kind: "lines", startLine: 12, line: 12 }]);
		expect(plan.stillOpen).toEqual([]);
		expect(plan.resolved).toEqual([]);
	});

	it("posts nothing for silent findings", () => {
		const nit = finding({ severity: "nit" });
		expect(verdictOf([nit]).publication({}, lines, head).post).toEqual([]);
	});
});

describe("Verdict.reviewStatus", () => {
	it("lists each merged dismissed report with its own reason, falling back to the speaker for older records", () => {
		const primary = finding({ severity: "P2", status: "dismissed" });
		const reason = { by: "Maintainer", at: "2026-10-17T00:00:00Z", reason: "Primary reason." };
		const otherReason = { ...reason, reason: "Other reason." };
		const member = finding({ rule: "other-rule", status: "dismissed" });
		const shown = Finding.from({
			...primary.toJSON(),
			properties: {
				...primary.properties,
				dismissal: reason,
				alsoReportedAs: [
					{ ...member.report(), dismissal: otherReason },
					{ ...member.report(), id: "b".repeat(16) },
				],
			},
		});
		expect(verdictOf([shown]).dismissals()).toEqual([
			{ ...shown.report(), path: "src/run.ts" },
			{ ...member.report(), path: "src/run.ts", dismissal: otherReason },
			{ ...member.report(), id: "b".repeat(16), path: "src/run.ts", dismissal: reason },
		]);
		expect(verdictOf([]).dismissals()).toEqual([]);
	});
	it("derives every failure count from counted findings, including lifted-member exclusions", () => {
		const acknowledgement = finding({ severity: "P2" });
		const stored = verdictOf([acknowledgement]).toJSON();
		const verdict = Verdict.from({
			...stored,
			preExistingImportant: [
				{
					id: acknowledgement.id,
					originalSeverity: "P1",
					state: "carried",
					lifted: true,
				},
			],
		});
		expect(verdict.counted()).toEqual([]);
		expect(verdict.reviewStatus()).toEqual({ state: "success", description: "Passed" });
		expect(verdict.render()).not.toContain("Dismiss unresolved acknowledgements");
	});
	it("maps a passed review to success", () => {
		expect(verdictOf([]).reviewStatus()).toEqual({ state: "success", description: "Passed" });
	});

	it("maps advisory findings to success, counting them", () => {
		const advisory = finding({ severity: "P3" });
		expect(verdictOf([advisory]).reviewStatus()).toEqual({
			state: "success",
			description: "1 finding, none blocking",
		});
	});

	it.each([1, 2])("fails the status for %i unresolved acknowledges without blocks", (number) => {
		const acknowledges = Array.from({ length: number }, (_, occurrence) => finding({ severity: "P2", occurrence }));
		const verdict = verdictOf(acknowledges);
		expect(verdict.status).toBe("findings");
		expect(verdict.blocking).toBe(false);
		expect(verdict.findings.acknowledge).toHaveLength(number);
		expect(verdict.reviewStatus()).toEqual({
			state: "failure",
			description: `${number} finding${number === 1 ? "" : "s"}, 0 blocking, ${number} unresolved acknowledgement${number === 1 ? "" : "s"}`,
		});
	});

	it("passes when every acknowledge has a dismissal with a reason", () => {
		const acknowledges = [0, 1].map((occurrence) => finding({ severity: "P2", occurrence }));
		const dismissed = acknowledges.map((each) =>
			Finding.from({
				...each.toJSON(),
				properties: {
					...each.properties,
					status: "dismissed",
					dismissal: { by: "Tal <tal@melian.invalid>", reason: "Constant input.", at: "2026-10-17T00:00:00Z" },
				},
			}),
		);
		const verdict = verdictOf(dismissed);
		expect(verdict.dismissed).toHaveLength(2);
		expect(verdict.findings.acknowledge).toEqual([]);
		expect(verdict.reviewStatus()).toEqual({ state: "success", description: "0 findings, 2 dismissed" });
	});

	it("still fails when one acknowledge remains after a dismissal", () => {
		const answered = finding({ severity: "P2", occurrence: 0 });
		const dismissed = Finding.from({
			...answered.toJSON(),
			properties: {
				...answered.properties,
				status: "dismissed",
				dismissal: { by: "Tal <tal@melian.invalid>", reason: "Constant input.", at: "2026-10-17T00:00:00Z" },
			},
		});
		const verdict = verdictOf([dismissed, finding({ severity: "P2", occurrence: 1 })]);
		expect(verdict.dismissed).toHaveLength(1);
		expect(verdict.findings.acknowledge).toHaveLength(1);
		expect(verdict.reviewStatus()).toEqual({
			state: "failure",
			description: "1 finding, 0 blocking, 1 unresolved acknowledgement",
		});
	});

	it("fails for an acknowledge policy notice on AGENTS.md", () => {
		const notice = finding({
			file: "AGENTS.md",
			rule: "guardrail/policy-change-review",
			severity: "P2",
			source: { check: "guardrails" },
		});
		const verdict = verdictOf([notice]);
		expect(verdict.findings.acknowledge.map((each) => each.id)).toEqual([notice.id]);
		expect(verdict.reviewStatus()).toEqual({
			state: "failure",
			description: "1 finding, 0 blocking, 1 unresolved acknowledgement",
		});
	});

	it("explains the status failure in the terminal without labelling acknowledges blocking", () => {
		const text = verdictOf([finding({ severity: "P2" })]).render();
		expect(text).toContain("Verdict: findings\n");
		expect(text).toContain("melian/review: failure (1 finding, 0 blocking, 1 unresolved acknowledgement).");
		expect(text).toContain("Dismiss unresolved acknowledgements with a reason, then publish.");
	});

	it.each(["new", "carried"] as const)("fails for a %s pre-existing acknowledge opt-in", (state) => {
		const old = finding({ severity: "P0", cause: "pre-existing", source: { check: "static.tsc" } });
		const verdict = new Adjudication({
			findings: [old],
			manifest: [],
			checks: [],
			config: {
				...defaultConfig,
				resolution: { ...defaultConfig.resolution, preExisting: { P0: "acknowledge" } },
			},
			seenBefore: state === "carried" ? [old.id] : [],
		}).adjudicate();
		expect(verdict.blocking).toBe(false);
		expect(verdict.findings.acknowledge.map((each) => each.id)).toEqual([old.id]);
		expect(verdict.preExistingImportant).toEqual([{ id: old.id, state, originalSeverity: "P0" }]);
		expect(verdict.reviewStatus()).toEqual({
			state: "failure",
			description: "1 finding, 0 blocking, 1 unresolved acknowledgement",
		});
	});

	it("passes for a pre-existing important member lifted only to advisory", () => {
		const old = finding({ severity: "P0", cause: "pre-existing", source: { check: "static.tsc" } });
		const verdict = new Adjudication({
			findings: [old],
			manifest: [],
			checks: [],
			config: { ...defaultConfig, resolution: { ...defaultConfig.resolution, P0: "silent" } },
		}).adjudicate();
		expect(verdict.status).toBe("passed");
		expect(verdict.preExistingImportant).toEqual([
			{ id: old.id, state: "new", originalSeverity: "P0", lifted: true },
		]);
		expect(verdict.findings.advisory.map((each) => each.id)).toEqual([old.id]);
		expect(verdict.counted()).toEqual([]);
		expect(verdict.reviewStatus()).toEqual({ state: "success", description: "Passed" });
	});

	it("counts blocks and unresolved acknowledges apart beside advisory findings", () => {
		const verdict = verdictOf([
			finding({ severity: "P1", occurrence: 0 }),
			finding({ severity: "P2", occurrence: 1 }),
			finding({ severity: "P3", occurrence: 2 }),
		]);
		expect(verdict.reviewStatus()).toEqual({
			state: "failure",
			description: "3 findings, 1 blocking, 1 unresolved acknowledgement",
		});
	});

	it("maps a blocking finding to failure", () => {
		expect(verdictOf([finding({ severity: "P0" })]).reviewStatus()).toEqual({
			state: "failure",
			description: "1 finding, 1 blocking, 0 unresolved acknowledgements",
		});
	});

	it("names an ended lens's budget first, and any note after it", () => {
		const checks: CheckRecord[] = [
			{
				name: "lens.correctness",
				status: "ended",
				level: "careful",
				budgetEnded: { budget: "tokens", limit: 50_000, tokens: 51_200, tools: 4 },
				reason: "escalated from quick to careful: at quick it reported a P1 finding, at or above P1",
			},
		];
		expect(verdictOf([], checks).reviewStatus()).toEqual({
			state: "error",
			description:
				"Not reviewed: lens.correctness ended (its token budget of 50,000 ran out after 4 tool calls and 51,200 tokens; escalated from quick to careful: at quick it reported a P1 finding, at or above P1)",
		});
	});

	it("maps a review that did not complete to error, with what did not run", () => {
		const checks: CheckRecord[] = [
			{ name: "lens.correctness", status: "failed", reason: "the lens did not finish" },
			{ name: "lens.contracts", status: "ran" },
		];
		expect(verdictOf([finding({ severity: "P0" })], checks).reviewStatus()).toEqual({
			state: "error",
			description: "Not reviewed: lens.correctness failed (the lens did not finish)",
		});
	});
});

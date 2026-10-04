import {
	adjudicate,
	type ChangedFile,
	type CheckRecord,
	createFinding,
	defaultConfig,
	diffLines,
	type Finding,
	type FindingInput,
	placeFinding,
	planPublication,
	reviewStatus,
	type Verdict,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const finding = (input: Partial<FindingInput>): Finding =>
	createFinding({ ...evalInput, trigger: undefined, startColumn: undefined, endColumn: undefined, ...input });

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

describe("diffLines", () => {
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
		expect(diffLines(files)).toEqual({
			"src/run.ts": [
				[3, 4],
				[20, 20],
			],
		});
	});
});

describe("placeFinding", () => {
	const lines = {
		"src/run.ts": [
			[10, 14],
			[30, 30],
		] as [number, number][],
	};

	it("posts a finding inside the diff on its own lines", () => {
		expect(placeFinding(finding({ startLine: 12, endLine: 12 }), lines)).toEqual({
			kind: "lines",
			startLine: 12,
			line: 12,
		});
		expect(placeFinding(finding({ startLine: 11, endLine: 13 }), lines)).toEqual({
			kind: "lines",
			startLine: 11,
			line: 13,
		});
	});

	it("clips a finding that runs past a hunk to the changed lines", () => {
		expect(placeFinding(finding({ startLine: 8, endLine: 11 }), lines)).toEqual({
			kind: "lines",
			startLine: 10,
			line: 11,
		});
	});

	it("anchors a finding outside the diff to the nearest changed line of its file", () => {
		expect(placeFinding(finding({ startLine: 25, endLine: 25 }), lines)).toEqual({ kind: "nearest", line: 30 });
		expect(placeFinding(finding({ startLine: 2, endLine: 2 }), lines)).toEqual({ kind: "nearest", line: 10 });
		expect(placeFinding(finding({ startLine: 20, endLine: 20 }), lines)).toEqual({ kind: "nearest", line: 14 });
	});

	it("puts a finding in a file the change does not touch in the body", () => {
		expect(placeFinding(finding({ file: "src/other.ts" }), lines)).toEqual({ kind: "body" });
	});
});

function verdictOf(findings: readonly Finding[], checks: readonly CheckRecord[] = []): Verdict {
	return adjudicate({ findings, manifest: checks.map((check) => check.name), checks, config: defaultConfig });
}

describe("planPublication", () => {
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
		const plan = planPublication(verdictOf([open, fresh]), previous, lines, head);

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

	it("resolves an open finding that was dismissed, with its dismissal, and never posts a dismissed one", () => {
		const dismissal = { by: "Tal <tal@melian.invalid>", reason: "Constant input.", at: "2026-10-04T00:00:00Z" };
		const as = (each: Finding): Finding => ({
			...each,
			properties: { ...each.properties, status: "dismissed", dismissal },
		});
		const plan = planPublication(
			verdictOf([as(fixed), as(fresh)]),
			{ [fixed.properties.id]: posted("102") },
			lines,
			head,
		);

		expect(plan).toMatchObject({ post: [], stillOpen: [] });
		expect(plan.resolved).toEqual([{ id: fixed.properties.id, ...posted("102"), dismissal }]);
		expect(plan.open).toEqual({});
	});

	it("keeps a finding that turned silent on its thread, so it never gets a second one", () => {
		const quiet = finding({ severity: "nit" });
		const loud = finding({ severity: "P3" });
		const previous = { [loud.properties.id]: posted("101") };

		const silent = planPublication(verdictOf([quiet]), previous, lines, head);
		const again = planPublication(verdictOf([loud]), silent.open, lines, head);

		expect(silent).toMatchObject({ post: [], resolved: [], open: previous });
		expect(again).toMatchObject({ post: [], stillOpen: [loud.properties.id], resolved: [] });
	});

	it("posts nothing for silent findings", () => {
		const nit = finding({ severity: "nit" });
		expect(planPublication(verdictOf([nit]), {}, lines, head).post).toEqual([]);
	});
});

describe("reviewStatus", () => {
	it("maps a passed review to success", () => {
		expect(reviewStatus(verdictOf([]))).toEqual({ state: "success", description: "Passed" });
	});

	it("maps findings with nothing blocking to success, counting them", () => {
		const advisory = finding({ severity: "P3" });
		const acknowledge = finding({ severity: "P2", snippet: "eval(body)" });
		expect(reviewStatus(verdictOf([advisory, acknowledge]))).toEqual({
			state: "success",
			description: "2 findings, none blocking",
		});
	});

	it("maps a blocking finding to failure", () => {
		expect(reviewStatus(verdictOf([finding({ severity: "P0" })]))).toEqual({
			state: "failure",
			description: "1 finding, 1 blocking",
		});
	});

	it("maps a review that did not complete to error, with what did not run", () => {
		const checks: CheckRecord[] = [
			{ name: "lens.correctness", status: "failed", reason: "the lens did not finish" },
			{ name: "lens.contracts", status: "ran" },
		];
		expect(reviewStatus(verdictOf([finding({ severity: "P0" })], checks))).toEqual({
			state: "error",
			description: "Not reviewed: lens.correctness failed (the lens did not finish)",
		});
	});
});

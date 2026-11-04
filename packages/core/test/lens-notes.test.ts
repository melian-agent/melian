import { Adjudication, type CheckRecord, defaultConfig, Rendering, Verdict } from "@melian-agent/core";
import { expect, it } from "vitest";

const note = "Callers unavailable for src/a.ts: directory-scoped name is ambiguous";
const checks: CheckRecord[] = [
	{ name: "lens.correctness", status: "ran", level: "careful", reason: note },
	{ name: "lens.contracts", status: "ran", level: "quick", reason: note },
	{ name: "lens.tests", status: "ran", level: "deep" },
];
const verdict = new Adjudication({ findings: [], manifest: [], checks, config: defaultConfig }).adjudicate();

it("omits lens notes by default and with --all, keeping levels", () => {
	for (const rendering of [new Rendering(), new Rendering({ all: true }), new Rendering({ notes: false })]) {
		const text = verdict.render(rendering);
		expect(text).not.toContain(note);
		expect(text).toContain("lens.correctness  careful");
		expect(text).toContain("lens.contracts  quick");
		expect(text).toContain("lens.tests  deep");
	}
});

it("shows a shared lens note once with --notes and names its checks", () => {
	const text = verdict.render(new Rendering({ notes: true }));
	expect(text.split(note)).toHaveLength(2);
	expect(text).toContain(`  lens.correctness, lens.contracts: ${note}`);
	expect(text).not.toContain("lens.tests:");
});

it("keeps each lens reason in JSON", () => {
	expect(JSON.parse(verdict.renderJson()).ran).toEqual(checks);
});

it("indents a note's continuation and escapes terminal controls", () => {
	const unsafe = new Adjudication({
		findings: [],
		manifest: [],
		checks: [{ name: "lens.x\u001b", status: "ran", level: "careful", reason: "first\nsecond\u001b" }],
		config: defaultConfig,
	}).adjudicate();
	expect(unsafe.render(new Rendering({ notes: true }))).toContain("  lens.x\\u001b: first\n    second\\u001b");
});

it("deduplicates individual notes inside different lens reasons in record order", () => {
	const first = "triage input was cut, so no lens could skip";
	const other = "kept the defects it hands to durability";
	const combined = new Adjudication({
		findings: [],
		manifest: [],
		checks: [
			{ name: "lens.correctness", status: "ran", level: "careful", reason: `${note}; ${first}; ${note}` },
			{ name: "lens.contracts", status: "ran", level: "quick", reason: `${other}; ${note}` },
			{ name: "lens.tests", status: "ran", level: "deep" },
		],
		config: defaultConfig,
	}).adjudicate();
	expect(combined.lensNotes()).toEqual([
		{ reason: note, checks: ["lens.correctness", "lens.contracts"] },
		{ reason: first, checks: ["lens.correctness"] },
		{ reason: other, checks: ["lens.contracts"] },
	]);
	expect(combined.render(new Rendering({ notes: true })).split(note)).toHaveLength(2);
});

it("keeps an empty stored note and accepts records without a reason or legacy ran list", () => {
	const empty = new Adjudication({
		findings: [],
		manifest: [],
		checks: [
			{ name: "lens.correctness", status: "ran", reason: "" },
			{ name: "lens.tests", status: "ran" },
		],
		config: defaultConfig,
	}).adjudicate();
	expect(empty.lensNotes()).toEqual([{ reason: "", checks: ["lens.correctness"] }]);
	const { ran: _, ...legacy } = empty.toJSON();
	expect(Verdict.from(legacy).lensNotes()).toEqual([]);
});

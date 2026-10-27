import { Adjudication, type CheckRecord, defaultConfig, Rendering } from "@melian-agent/core";
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

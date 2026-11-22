import {
	Adjudication,
	type CheckRecord,
	defaultConfig,
	Rendering,
	sharedCopyTrimmed,
	Verdict,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";

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

describe("a check whose shared copy was trimmed", () => {
	const trimmed = new Adjudication({
		findings: [],
		manifest: [],
		checks: [
			{ name: "guardrails", status: "ran", reason: sharedCopyTrimmed },
			{ name: "static.biome", status: "ran", reason: `Biome read 2 files.; ${sharedCopyTrimmed}` },
			{ name: "lens.tests", status: "ran", level: "deep", reason: note },
			{ name: "lens.contracts", status: "ran", level: "quick" },
		],
		config: defaultConfig,
	}).adjudicate();

	it("names each such check once, without --notes", () => {
		const text = trimmed.render();
		expect(text).toContain(`\n\n  guardrails, static.biome: ${sharedCopyTrimmed}\n\n`);
		expect(text.split(sharedCopyTrimmed)).toHaveLength(2);
		expect(text).not.toContain(note);
	});

	it("shows the note once with --notes, among the other notes", () => {
		const text = trimmed.render(new Rendering({ notes: true }));
		expect(text.split(sharedCopyTrimmed)).toHaveLength(2);
		expect(text).toContain(`  guardrails, static.biome: ${sharedCopyTrimmed}`);
		expect(text).toContain(`  lens.tests: ${note}`);
	});

	it("is not named for a verdict whose checks were not trimmed, or that holds no ran list", () => {
		expect(verdict.render()).not.toContain(sharedCopyTrimmed);
		expect(verdict.render()).not.toContain("\n\n  : ");
		const { ran: _, ...legacy } = trimmed.toJSON();
		expect(Verdict.from(legacy).render()).not.toContain(sharedCopyTrimmed);
	});
});

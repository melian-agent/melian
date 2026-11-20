import {
	canonicalJson,
	envelopeAllowance,
	Finding,
	recordLimit,
	SightingBudget,
	snippetHash,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";

// A policy notice as guardrails writes one for a workspace manifest, its What made long by the scripts it names.
function notice(index: number, severity: "P1" | "P3" = "P1"): Finding {
	const path = `packages/p${String(index).padStart(4, "0")}/package.json`;
	return Finding.create({
		rule: "guardrail/policy-change-review",
		message: `Review the change to ${path}, which configures the packages Biome and tsc load.`,
		file: path,
		startLine: 1,
		discriminator: "analyser",
		cause: "introduced",
		trigger: { file: path, index: 0, hash: snippetHash(`blob:${index}`) },
		severity,
		explanation: {
			what: `This revision changes ${path}, which configures the packages Biome and tsc load. It changes the npm scripts ${"s".repeat(2000)}.`,
			whyHere:
				"The head's configuration drives the static run on the head, so this change decides how the head's own results are judged.",
			whatToDo: `Have a maintainer read the change to ${path}, or land it in its own pull request first.`,
		},
		source: { check: "guardrails" },
		guardrail: { notice: "analyser" },
	});
}

const findings = Array.from({ length: 12 }, (_, index) => notice(index, index % 3 === 0 ? "P3" : "P1"));
const bytes = (each: readonly Finding[]) =>
	Buffer.byteLength(canonicalJson([...each].sort((a, b) => (a.id < b.id ? -1 : 1)).map((f) => f.toJSON())));
const kept = (each: readonly Finding[]) =>
	each.map((finding) => ({
		id: finding.id,
		rule: finding.ruleId,
		severity: finding.properties.severity,
		resolution: finding.properties.resolution,
		path: finding.properties.path,
		region: finding.locations[0]!.physicalLocation.region,
		trigger: finding.properties.trigger,
		discriminator: finding.properties.discriminator,
		message: finding.message.text,
		whatToDo: finding.properties.explanation.whatToDo,
	}));

describe("a record's sighting budget", () => {
	it("is the store's record limit less the envelope's allowance", () => {
		expect(SightingBudget.checkRecord.bytes).toBe(recordLimit - envelopeAllowance);
	});

	it("leaves findings that fit it exactly as they are", () => {
		const exact = bytes(findings);
		expect(new SightingBudget(exact).fit(findings)).toEqual(findings);
	});

	it("abridges the last finding in ID order one byte past it, naming one more file", () => {
		const exact = bytes(findings);
		const fitted = new SightingBudget(exact - 1).fit(findings);
		const last = [...findings].sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1)!;
		const changed = fitted.filter((finding, index) => finding !== findings[index]);
		expect(changed.map((finding) => finding.id)).toEqual([last.id]);
		expect(changed[0]!.properties.explanation).toEqual({
			what: last.message.text,
			whyHere: "Melian left out the detail for 1 more file to keep this record under its limit.",
			whatToDo: last.properties.explanation.whatToDo,
		});
		expect(bytes(fitted)).toBeLessThanOrEqual(exact - 1);
		expect(kept(fitted)).toEqual(kept(findings));
	});

	it("keeps detail while the full findings so far and every later one abridged fit, and counts the rest's files", () => {
		const budget = Math.floor((bytes(findings) + bytes(new SightingBudget(0).fit(findings))) / 2);
		const fitted = new SightingBudget(budget).fit(findings);
		expect(bytes(fitted)).toBeLessThanOrEqual(budget);
		const order = fitted
			.map((finding, index) => [finding, index] as const)
			.sort(([a], [b]) => (a.id < b.id ? -1 : 1));
		const abridged = order.map(([finding, index]) => finding !== findings[index]);
		const cut = abridged.indexOf(true);
		expect(cut).toBeGreaterThan(0);
		expect(abridged.slice(cut).every(Boolean)).toBe(true);
		const note = `Melian left out the detail for ${findings.length - cut} more files to keep this record under its limit.`;
		expect(order.slice(cut).map(([finding]) => finding.properties.explanation.whyHere)).toEqual(
			new Array(findings.length - cut).fill(note),
		);
		// One more finding with its detail would not fit.
		const more = order.map(([finding, index], at) => (at === cut ? findings[index]! : finding));
		expect(bytes(more)).toBeGreaterThan(budget);
		expect(kept(fitted)).toEqual(kept(findings));
	});

	it("gives the same bytes and IDs for the same findings, in any order", () => {
		const budget = Math.floor((bytes(findings) + bytes(new SightingBudget(0).fit(findings))) / 2);
		const once = new SightingBudget(budget).fit(findings);
		const again = new SightingBudget(budget).fit([...findings].reverse());
		expect(bytes(again)).toBe(bytes(once));
		expect(
			canonicalJson(
				again.map((finding) => finding.toJSON()).sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1)),
			),
		).toBe(
			canonicalJson(
				once.map((finding) => finding.toJSON()).sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1)),
			),
		);
	});

	it("abridges every finding when even that passes the budget", () => {
		const fitted = new SightingBudget(10).fit(findings);
		expect(fitted.every((finding, index) => finding !== findings[index])).toBe(true);
		expect(new Set(fitted.map((finding) => finding.properties.explanation.whyHere))).toEqual(
			new Set([`Melian left out the detail for ${findings.length} more files to keep this record under its limit.`]),
		);
		expect(kept(fitted)).toEqual(kept(findings));
	});
});

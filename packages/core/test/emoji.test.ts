import { describe, expect, it } from "vitest";
import {
	checkMarks,
	Mark,
	outcomeMarks,
	Rendering,
	resolutionMarks,
	severityMarks,
	tableEmojis,
	verifierMark,
	verifierMarks,
} from "../src/index.ts";

// The guideline's table, by escape, so this file holds no literal emoji either.
const table = {
	severity: { P0: "\u{1F534}", P1: "\u{1F7E0}", P2: "\u{1F7E1}", P3: "\u{1F535}", nit: "\u{26AA}" },
	resolution: { block: "\u{26D4}", acknowledge: "\u{270B}", advisory: "\u{1F4AC}" },
	verifier: {
		confirmed: "\u{2705}",
		plausible: "\u{26A0}\u{FE0F}",
		unverified: "\u{2754}",
		refuted: "\u{2716}\u{FE0F}",
	},
	outcome: { passed: "\u{1F7E9}", fixed: "\u{1F527}", dismissed: "\u{1F5C2}\u{FE0F}", notReviewed: "\u{1F6A7}" },
};

describe("the emoji table", () => {
	it("gives each severity, resolution, verifier outcome and review outcome the guideline's emoji and word", () => {
		expect(Object.fromEntries(Object.entries(severityMarks).map(([key, mark]) => [key, mark.emoji]))).toEqual(
			table.severity,
		);
		expect(Object.entries(resolutionMarks).map(([key, mark]) => [key, mark.show(true)])).toEqual([
			["block", `${table.resolution.block} Blocks merge`],
			["acknowledge", `${table.resolution.acknowledge} Needs acknowledgement`],
			["advisory", `${table.resolution.advisory} Advisory`],
			["silent", "Silent"],
		]);
		expect(Object.entries(verifierMarks).map(([key, mark]) => [key, mark.show(true)])).toEqual([
			["confirmed", `${table.verifier.confirmed} Verifier confirmed`],
			["plausible", `${table.verifier.plausible} Verifier plausible`],
			["unverified", `${table.verifier.unverified} Not verified`],
			["refuted", `${table.verifier.refuted} Refuted`],
		]);
		expect(Object.fromEntries(Object.entries(outcomeMarks).map(([key, mark]) => [key, mark.emoji]))).toEqual(
			table.outcome,
		);
		expect(verifierMark.show(true)).toBe("\u{2696}\u{FE0F} Verifier");
	});

	it("shows the word alone when emojis are off, and a mark without an emoji as its word either way", () => {
		expect(severityMarks.P1.show(false)).toBe("P1");
		expect(Object.values(severityMarks).map((mark) => mark.show(false))).toEqual(["P0", "P1", "P2", "P3", "nit"]);
		expect(severityMarks.P1.show(true)).toBe("\u{1F7E0} P1");
		expect(resolutionMarks.silent.show(true)).toBe("Silent");
	});

	it("names every built-in lens, Melian's durability lens, the four static tools and the guardrails", () => {
		expect(Object.entries(checkMarks).map(([check, mark]) => [check, mark.show(true)])).toEqual([
			["lens.correctness", "\u{1F3AF} Correctness"],
			["lens.contracts", "\u{1F91D} Contracts"],
			["lens.trust-boundary", "\u{1F6E1}\u{FE0F} Trust boundary"],
			["lens.removed-behaviour", "\u{2702}\u{FE0F} Removed behaviour"],
			["lens.tests", "\u{1F9EA} Tests"],
			["lens.conventions", "\u{1F4CF} Conventions"],
			["lens.design", "\u{1F4D0} Design"],
			["lens.durability", "\u{1F4BE} Durability"],
			["static.biome", "\u{1F9F9} Biome"],
			["static.tsc", "\u{1F9E9} tsc"],
			["static.enola", "\u{1F578}\u{FE0F} Enola"],
			["static.mutation", "\u{1F9EC} Mutation"],
			["guardrails", "\u{1F6A6} Guardrails"],
		]);
	});

	it("collects every emoji it uses, the magnifying glass among them, and nothing a mark leaves out", () => {
		expect([...tableEmojis]).toHaveLength(31);
		expect(tableEmojis.has("\u{1F50E}")).toBe(true);
		expect(tableEmojis.has("\u{2696}\u{FE0F}")).toBe(true);
		expect(tableEmojis.has("\u{26D4}")).toBe(true);
		expect(tableEmojis.has("\u{1F600}")).toBe(false);
	});
});

describe("Mark.check", () => {
	it("takes a lens's row, else the emoji it declares, else the magnifying glass, beside its name", () => {
		expect(Mark.check("lens.tests", "untested-behaviour", "\u{1F600}").show(true)).toBe("\u{1F9EA} Tests");
		expect(Mark.check("lens.cleanup", "dead-code", "\u{1F9FD}").show(true)).toBe("\u{1F9FD} cleanup");
		expect(Mark.check("lens.cleanup", "dead-code").show(true)).toBe("\u{1F50E} cleanup");
		expect(Mark.check("lens.cleanup", "dead-code").show(false)).toBe("cleanup");
	});

	it("names the guardrail a guardrail finding's rule falls under, or the guardrails alone", () => {
		expect(Mark.check("guardrails", "guardrail/policy-change-review/policy").show(true)).toBe(
			"\u{1F6A6} Guardrails: policy-change-review",
		);
		expect(Mark.check("guardrails", "guardrail/required-files").show(false)).toBe("Guardrails: required-files");
		expect(Mark.check("guardrails", "unknown").show(true)).toBe("\u{1F6A6} Guardrails");
	});

	it("shows a static tool's row, and a check the table does not know by its name, without an emoji", () => {
		expect(Mark.check("static.tsc", "TS2322").show(true)).toBe("\u{1F9E9} tsc");
		expect(Mark.check("decisions.fast", "x").show(true)).toBe("decisions.fast");
		expect(Mark.check("static.eslint", "x").emoji).toBeUndefined();
	});

	it("never takes a declared emoji from the prototype chain", () => {
		expect(new Rendering({ emoji: true }).check("lens.toString", "x").show(true)).toBe("\u{1F50E} toString");
		expect(Mark.check("toString", "x").show(true)).toBe("toString");
	});
});

describe("Rendering marks", () => {
	it("shows a mark's emoji only when asked", () => {
		expect(new Rendering().show(severityMarks.P0)).toBe("P0");
		expect(new Rendering({ emoji: true }).show(severityMarks.P0)).toBe("\u{1F534} P0");
	});

	it("gives a lens the emoji its LENS.md declares, by check name", () => {
		const rendering = new Rendering({ emoji: true, lensEmojis: { "lens.cleanup": "\u{1F9FD}" } });
		expect(rendering.show(rendering.check("lens.cleanup", "dead-code"))).toBe("\u{1F9FD} cleanup");
		expect(rendering.show(rendering.check("lens.other", "dead-code"))).toBe("\u{1F50E} other");
	});

	it("picks a variant's emoji by the finding's lens version, and falls back to the name, then the magnifying glass", () => {
		const rendering = new Rendering({
			emoji: true,
			lensEmojis: { "lens.cleanup@aaaaaaaaaaaa": "\u{1F9FD}", "lens.tidy": "\u{1F980}" },
		});
		expect(rendering.check("lens.cleanup", "x", "aaaaaaaaaaaa@careful").emoji).toBe("\u{1F9FD}");
		expect(rendering.check("lens.cleanup", "x", "bbbbbbbbbbbb@careful").emoji).toBe("\u{1F50E}");
		expect(rendering.check("lens.cleanup", "x").emoji).toBe("\u{1F50E}");
		expect(rendering.check("lens.tidy", "x", "cccccccccccc@deep").emoji).toBe("\u{1F980}");
		expect(rendering.check("lens.tidy", "x").emoji).toBe("\u{1F980}");
	});
});

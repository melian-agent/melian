import { Adjudication, defaultConfig } from "@melian-agent/core";
import { expect, it } from "vitest";

const verdictOf = (caveats?: string[]) =>
	new Adjudication({
		findings: [],
		manifest: [],
		checks: [
			{
				name: "lens.correctness",
				status: "ran",
				level: "careful",
				reason: "Callers unavailable: x",
				...(caveats === undefined ? {} : { caveats }),
			},
			{
				name: "lens.contracts",
				status: "skipped",
				reason: "triage skipped it",
				...(caveats === undefined ? {} : { caveats }),
			},
		],
		config: defaultConfig,
	}).adjudicate();

it("hashes a verdict alike with or without caveats, so an upgraded verdict is not published again", () => {
	const caveat = "callers were unavailable for every changed site, so no lens saw who calls the changed code: x";
	expect(verdictOf([caveat]).fingerprint()).toBe(verdictOf().fingerprint());
	expect(verdictOf([caveat]).toJSON().notRun[0]).toMatchObject({ caveats: [caveat] });
	expect(verdictOf([caveat]).toJSON().ran![0]).toMatchObject({ caveats: [caveat] });
	expect(verdictOf(["another"]).fingerprint()).toBe(verdictOf().fingerprint());
});

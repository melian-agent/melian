import { Adjudication, defaultConfig, Finding } from "@melian-agent/core";
import { expect, it } from "vitest";
import { minimalInput } from "./fixtures/findings.ts";

const verdictOf = (finding: Finding) =>
	new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate();

// Pull request #344: a round that only adds a proposal must read as a new verdict, or publishing takes it as posted.
it("hashes a verdict apart for each likely dismissed root a finding names, and alike for a changed dismissal", () => {
	const finding = Finding.create(minimalInput);
	const verdictWith = (properties: Partial<Finding["properties"]>) =>
		verdictOf(Finding.from({ ...finding.toJSON(), properties: { ...finding.properties, ...properties } }));
	const fingerprints = [
		verdictOf(finding),
		verdictWith({ likelyDismissedAs: { id: "0123456789abcdef" } }),
		verdictWith({ likelyDismissedAs: { id: "fedcba9876543210" } }),
	].map((verdict) => verdict.fingerprint());
	expect(new Set(fingerprints).size).toBe(3);
	const dismissal = { by: "Tal", reason: "Constant input.", at: "2026-11-08T00:00:00Z" };
	expect(verdictWith({ status: "dismissed", dismissal }).fingerprint()).toBe(
		verdictWith({
			status: "dismissed",
			dismissal: { ...dismissal, by: "Sam", reason: "Checked upstream." },
		}).fingerprint(),
	);
});

it("hashes an inherited dismissal as it hashes the root's own", () => {
	const finding = Finding.create(minimalInput);
	const dismissed = (inheritedFrom?: string) =>
		Finding.from({
			...finding.toJSON(),
			properties: {
				...finding.properties,
				status: "dismissed",
				dismissal: {
					by: "melian",
					reason: "Constant input.",
					at: "2026-11-08T00:00:00Z",
					...(inheritedFrom === undefined ? {} : { inheritedFrom }),
				},
			},
		});
	expect(verdictOf(dismissed("0123456789abcdef")).fingerprint()).toBe(verdictOf(dismissed()).fingerprint());
});

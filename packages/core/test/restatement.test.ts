import { Adjudication, defaultConfig, Finding } from "@melian-agent/core";
import { expect, it } from "vitest";
import { minimalInput } from "./fixtures/findings.ts";

const verdictOf = (finding: Finding) =>
	new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate();

it("hashes a verdict alike whether or not a finding names a likely dismissed root", () => {
	const finding = Finding.create(minimalInput);
	const proposed = Finding.from({
		...finding.toJSON(),
		properties: { ...finding.properties, likelyDismissedAs: { id: "0123456789abcdef" } },
	});
	expect(verdictOf(proposed).fingerprint()).toBe(verdictOf(finding).fingerprint());
	expect(verdictOf(proposed).toJSON().findings).not.toEqual(verdictOf(finding).toJSON().findings);
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

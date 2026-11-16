import { Adjudication, defaultConfig, Finding, type FindingInput } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
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

describe("an inheritance and the fingerprint", () => {
	const input = (check: string): FindingInput => ({
		rule: "null-dereference",
		message: "The manager may be absent.",
		file: "src/a.ts",
		startLine: 3,
		snippet: "user.manager.name",
		occurrence: 0,
		cause: "introduced",
		severity: "P2",
		resolution: "acknowledge",
		explanation: { what: "Absent.", whyHere: "Dropped check.", whatToDo: "Check it." },
		source: { check, version: "1" },
	});
	const live = (check = "lens.correctness") => Finding.create(input(check));
	const dismissal = (inheritedFrom: string) => ({
		by: "melian",
		reason: "Loader sets it.",
		at: "2026-11-02T00:00:00Z",
		inheritedFrom,
	});
	const inherit = (finding: Finding, from: string) =>
		Finding.from({
			...finding.toJSON(),
			properties: { ...finding.properties, status: "dismissed", dismissal: dismissal(from) },
		});
	const decide = (findings: Finding[]) =>
		new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig }).adjudicate();
	const rootA = "0123456789abcdef";
	const rootB = "fedcba9876543210";

	it("moves an inherited finding out of its group while another stays live, which alone changes the fingerprint", () => {
		const other = Finding.create({ ...input("lens.correctness"), file: "src/b.ts" });
		const before = decide([live(), other]);
		const after = decide([inherit(live(), rootA), other]);
		expect(after.status).toBe(before.status);
		expect([before.fingerprint(), after.fingerprint()]).toEqual(["b810568f3d2a146d", "b9fef84781a47fcc"]);
		expect([before.reviewStatus(), after.reviewStatus()]).toEqual([
			{ state: "failure", description: "2 findings, 0 blocking, 2 unresolved acknowledgements" },
			{ state: "failure", description: "1 finding, 0 blocking, 1 unresolved acknowledgement" },
		]);
	});

	it("changes the fingerprint through a merged report's dismissed flag, whichever root it inherits", () => {
		const speaker = live("lens.correctness");
		const member = live("lens.design");
		const before = decide([speaker, member]);
		const after = decide([speaker, inherit(member, rootA)]);
		const reports = (verdict: typeof before) =>
			Object.values(verdict.findings).flatMap((group) => group.map((finding) => finding.properties.alsoReportedAs));
		const report = { id: member.id, ruleId: "null-dereference", check: "lens.design", severity: "P2" };
		expect(reports(before)).toEqual([[report]]);
		expect(reports(after)).toEqual([[{ ...report, dismissal: dismissal(rootA), dismissed: true }]]);
		expect([before.fingerprint(), after.fingerprint()]).toEqual(["55aa2f484a42f8dc", "77d15e9f5a068dbb"]);
		expect(after.reviewStatus()).toEqual(before.reviewStatus());
		expect(decide([speaker, inherit(member, rootB)]).fingerprint()).toBe(after.fingerprint());
	});
});

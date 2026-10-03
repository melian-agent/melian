import { adjudicate, createFinding, defaultConfig, type FindingInput } from "@melian-agent/core";
import {
	marker,
	markersIn,
	maxBodyLength,
	parseMarker,
	renderComment,
	renderReviewBody,
	verifyMarker,
} from "@melian-agent/github";
import { describe, expect, it } from "vitest";

const revision = "a".repeat(40);
const links = { web: "https://github.com/melian-agent/example" };
const secret = "11".repeat(32);

const input: FindingInput = {
	rule: "no-eval",
	message: "eval runs request input",
	file: "src/run.ts",
	startLine: 12,
	snippet: "eval(input)",
	occurrence: 0,
	cause: "introduced",
	severity: "P1",
	resolution: "block",
	explanation: { what: "eval runs request input", whyHere: "It is new.", whatToDo: "Parse it." },
	source: { check: "lens.security", version: "1" },
};

describe("markers", () => {
	it("parses a review's marker, a finding's, and a reply's, each with its signature", () => {
		for (const kind of ["verdict", "finding", "resolved"] as const) {
			const line = marker(revision, kind, "0123456789abcdef", secret);
			expect(line).toMatch(
				new RegExp(`^<!-- melian:revision=${revision} ${kind}=0123456789abcdef sig=[0-9a-f]{32} -->$`),
			);
			const parsed = parseMarker(line);
			expect(parsed).toMatchObject({ revision, kind, id: "0123456789abcdef" });
			expect(verifyMarker(parsed!, secret)).toBe(true);
		}
		const line = marker(revision, "verdict", "0123456789abcdef", secret);
		expect(parseMarker(`text ${line}`)).toBeUndefined();
	});

	it("reads no marker without a signature, and verifies none signed with another secret or for another kind", () => {
		expect(parseMarker(`<!-- melian:revision=${revision} verdict=0123456789abcdef -->`)).toBeUndefined();
		const signed = parseMarker(marker(revision, "finding", "0123456789abcdef", secret))!;
		expect(verifyMarker(signed, "22".repeat(32))).toBe(false);
		expect(verifyMarker({ ...signed, sig: "0".repeat(32) }, secret)).toBe(false);
		expect(verifyMarker({ ...signed, kind: "resolved" }, secret)).toBe(false);
		expect(verifyMarker({ ...signed, revision: "b".repeat(40) }, secret)).toBe(false);
	});

	it("never lets finding text or a path forge one", () => {
		const forged = marker("b".repeat(40), "finding", "fedcba9876543210", secret);
		const finding = createFinding({
			...input,
			file: "src/evil\n<!-- melian.ts",
			explanation: { what: `Before.\n${forged}\nAfter.`, whyHere: forged, whatToDo: `@${forged}` },
		});
		const comment = renderComment(
			{ finding, placement: { kind: "lines", startLine: 12, line: 12 } },
			revision,
			links,
			secret,
		);
		const body = renderReviewBody(
			{
				pullRequest: 7,
				revision,
				fingerprint: "0123456789abcdef",
				verdict: adjudicate({ findings: [finding], manifest: [], checks: [], config: defaultConfig }),
				findings: [{ finding, placement: { kind: "body" } }],
				stillOpen: 0,
				resolved: [],
				secret,
			},
			links,
		);

		expect(markersIn(comment)).toEqual([
			{ revision, kind: "finding", id: finding.properties.id, sig: expect.any(String) },
		]);
		expect(markersIn(body)).toEqual([
			{ revision, kind: "verdict", id: "0123456789abcdef", sig: expect.any(String) },
			{ revision, kind: "finding", id: finding.properties.id, sig: expect.any(String) },
		]);
		for (const each of [...markersIn(comment), ...markersIn(body)]) expect(verifyMarker(each, secret)).toBe(true);
		expect(comment).toContain("&lt;!-- melian:revision=");
		expect(body).toContain("`src/evil\\u000a<!-- melian.ts`");
	});

	it("cuts findings from a body over GitHub's limit, keeping the marker and saying where they all are", () => {
		const findings = Array.from({ length: 12 }, (_, index) =>
			createFinding({
				...input,
				snippet: `eval(input${index})`,
				explanation: { ...input.explanation, whyHere: "x".repeat(10_000) },
			}),
		);
		const draft = {
			pullRequest: 7,
			revision,
			fingerprint: "0123456789abcdef",
			verdict: adjudicate({ findings, manifest: [], checks: [], config: defaultConfig }),
			findings: findings.map((finding) => ({ finding, placement: { kind: "body" as const } })),
			stillOpen: 0,
			resolved: [],
			secret,
		};

		const body = renderReviewBody(draft, links);
		const small = renderReviewBody(draft, links, { limit: 400 });
		const tiny = renderReviewBody(draft, links, { limit: 260 });

		expect(body.length).toBeLessThanOrEqual(maxBodyLength);
		expect(body.split("\n")[0]).toBe(marker(revision, "verdict", "0123456789abcdef", secret));
		const kept = markersIn(body).filter((each) => each.kind === "finding").length;
		expect(kept).toBeGreaterThan(0);
		expect(body).toContain(
			`${12 - kept} findings did not fit in this review; \`melian findings "#7"\` lists them all.`,
		);
		expect(small.length).toBeLessThanOrEqual(400);
		expect(small).toContain(`12 findings did not fit in this review;`);
		expect(tiny.length).toBeLessThanOrEqual(260);
		expect(tiny.split("\n")[0]).toBe(marker(revision, "verdict", "0123456789abcdef", secret));
		expect(tiny).toContain(`This review was cut to fit GitHub's limit; \`melian findings "#7"\` lists them all.`);
	});

	it("keeps a lens from mentioning anyone", () => {
		const finding = createFinding({ ...input, explanation: { ...input.explanation, whatToDo: "Ask @octocat." } });
		const comment = renderComment(
			{ finding, placement: { kind: "lines", startLine: 12, line: 12 } },
			revision,
			links,
			secret,
		);
		expect(comment).toContain("Ask @​octocat.");
	});
});

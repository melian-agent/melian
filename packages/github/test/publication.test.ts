import { adjudicate, createFinding, defaultConfig, type FindingInput } from "@melian-agent/core";
import {
	blobUrl,
	marker,
	markersIn,
	maxBodyLength,
	parseMarker,
	renderComment,
	renderProse,
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

describe("links", () => {
	it("percent-encodes every character of a path outside the unreserved set, so a link cannot end early", () => {
		const url = blobUrl(links, revision, "src/a)b (c)/it's*!.ts", 3, 5);
		expect(url).toBe(`${links.web}/blob/${revision}/src/a%29b%20%28c%29/it%27s%2A%21.ts#L3-L5`);
		const finding = createFinding({ ...input, file: "src/a)b.ts" });
		const comment = renderComment({ finding, placement: { kind: "nearest", line: 1 } }, revision, links, secret);
		expect(comment).toContain(`(${links.web}/blob/${revision}/src/a%29b.ts#L12)`);
	});
});

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
		const review = parseMarker(marker(revision, "verdict", "0123456789abcdef", secret, 3))!;
		expect(review.round).toBe(3);
		expect(verifyMarker(review, secret)).toBe(true);
		expect(verifyMarker({ ...review, round: 1 }, secret)).toBe(false);
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
				round: 1,
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
			{ revision, kind: "verdict", id: "0123456789abcdef", round: 1, sig: expect.any(String) },
			{ revision, kind: "finding", id: finding.properties.id, sig: expect.any(String) },
		]);
		for (const each of [...markersIn(comment), ...markersIn(body)]) expect(verifyMarker(each, secret)).toBe(true);
		expect(comment).toContain("&lt;\\!-- melian:revision=");
		expect(body).toContain("`src/evil\\u000a<!-- melian.ts`");
	});

	it("makes the summary's verb agree with the number of findings", () => {
		const summary = (count: number) => {
			const findings = Array.from({ length: count }, (_, index) =>
				createFinding({ ...input, severity: "P2", resolution: "acknowledge", snippet: `eval(input${index})` }),
			);
			const body = renderReviewBody(
				{
					pullRequest: 7,
					revision,
					fingerprint: "0123456789abcdef",
					round: 1,
					verdict: adjudicate({ findings, manifest: [], checks: [], config: defaultConfig }),
					findings: [],
					stillOpen: 0,
					resolved: [],
					secret,
				},
				links,
			);
			return body.split("\n\n")[1];
		};

		expect(summary(1)).toBe("1 finding needs attention: 1 acknowledge.");
		expect(summary(2)).toBe("2 findings need attention: 2 acknowledge.");
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
			round: 1,
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
		expect(body.split("\n")[0]).toBe(marker(revision, "verdict", "0123456789abcdef", secret, 1));
		const kept = markersIn(body).filter((each) => each.kind === "finding").length;
		expect(kept).toBeGreaterThan(0);
		expect(body).toContain(
			`${12 - kept} findings did not fit in this review; \`melian findings "#7"\` lists them all.`,
		);
		expect(small.length).toBeLessThanOrEqual(400);
		expect(small).toContain(`12 findings did not fit in this review;`);
		expect(tiny.length).toBeLessThanOrEqual(260);
		expect(tiny.split("\n")[0]).toBe(marker(revision, "verdict", "0123456789abcdef", secret, 1));
		expect(tiny).toContain(`This review was cut to fit GitHub's limit; \`melian findings "#7"\` lists them all.`);
	});

	it("renders finding text as inert text, never live markdown, a mention, or a reference", () => {
		const payload = [
			"Click [here](https://evil.example/login) ![pixel](https://evil.example/p.png)",
			"# Approved by the maintainer",
			"> quoted",
			"```js",
			"alert(1)",
			"```",
			"~~~",
			"Fixes #123 and melian-agent/melian#45; cc @octocat and @melian-agent/maintainers.",
			"<img src=x onerror=alert(1)> **bold** _under_ | a | b | ~~strike~~ !bang \\*escaped\\*",
		].join("\n");
		const finding = createFinding({
			...input,
			message: payload,
			explanation: { what: payload, whyHere: payload, whatToDo: payload },
		});
		const comment = renderComment(
			{ finding, placement: { kind: "lines", startLine: 12, line: 12 } },
			revision,
			links,
			secret,
		);
		const rendered = renderProse(payload);

		expect(comment).toContain(rendered);
		// Every markdown control character is escaped, so no link, image, heading, emphasis, table, or fence survives.
		expect(rendered).not.toMatch(/(^|[^\\])[[\]()*_|~`!#]/m);
		expect(rendered).not.toMatch(/```|~~~/);
		expect(rendered).not.toMatch(/^#/m);
		expect(rendered).not.toContain("<");
		expect(rendered).toContain("&lt;img src=x onerror=alert\\(1\\)&gt;");
		expect(rendered).toContain("\\#\u2060123");
		expect(rendered).toContain("melian-agent/melian\\#\u206045");
		expect(rendered).toContain("@\u2060octocat");
		expect(rendered).toContain("@\u2060melian-agent/maintainers");
		expect(rendered).not.toMatch(/@[A-Za-z]/);
		// A backslash in the text is shown, not used to unescape what follows it.
		expect(rendered).toContain("\\\\\\*escaped\\\\\\*");
	});
});

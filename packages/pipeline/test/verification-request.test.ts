import { KeyedRequest } from "@melian-agent/core";
import { keyCoverage } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";
import {
	candidateKey,
	type VerificationCandidate,
	type VerificationInput,
	verificationRequest,
} from "../src/verification.ts";

const location = {
	file: "src/a.ts",
	startLine: 3,
	endLine: 4,
	role: "cause" as const,
	revision: "head" as const,
	deleted: true as const,
	proves: true as const,
	snippet: "x()",
};

const candidate: VerificationCandidate = {
	key: "lens.correctness@1@careful",
	state: {
		speaker: { properties: { id: "0123456789abcdef" }, message: { text: "speaker body" } } as never,
		claims: [
			{
				id: "0123456789abcdef",
				ruleId: "null-dereference",
				source: { check: "lens.correctness", version: "1@careful" },
				severity: "P1",
				failureScenario: "a null input throws",
				evidence: [location],
				verification: {
					verdict: "confirmed",
					reason: "it throws",
					executor: "llm",
					model: "openai/gpt",
					version: "v1",
				},
			},
		],
	},
	finder: "openai/gpt",
	route: [{ provider: "anthropic", modelId: "opus" }],
	thinking: "high",
	budget: { tokens: 300000, tools: 60 },
	decisionsAtBase: "decisions",
	designAtBase: { sections: "sections", files: "files" },
	fence: { coReported: false, silent: ["nit"] },
	reportedAt: { "0123456789abcdef lens.correctness@1@careful": "P1" },
	dismissed: [{ id: "fedcba9876543210", failureScenario: "an old scenario", evidence: [location] }],
	dismissals: { fedcba9876543210: "identity" },
};

const sample: VerificationInput = {
	root: 7 as unknown as VerificationInput["root"],
	revision: { repoRoot: "/repo", nonce: "n".repeat(24), base: "a".repeat(40), head: "b".repeat(40), files: [] },
	version: "verifier-1",
	candidates: [candidate],
	reused: { "some-key": { status: "done", model: "openai/gpt" } },
};

const vary = (_path: string, value: unknown) =>
	Array.isArray(value) ? ["x"] : typeof value === "object" && value !== null ? { x: "x" } : undefined;

describe("verificationRequest", () => {
	it("keys every input but the nonce, the reused outcomes, the shown dismissals, the verdicts and the speaker's body", () => {
		const excluded = [
			"revision.nonce",
			"reused",
			"candidates.0.dismissals",
			"candidates.0.state.claims.0.verification",
			"candidates.0.state.speaker.message",
		];
		expect(keyCoverage(verificationRequest, sample, { vary, excluded })).toEqual([]);
	});

	it("attaches a review with a fresh nonce to the same task", () => {
		const again = verificationRequest({ ...sample, revision: { ...sample.revision, nonce: "m".repeat(24) } });
		expect(again.key).toBe(verificationRequest(sample).key);
		expect(again.unkeyed).toEqual({ nonce: "m".repeat(24) });
		expect(again.producer).toBe("verification");
	});

	it("keys the tools and the line templates the verifier is given", () => {
		const { text } = verificationRequest(sample).request as {
			text: { tools: { name: string }[]; lines: string[] };
		};
		expect(text.tools.map(({ name }) => name)).toEqual(["read_file", "search", "list_files", "report_verdict"]);
		for (const tool of text.tools)
			expect(tool).toEqual({
				name: tool.name,
				description: expect.stringMatching(/\S/),
				parameters: expect.objectContaining({ type: "object" }),
			});
		expect(text.lines).toEqual([
			"Claim c1 finding <id>, reported at P1",
			"Claim c1 finding <id>",
			"Dismissed d1 finding <id>",
		]);
	});
});

describe("candidateKey", () => {
	it("keys every field of a candidate but its shown dismissals, its verdicts and its speaker's body", () => {
		const excluded = ["dismissals", "state.claims.0.verification", "state.speaker.message"];
		const keyed = (c: VerificationCandidate) => KeyedRequest.of("verification.candidate", { key: candidateKey(c) });
		expect(keyCoverage(keyed, candidate, { vary, excluded })).toEqual([]);
	});
});

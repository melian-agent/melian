import { KeyedRequest, type LensProbingWording, lensProbingWording } from "@melian-agent/core";
import { keyCoverage } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";
import { type ClaimProbe, evidenceWordingOf, probeClaimKey } from "../src/probing.ts";
import {
	candidateKey,
	type VerificationCandidate,
	type VerificationInput,
	verificationRequest,
} from "../src/verification.ts";
import { verifierVersion } from "../src/verification-instructions.ts";

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
	it("keys every input but the root, the checkout, the nonce, the reused outcomes, the shown dismissals, the verdicts and the speaker's body", () => {
		const excluded = [
			"root",
			"revision.repoRoot",
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

	it("attaches the same review from another checkout or storage to the same task", () => {
		const moved = verificationRequest({
			...sample,
			root: 8 as unknown as VerificationInput["root"],
			revision: { ...sample.revision, repoRoot: "/elsewhere/repo" },
		});
		expect(moved.key).toBe(verificationRequest(sample).key);
		expect(moved.request).not.toHaveProperty("root");
		expect(moved.request).not.toHaveProperty("revision.repoRoot");
	});

	// The probe reruns are what the verifier is shown of each claim's probe, so they are an input of its request.
	it("keys the probe reruns the verifier is shown, and a review with none as the empty value", () => {
		const ran = (exitCode: number) => ({
			result: { exitCode, signal: null, output: "out", truncated: false, timedOut: false },
			milliseconds: 5,
		});
		expect(verificationRequest(sample).request).toHaveProperty("reruns", {});
		const failed = verificationRequest(sample, { probe: ran(1) });
		expect(failed.request).toHaveProperty("reruns", { probe: ran(1) });
		expect(verificationRequest(sample, { probe: ran(0) }).key).not.toBe(failed.key);
		expect(verificationRequest(sample, { probe: { refused: "no sandbox" } }).key).not.toBe(failed.key);
		expect(verificationRequest(sample, {}).key).toBe(verificationRequest(sample).key);
	});

	it("keys the tools and the prompt the verifier is given", () => {
		const { text } = verificationRequest(sample).request as {
			text: { tools: { name: string }[]; prompt: string };
		};
		expect(text.tools.map(({ name }) => name)).toEqual(["read_file", "search", "list_files", "report_verdict"]);
		for (const tool of text.tools)
			expect(tool).toEqual({
				name: tool.name,
				description: expect.stringMatching(/\S/),
				parameters: expect.objectContaining({ type: "object" }),
			});
		const [lines] = text.prompt.split("\n\n## Claim c1's probe");
		expect(lines!.split("\n\n").slice(-3)).toEqual([
			"Claim c1 finding <id>, reported at P1",
			"Claim c2 finding <id>",
			"Dismissed d1 finding <id>",
		]);
	});

	// Round two of pull request #436: the headings around the base decisions and design, and the bodies' prefixes, were
	// shown to the verifier and keyed nowhere, so a changed heading reused a verification made under the old one.
	it("keys the headings and body prefixes the verifier is shown", () => {
		const keyed = JSON.stringify(verificationRequest(sample).request);
		for (const fragment of [
			"## Decisions at base\\n",
			"## Design sections at base\\n",
			"## Design files at base\\n",
			"Claim c1\\n",
			"Dismissed d1\\n",
		])
			expect(keyed).toContain(fragment);
	});
});

// Written by main's code at 512c8ae2, before lenses had probing wording of their own: a verification with no claim
// that rests on a probe was asked under the key, and the verifier's version, it had then. Issue #493 changed the shared
// evidence wording on purpose, for a probe that ended with no record of how, so these values moved once.
describe("a verification no probe evidence reaches", () => {
	it("keeps the key and the verifier's version main gave it", () => {
		expect(verifierVersion).toBe("acefd18046ef5d04");
		expect(verificationRequest(sample).key).toBe("aba29c85ec2348866566f1193683412d6adf5ed6abf0ec0957368505211dac66");
	});
});

describe("verificationRequest's probe evidence", () => {
	// Pull request #436, on merging the probing level: the verifier is shown a block of evidence per probing claim, and its
	// headings and wording reached no key, so a changed wording reused a verification judged under the old one.
	it("keys the probe evidence's wording and the blocks it renders", () => {
		const keyed = JSON.stringify(verificationRequest(sample).request);
		for (const wording of Object.values(evidenceWordingOf("trust-boundary")))
			expect(keyed).toContain(JSON.stringify(wording).slice(1, -1));
		const { text } = verificationRequest(sample).request as { text: { prompt: string } };
		const rests = (label: string, outcome: string, rerun: string) =>
			`## Claim ${label}'s probe\n\nClaim ${label} rests on probe <probe>, which the lens's prober wrote for attack 1 of the plan below. It ${outcome} when the prober ran it. ${rerun}`;
		expect(text.prompt).toContain(rests("c1", "failed, exiting 1", "Melian did not run it again."));
		expect(text.prompt).toContain(
			rests("c2", "failed, exiting 1", "Melian could not run it again; why is in the probe's block below."),
		);
		expect(text.prompt).toContain(rests("c3", "passed, exiting 0", "When Melian ran it again it failed, exiting 1."));
	});
});

const claimProbe: ClaimProbe = {
	id: "p1",
	attack: 1,
	plan: [{ target: "t", reason: "r", passing: "p", failing: "f" }],
	probe: {
		attack: 1,
		script: "process.exit(1)",
		files: [],
		result: { exitCode: 1, signal: null, output: "", truncated: false, timedOut: false },
		milliseconds: 1,
	},
	environment: {
		writer: { trusted: true, by: "reviewer" },
		trustWriters: true,
		read: [],
		host: { platform: "linux", sandbox: "bubblewrap", arch: "x64", node: "24.0.0" },
	},
};

// A candidate whose first claim, from `lens`, rests on a probe, beside a correctness claim that does not.
function probed(lens: string): VerificationInput {
	const [claim] = candidate.state.claims;
	const own = { ...claim!, id: "1111111111111111", source: { check: `lens.${lens}`, version: "1@deep" } };
	return {
		...sample,
		candidates: [
			{
				...candidate,
				state: { ...candidate.state, claims: [own, claim!] },
				probes: { [probeClaimKey(own)]: claimProbe },
			},
		],
	};
}

// Each lens that probes words how its verifier judges a probe, so a verification whose claims rest on probes keys the
// judgement of each claim's own lens, and one whose claims do not keys none.
describe("a verification of claims that rest on probes", () => {
	const words = lensProbingWording as Map<string, LensProbingWording>;
	const judgedBy = (lens: string) => lensProbingWording.get(lens)!.judge;

	it("keys the judgement of each probed claim's lens, and of no lens whose claims carry no probe", () => {
		expect(verificationRequest(probed("tests")).request).toHaveProperty("judges", { tests: judgedBy("tests") });
		expect(verificationRequest(probed("trust-boundary")).request).toHaveProperty("judges", {
			"trust-boundary": judgedBy("trust-boundary"),
		});
		expect(verificationRequest(sample).request).not.toHaveProperty("judges");
		const both = probed("tests");
		const [first] = both.candidates;
		const second = probed("correctness").candidates[0]!;
		const keyed = verificationRequest({ ...both, candidates: [first!, { ...second, key: "second" }] });
		expect(keyed.request).toHaveProperty("judges", {
			correctness: judgedBy("correctness"),
			tests: judgedBy("tests"),
		});
	});

	it("changes the key when the probed claim's lens changes its judgement, and no other lens's key", () => {
		const tests = verificationRequest(probed("tests")).key;
		const trustBoundary = verificationRequest(probed("trust-boundary")).key;
		const plain = verificationRequest(sample).key;
		const own = words.get("tests")!;
		words.set("tests", { ...own, judge: `${own.judge} Judge it again.` });
		try {
			expect(verificationRequest(probed("tests")).key).not.toBe(tests);
			expect(verificationRequest(probed("trust-boundary")).key).toBe(trustBoundary);
			expect(verificationRequest(sample).key).toBe(plain);
		} finally {
			words.set("tests", own);
		}
		expect(verificationRequest(probed("tests")).key).toBe(tests);
	});

	it("refuses to key a probed claim of a lens with no probing wording of its own", () => {
		expect(() => verificationRequest(probed("security"))).toThrow(
			"the security lens has no probing wording of its own, so it cannot probe",
		);
	});
});

describe("candidateKey", () => {
	it("keys every field of a candidate but its shown dismissals, its verdicts and its speaker's body", () => {
		const excluded = ["dismissals", "state.claims.0.verification", "state.speaker.message"];
		const keyed = (c: VerificationCandidate) => KeyedRequest.of("verification.candidate", { key: candidateKey(c) });
		expect(keyCoverage(keyed, candidate, { vary, excluded })).toEqual([]);
	});
});

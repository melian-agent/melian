import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Probing from "../src/probing.ts";
import { probeEvidenceBudget, probeEvidenceCutWording } from "../src/probing.ts";
import { verificationRequest } from "../src/verification.ts";
import { cutCandidate, cutRequest, cutReruns } from "./fixtures/verification-cut.ts";

// Stands in for a change to how evidence is cut: a budget no cut fits, or a cut marker worded another way, which only a
// rendering that cut a part holds.
const change = vi.hoisted(() => ({ budget: undefined as number | undefined, reword: false }));
vi.mock("../src/probing.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof Probing>();
	return {
		...actual,
		boundProbeEvidence: (...[evidence, nonce, budget]: Parameters<typeof actual.boundProbeEvidence>) => {
			const shown = actual.boundProbeEvidence(evidence, nonce, change.budget ?? budget);
			return change.reword ? shown?.map((block) => block.replaceAll("[Melian cut ", "[Melian removed ")) : shown;
		},
	};
});

afterEach(() => {
	change.budget = undefined;
	change.reword = false;
});

const plain = cutCandidate("lens.correctness@1@careful", "0123456789abcdef", undefined);
const fitting = cutCandidate("lens.trust-boundary@1@deep", "1123456789abcdef", "S");
const cut = cutCandidate("lens.trust-boundary@1@careful", "2123456789abcdef", "s".repeat(probeEvidenceBudget + 1));
const keyOf = (...candidates: ReturnType<typeof cutCandidate>[]) =>
	verificationRequest(cutRequest(candidates), cutReruns(candidates));

describe("verificationRequest's cut of probe evidence", () => {
	// Issue #357: keys main computed at 10cc833a, before cuts, for these requests, moved once by issue #488's fresh
	// failover wording. Issue #493 then changed the shared evidence wording on purpose, for a probe that ended with no
	// record of how and one that exited 125, so a verification stored before it is asked once more. A request whose
	// evidence fits also holds the sandbox release its probe environment names.
	it("keys a request with no probe evidence, and one whose evidence fits with the sandbox release its probe environment names", () => {
		expect(keyOf(plain).key).toBe("3f01e24f95e84cde75341e3d471f821dc1442535b1ec274c2e40470dd29c2896");
		expect(keyOf(fitting).key).toBe("86fe77ab08a202b726da977f2f0ab18fed29979ed762dede4f168e059f47a823");
		expect(keyOf(plain, fitting).key).toBe("baf89bdaf9e322e3126f1566863445ac31ffa60b476cc0c6e15d379e11d0dd5c");
		expect(keyOf(plain, fitting).request).not.toHaveProperty("cuts");
	});

	it("keys the evidence a cut candidate's verifier is shown, and no cut for a candidate whose evidence fits", () => {
		const { cuts } = keyOf(plain, cut, fitting).request as { cuts: Record<string, string> };
		expect(Object.keys(cuts)).toEqual([cut.key]);
		expect(cuts[cut.key]).toContain("## Claim c1's probe");
		expect(cuts[cut.key]).toContain(probeEvidenceCutWording.conclude);
		expect(cuts[cut.key]).toMatch(/\n\[Melian cut \d+ bytes here\]\n/);
		expect(Buffer.byteLength(cuts[cut.key]!)).toBeLessThanOrEqual(probeEvidenceBudget);
		// The key's fixed nonce stands in for the review's, which is drawn afresh on every review.
		expect(cuts[cut.key]).not.toContain("n".repeat(24));
	});

	// Round 2's design finding on this pull request: a key that held a cut over fixed samples missed a change the samples
	// did not exercise. The key now holds the cut each candidate is shown, so any change that reaches a prompt reaches it.
	it("changes the key of a request whose candidate's cut renders differently, and of no request without one", () => {
		const before = [keyOf(cut), keyOf(cut, fitting), keyOf(fitting), keyOf(plain)].map(({ key }) => key);
		change.reword = true;
		const after = [keyOf(cut), keyOf(cut, fitting), keyOf(fitting), keyOf(plain)].map(({ key }) => key);
		expect(after[0]).not.toBe(before[0]);
		expect(after[1]).not.toBe(before[1]);
		expect(after.slice(2)).toEqual(before.slice(2));
	});

	// Codex's third review on this pull request: evidence holding the key's fixed nonce, here a script of zeroes, renders
	// shorter under it than under the review's own nonce, so the key saw no cut where the verifier was shown one.
	it("keys the cut the verifier is shown under the review's nonce, whatever the head's text holds", () => {
		const zeroes = cutCandidate(
			"lens.trust-boundary@1@deep",
			"3123456789abcdef",
			"0".repeat(probeEvidenceBudget - 100),
		);
		const under = (nonce: string) => {
			const request = cutRequest([zeroes]);
			return verificationRequest({ ...request, revision: { ...request.revision, nonce } }, cutReruns([zeroes]));
		};
		const { cuts } = under("n".repeat(24)).request as { cuts?: Record<string, string> };
		expect(cuts?.[zeroes.key]).toMatch(/\n\[Melian cut \d+ bytes here\]\n/);
		expect(cuts?.[zeroes.key]).not.toContain("n".repeat(24));
		expect(under("m".repeat(24)).key).toBe(under("n".repeat(24)).key);
	});

	it("keys a candidate no cut fits by why it is asked nothing, the same under every cut that refuses it", () => {
		const shown = keyOf(cut).key;
		change.budget = 1;
		const refused = keyOf(cut);
		expect((refused.request as { cuts: Record<string, string> }).cuts).toEqual({
			[cut.key]: expect.stringMatching(
				new RegExp(`^Melian did not ask the verifier: .* 1 probing claim passes the ${probeEvidenceBudget} bytes`),
			),
		});
		expect(refused.key).not.toBe(shown);
		expect(keyOf(cut).key).toBe(refused.key);
		change.budget = 2;
		expect(keyOf(cut).key).toBe(refused.key);
	});
});

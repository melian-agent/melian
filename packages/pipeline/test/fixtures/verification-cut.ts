import type { ClaimProbe, ProbeRun } from "../../src/probing.ts";
import { probeClaimKey, rerunKey } from "../../src/probing.ts";
import type { VerificationCandidate, VerificationInput } from "../../src/verification.ts";

// Requests whose keys main recorded before cuts existed, so a test can hold this build to them byte for byte.

const location = {
	file: "src/a.ts",
	startLine: 3,
	endLine: 4,
	role: "cause" as const,
	revision: "head" as const,
	proves: true as const,
	snippet: "x()",
};

const claim = (id: string) => ({
	id,
	ruleId: "trust-boundary",
	source: { check: "lens.trust-boundary", version: "1@deep" },
	severity: "P1" as const,
	failureScenario: "a head reads the reviewer's secret",
	evidence: [location],
});

const probe = (id: string, script: string): ClaimProbe => ({
	id,
	attack: 1,
	environment: {
		writer: { trusted: true, by: "reviewer" },
		trustWriters: true,
		read: [],
		host: { platform: "linux", sandbox: "unconfined", arch: "x64", node: "24.0.0" },
	},
	plan: [{ target: "t", reason: "r", passing: "p", failing: "f" }],
	probe: {
		attack: 1,
		script,
		files: [{ path: "fixture/a.txt", text: "A" }],
		result: { exitCode: 1, signal: null, output: "leaked", truncated: false, timedOut: false },
		milliseconds: 5,
	},
});

// A candidate of one claim, whose probe has `script`, or with no probe when `script` is undefined.
export function cutCandidate(key: string, id: string, script: string | undefined): VerificationCandidate {
	const claimed = claim(id);
	return {
		key,
		state: { speaker: { properties: { id }, message: { text: "speaker body" } } as never, claims: [claimed] },
		finder: "openai/gpt",
		route: [{ provider: "anthropic", modelId: "opus" }],
		thinking: "high",
		budget: { tokens: 300000, tools: 60 },
		...(script === undefined ? {} : { probes: { [probeClaimKey(claimed)]: probe(`p-${id}`, script) } }),
	};
}

export function cutRequest(candidates: VerificationCandidate[]): VerificationInput {
	return {
		root: 7 as unknown as VerificationInput["root"],
		revision: { repoRoot: "/repo", nonce: "n".repeat(24), base: "a".repeat(40), head: "b".repeat(40), files: [] },
		version: "verifier-1",
		candidates,
	};
}

export function cutReruns(candidates: VerificationCandidate[]): Record<string, ProbeRun> {
	return Object.fromEntries(
		candidates.flatMap(({ state, probes }) =>
			state.claims.flatMap((claimed) => {
				const ran = probes?.[probeClaimKey(claimed)];
				if (ran === undefined) return [];
				const again = { exitCode: 1, signal: null, output: "leaked again", truncated: false, timedOut: false };
				return [[rerunKey(claimed, ran), { result: again, milliseconds: 4 }]];
			}),
		),
	);
}

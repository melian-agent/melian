import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

// The verifier's version renders these samples when its module loads, so each test loads the modules itself: a sample
// that fails to render then fails the test, not the file.
const golden = readFileSync(new URL("./golden/probe-evidence.txt", import.meta.url), "utf8");

it("renders every probe evidence on every branch as the golden holds it, the same on a second call", async () => {
	vi.resetModules();
	const { probeEvidenceRenderings } = await import("../src/probing.ts");
	const evidence = probeEvidenceRenderings();
	expect(evidence).toBe(golden);
	expect(probeEvidenceRenderings()).toBe(evidence);
});

it("gives the verifier's version the evidence renderings the golden holds", async () => {
	vi.resetModules();
	const instructions = await import("../src/verification-instructions.ts");
	const { probeEvidenceWording, probingWording } = await import("../src/probing.ts");
	const { verificationQuestions } = await import("@melian-agent/core");
	expect(instructions.verifierVersion).toBe(
		instructions.computeVerifierVersion(
			instructions.verifierInstructions,
			instructions.reportVerdictSchema,
			verificationQuestions,
			{ ...probeEvidenceWording, planRow: probingWording.planRow, renderings: golden },
		),
	);
});

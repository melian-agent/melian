import { describe, expect, it, vi } from "vitest";

// No top-level import of the module: a broken definition fails this test rather than the file's load.
describe("verification waves document", () => {
	it("defines its document under the kind and version stored reviews hold", async () => {
		vi.resetModules();
		const { VerificationWavesDocument } = await import("../src/verification-waves.ts");
		expect(VerificationWavesDocument.definition).toMatchObject({
			kind: "melian.verification-waves",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
		});
	});
});

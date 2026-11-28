import { describe, expect, it, vi } from "vitest";

// The verifier's version is computed as its module loads, from the trust-boundary lens's evidence wording, so this test
// loads the module itself to bring a failed wording lookup under a test rather than fail every file that imports it.
describe("the verifier's version, as its module loads", () => {
	it("is the version issue #655's instructions and the trust-boundary lens's own evidence wording give it", async () => {
		vi.resetModules();
		const { verifierVersion } = await import("../src/verification-instructions.ts");
		expect(verifierVersion).toBe("99ad713f6541bc24");
	});
});

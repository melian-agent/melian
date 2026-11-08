import { rmSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

// A cloud session passes git configuration through GIT_CONFIG_COUNT. These entries make every commit fail, so a
// fixture repository builds only when the module's git environment clears them.
const injected = {
	GIT_CONFIG_COUNT: "2",
	GIT_CONFIG_KEY_0: "commit.gpgsign",
	GIT_CONFIG_VALUE_0: "true",
	GIT_CONFIG_KEY_1: "gpg.program",
	GIT_CONFIG_VALUE_1: "false",
};

afterEach(() => {
	vi.unstubAllEnvs();
});

it("builds a golden's repository whatever git configuration the environment injects", async () => {
	for (const [name, value] of Object.entries(injected)) vi.stubEnv(name, value);
	vi.resetModules();
	const { buildGoldenRepository, loadGoldens } = await import("../src/goldens.ts");
	const { repo } = buildGoldenRepository(loadGoldens()[0]!);
	rmSync(repo, { recursive: true, force: true });
});

it("runs a resolution golden whatever git configuration the environment injects", { timeout: 60_000 }, async () => {
	for (const [name, value] of Object.entries(injected)) vi.stubEnv(name, value);
	vi.resetModules();
	const { loadResolutionGoldens, runResolutionGolden } = await import("../src/resolution.ts");
	await expect(runResolutionGolden(loadResolutionGoldens()[0]!)).resolves.toBeDefined();
});

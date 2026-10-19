import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { liveModels } from "../src/credentials.ts";
import { reportVerifierGoldens } from "../src/live-output.ts";
import { EvalThinking } from "../src/thinking.ts";
import { runVerifierGolden } from "../src/verifier.ts";

vi.mock("../src/credentials.ts", () => ({ liveModels: vi.fn() }));
vi.mock("../src/live-output.ts", () => ({
	reportVerifierGoldens: vi.fn(),
	reportGoldens: vi.fn(),
	reportTriageGoldens: vi.fn(),
}));
vi.mock("../src/verifier.ts", { spy: true });

const stopped = new Error("stopped at process.exit");
const requested = new Error("stopped at fake verifier");
const fake = createFakeModels();

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.stubEnv("MELIAN_EVAL_LIVE", "1");
	vi.stubEnv("MELIAN_EVAL_VERIFIER", "1");
	vi.stubEnv("MELIAN_EVAL_MODEL", "faux/faux-1");
	vi.stubEnv("MELIAN_EVAL_VERIFIER_MODEL", undefined);
	vi.stubEnv("MELIAN_EVAL_GOLDEN", undefined);
	vi.stubEnv("MELIAN_EVAL_THINKING", "verifier=high");
	vi.spyOn(process, "exit").mockImplementation(() => {
		throw stopped;
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.mocked(liveModels).mockResolvedValue(fake.review);
	vi.mocked(runVerifierGolden).mockRejectedValue(requested);
	vi.mocked(reportVerifierGoldens).mockImplementation(async (goldens, run) => {
		await run(goldens[0]!);
		return { scores: [], failed: [], status: 0 };
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("parses thinking and passes the complete live mode to the verifier callback", async () => {
	await expect(vi.importActual("../src/live.ts")).rejects.toBe(requested);
	expect(liveModels).toHaveBeenCalledOnce();
	expect(runVerifierGolden).toHaveBeenCalledOnce();
	const mode = vi.mocked(runVerifierGolden).mock.calls[0]![1];
	expect(mode).toEqual({
		kind: "live",
		models: fake.review,
		model: "faux/faux-1",
		verifierModel: undefined,
		thinking: EvalThinking.parse("verifier=high"),
	});
});

it("prints an invalid thinking error and exits before opening credentials", async () => {
	vi.stubEnv("MELIAN_EVAL_THINKING", "verifier=invalid");
	await expect(vi.importActual("../src/live.ts")).rejects.toBe(stopped);
	expect(console.error).toHaveBeenCalledExactlyOnceWith(
		'MELIAN_EVAL_THINKING needs distinct tier=level entries; invalid entry "verifier=invalid"',
	);
	expect(process.exit).toHaveBeenCalledExactlyOnceWith(2);
	expect(liveModels).not.toHaveBeenCalled();
	expect(runVerifierGolden).not.toHaveBeenCalled();
});

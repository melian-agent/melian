import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { liveModels } from "../src/credentials.ts";
import { reportTriageGoldens, reportVerifierGoldens } from "../src/live-output.ts";
import { EvalThinking } from "../src/thinking.ts";
import { TriageResults } from "../src/triage.ts";
import { runVerifierGolden } from "../src/verifier.ts";
// Vitest needs a static edge to select this entry for related mutation runs.
import "../src/live.ts";

vi.mock("../src/live.ts", () => ({}));
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
	vi.stubEnv("MELIAN_EVAL_TRIAGE", undefined);
	vi.stubEnv("MELIAN_EVAL_TRIAGE_BASELINE", undefined);
	vi.stubEnv("MELIAN_EVAL_TRIAGE_OUT", undefined);
	vi.stubEnv("MELIAN_EVAL_MODEL", "faux/faux-1");
	vi.stubEnv("MELIAN_EVAL_VERIFIER_MODEL", undefined);
	vi.stubEnv("MELIAN_EVAL_GOLDEN", undefined);
	vi.stubEnv("MELIAN_EVAL_THINKING", "verifier=high");
	vi.spyOn(process, "exit").mockImplementation(() => {
		throw stopped;
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
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

it.each([
	["verifier=invalid", "verifier=invalid"],
	[`heavy=${String.fromCharCode(0x202e)}fake`, "heavy=\\u202efake"],
	[`heavy=${String.fromCharCode(0x2028)}fake`, "heavy=\\u2028fake"],
	[`heavy=${String.fromCharCode(0x0085)}fake`, "heavy=\\u0085fake"],
])("prints escaped invalid thinking %s before opening credentials", async (entry, escaped) => {
	vi.stubEnv("MELIAN_EVAL_THINKING", entry);
	await expect(vi.importActual("../src/live.ts")).rejects.toBe(stopped);
	expect(console.error).toHaveBeenCalledExactlyOnceWith(
		`MELIAN_EVAL_THINKING needs distinct tier=level entries; invalid entry "${escaped}"`,
	);
	expect(process.exit).toHaveBeenCalledExactlyOnceWith(2);
	expect(liveModels).not.toHaveBeenCalled();
	expect(runVerifierGolden).not.toHaveBeenCalled();
});

it.each([
	[0x202e, "\\u202e"],
	[0x2028, "\\u2028"],
	[0x0085, "\\u0085"],
] as const)("prints escaped baseline thinking containing U+%s", async (code, escaped) => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-thinking-baseline-")));
	const baseline = join(directory, "baseline.json");
	const current = TriageResults.measure([], {}, { model: "faux/faux-1", fingerprint: "test" });
	writeFileSync(baseline, JSON.stringify({ ...current.toJSON(), thinking: `heavy=${String.fromCharCode(code)}fake` }));
	vi.stubEnv("MELIAN_EVAL_VERIFIER", undefined);
	vi.stubEnv("MELIAN_EVAL_TRIAGE", "1");
	vi.stubEnv("MELIAN_EVAL_TRIAGE_BASELINE", baseline);
	vi.stubEnv("MELIAN_EVAL_THINKING", "");
	vi.mocked(reportTriageGoldens).mockResolvedValue(current);
	try {
		await expect(vi.importActual("../src/live.ts")).rejects.toBe(stopped);
		expect(console.log).toHaveBeenCalledExactlyOnceWith(
			`incomparable: version ${current.questionSet.version} -> ${current.questionSet.version}; mean distance 0.00 -> 0.00; exact 0.00 -> 0.00; under 0 -> 0; incomparable: the triage thinking differs, heavy=${escaped}fake -> unset`,
		);
		expect(process.exit).toHaveBeenCalledExactlyOnceWith(2);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

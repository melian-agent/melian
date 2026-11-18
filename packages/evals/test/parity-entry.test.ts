import type * as pipeline from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { liveModels } from "../src/credentials.ts";
import { runRange } from "../src/goldens.ts";
import { checkoutCommit, measureParity } from "../src/parity.ts";

const availability = vi.hoisted(() => vi.fn());
vi.mock("@melian-agent/pipeline", async (original) => ({
	...(await original<typeof pipeline>()),
	Probe: { availability },
}));
vi.mock("../src/credentials.ts", () => ({ liveModels: vi.fn() }));
vi.mock("../src/parity.ts", () => ({ measureParity: vi.fn(), checkoutCommit: vi.fn() }));
// Spied, so the entry's fresh import after vi.resetModules hands it these functions.
vi.mock("../src/goldens.ts", { spy: true });

const stopped = new Error("stopped at process.exit");
const fake = createFakeModels();

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.spyOn(process, "exit").mockImplementation(() => {
		throw stopped;
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("refuses to start without MELIAN_EVAL_LIVE=1, before it measures anything", async () => {
	vi.stubEnv("MELIAN_EVAL_LIVE", "true");
	await expect(import("../src/parity-live.ts")).rejects.toBe(stopped);
	expect(console.error).toHaveBeenCalledExactlyOnceWith(
		"Live evals call real models and spend tokens. Set MELIAN_EVAL_LIVE=1 to run them.",
	);
	expect(process.exit).toHaveBeenCalledExactlyOnceWith(2);
	expect(measureParity).not.toHaveBeenCalled();
});

it("measures with the host's probe availability, live models, the range runner and the checkout's commit", async () => {
	vi.stubEnv("MELIAN_EVAL_LIVE", "1");
	vi.mocked(measureParity).mockResolvedValue(3);
	vi.mocked(liveModels).mockResolvedValue(fake.review);
	availability.mockResolvedValue({ available: false, reason: "no sandbox" });
	await expect(import("../src/parity-live.ts")).rejects.toBe(stopped);
	expect(process.exit).toHaveBeenCalledExactlyOnceWith(3);
	expect(console.error).not.toHaveBeenCalled();
	expect(measureParity).toHaveBeenCalledOnce();
	const [env, runners, print, printError] = vi.mocked(measureParity).mock.calls[0]!;
	expect(env).toBe(process.env);
	expect(print).toBe(console.log);
	expect(printError).toBe(console.error);
	expect(runners.range).toBe(runRange);
	expect(runners.commit).toBe(checkoutCommit);
	expect(await runners.availability()).toEqual({ available: false, reason: "no sandbox" });
	expect(availability).toHaveBeenCalledExactlyOnceWith();
	expect(await runners.models()).toBe(fake.review);
	expect(liveModels).toHaveBeenCalledExactlyOnceWith(process.cwd());
});

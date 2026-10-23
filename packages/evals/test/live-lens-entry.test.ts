import { createFakeModels, fauxAssistantMessage, systemPromptOf } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { liveModels } from "../src/credentials.ts";

vi.mock("../src/credentials.ts", () => ({ liveModels: vi.fn() }));

const stopped = new Error("stopped at process.exit");

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("MELIAN_EVAL_LIVE", "1");
	vi.stubEnv("MELIAN_EVAL_VERIFIER", undefined);
	vi.stubEnv("MELIAN_EVAL_VERIFIER_MODEL", undefined);
	vi.stubEnv("MELIAN_EVAL_TRIAGE", undefined);
	vi.stubEnv("MELIAN_EVAL_TRIAGE_OUT", undefined);
	vi.stubEnv("MELIAN_EVAL_TRIAGE_BASELINE", undefined);
	vi.stubEnv("MELIAN_EVAL_MODEL", "faux/faux-1");
	vi.spyOn(process, "exit").mockImplementation(() => {
		throw stopped;
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("forwards environment thinking through the live lens entry to the fake request body", async () => {
	vi.stubEnv("MELIAN_EVAL_GOLDEN", "correctness-deleted-rethrow");
	vi.stubEnv("MELIAN_EVAL_THINKING", "heavy=medium");
	const fake = createFakeModels();
	vi.mocked(liveModels).mockResolvedValue(fake.review);
	const received: object[] = [];
	fake.provider.setResponses([
		async (request, options, _state, model) => {
			expect(systemPromptOf(request.messages)).toContain("correctness reviewer");
			const body = { reasoning: { effort: options?.reasoning } };
			received.push(body);
			await options?.onPayload?.(body, model);
			return fauxAssistantMessage("Done.");
		},
	]);
	await expect(import("../src/live.ts")).rejects.toBe(stopped);
	expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
	expect(liveModels).toHaveBeenCalledOnce();
	expect(received).toEqual([{ reasoning: { effort: "medium" } }]);
}, 60_000);

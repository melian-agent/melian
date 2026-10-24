import { createFakeModels, fauxAssistantMessage, fauxToolCall, systemPromptOf } from "@melian-agent/pipeline/testing";
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

it("forwards environment thinking through the live triage entry to the fake request body", async () => {
	vi.stubEnv("MELIAN_EVAL_TRIAGE", "1");
	vi.stubEnv("MELIAN_EVAL_GOLDEN", "add-test-only");
	vi.stubEnv("MELIAN_EVAL_TRIAGE_PASSES", "1");
	vi.stubEnv("MELIAN_EVAL_THINKING", "light=high");
	const fake = createFakeModels();
	vi.mocked(liveModels).mockResolvedValue(fake.review);
	const received: object[] = [];
	fake.provider.setResponses([
		async (request, options, _state, model) => {
			expect(systemPromptOf(request.messages)).toContain("You answer typed questions");
			const body = { reasoning: { effort: options?.reasoning } };
			received.push(body);
			await options?.onPayload?.(body, model);
			const prompt = request.messages
				.filter((message) => message.role === "user")
				.map((message) => message.content)
				.join("\n");
			const questions = [...prompt.matchAll(/^### (.+)$/gm)].map((match) => match[1]!);
			expect(questions.length).toBeGreaterThan(0);
			return fauxAssistantMessage(
				fauxToolCall("answer", {
					answers: questions.map((question) => ({
						question,
						probabilities: [{ option: "careful", probability: 1 }],
					})),
				}),
				{ stopReason: "toolUse" },
			);
		},
	]);
	await expect(import("../src/live.ts")).rejects.toBe(stopped);
	expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
	expect(liveModels).toHaveBeenCalledOnce();
	expect(received).toEqual([{ reasoning: { effort: "high" } }]);
}, 60_000);

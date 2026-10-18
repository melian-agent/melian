import { createFakeModels, fauxAssistantMessage } from "@melian-agent/pipeline/testing";
import { expect, it, vi } from "vitest";
import { createMemoryStorage } from "../src/harness.ts";
import { ConversationUsageRecorder, ReasoningCapture } from "../src/reasoning.ts";
import { TokenUsage } from "../src/token-usage.ts";

it("preserves the stream receiver when ending a decorated stream", async () => {
	const fake = createFakeModels();
	fake.provider.setResponses([fauxAssistantMessage("Provider reply")]);
	const model = fake.provider.getModel();
	const input = { messages: [] };
	const stream = fake.models.streamSimple(model, input);
	vi.spyOn(fake.models, "streamSimple").mockReturnValue(stream);
	const recorder = new ConversationUsageRecorder(createMemoryStorage());
	const decorated = recorder.models(fake.models).streamSimple(model, input);
	const reply = fauxAssistantMessage("Ended by the caller");
	decorated.end(reply);
	expect(await stream.result()).toBe(reply);
});

it("calls catalogue methods with the underlying collection as receiver", () => {
	const fake = createFakeModels();
	const getModels = vi.spyOn(fake.models, "getModels");
	const recorder = new ConversationUsageRecorder(createMemoryStorage());
	const models = recorder.models(fake.models);
	expect(models.getModels()).toEqual([fake.provider.getModel()]);
	expect(getModels.mock.contexts).toHaveLength(1);
	expect(getModels.mock.contexts[0]).toBe(fake.models);
});

it("stores no catalogue mapping when the requested level has none", () => {
	const fake = createFakeModels();
	const capture = new ReasoningCapture({ ...fake.provider.getModel(), thinkingLevelMap: {} }, "off");
	const reply = fauxAssistantMessage("Done");
	const reasoning = capture.finish(reply);
	const usage = new TokenUsage();
	usage.add("faux/model", reply.usage, reasoning);
	expect(usage.toJSON().requests![0]!.reasoning).toStrictEqual({
		requested: "off",
		source: "derived, not observed",
		sent: [],
	});
});

it("keeps an observed body separate from its catalogue mapping", async () => {
	const fake = createFakeModels();
	const model = { ...fake.provider.getModel(), thinkingLevelMap: { off: "none" } };
	const capture = new ReasoningCapture(model, "off");
	await capture.options().onPayload!({ reasoning: { effort: "high" } }, model);
	expect(capture.finish(fauxAssistantMessage("Done"))).toStrictEqual({
		requested: "off",
		source: "observed",
		sent: [{ reasoning: { effort: "high" } }],
	});
});

import { StageTelemetry, TokenUsage } from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage } from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";
import { ReasoningCapture } from "../src/reasoning.ts";

it.each([
	{ vendor: { thinking: { budget: "private" } } },
	{ vendor: { reasoning_effort: "private" } },
	{ vendor: { reasoning: "private" } },
	{ vendor: { output_config: { effort: "private" } } },
	{ vendor: { promptMode: "private" } },
	{ vendor: { prompt_mode: "private" } },
	{ vendor: { chat_template_kwargs: { enabled: "private" } } },
	{ vendor: { chat_template_args: { enabled: "private" } } },
	{ vendor: [{ THINKING_LEVEL: "private" }] },
])("marks an unmatched reasoning field as unrecognised: %j", async (body) => {
	const model = createFakeModels().provider.getModel();
	const capture = new ReasoningCapture(model, "high");
	await capture.options().onPayload!(body, model);
	const recorded = capture.finish(fauxAssistantMessage("Done"));
	expect(recorded).toEqual({ requested: "high", source: "unrecognised", sent: [{}] });
	expect(JSON.stringify(recorded)).not.toContain("private");
});

it("keeps recognised settings while marking partial capture across callbacks", async () => {
	const model = createFakeModels().provider.getModel();
	const capture = new ReasoningCapture(model, "high");
	const hook = capture.options().onPayload!;
	await hook({ reasoning: { effort: "high" }, vendor: { thinking: "private" } }, model);
	await hook({ reasoning: { effort: "low" } }, model);
	await hook({}, model);
	const recorded = capture.finish(fauxAssistantMessage("Done"));
	expect(recorded).toEqual({
		requested: "high",
		source: "unrecognised",
		sent: [{ reasoning: { effort: "high" } }, { reasoning: { effort: "low" } }, "provider default"],
	});
	expect(JSON.stringify(recorded)).not.toContain("private");
	const usage = new TokenUsage();
	usage.add("faux/model", fauxAssistantMessage("Done").usage, recorded);
	const telemetry = new StageTelemetry("revision", [
		{
			id: "probe",
			task: 1,
			name: "melian.lens",
			subject: "probe",
			outcome: "completed",
			timing: "unavailable",
			reused: false,
			resumed: false,
			usage: usage.toJSON(),
		},
	]);
	expect(telemetry.models()).toBe(
		"faux/model requested=high effort=high / effort=low / provider default unrecognised",
	);
	expect(telemetry.render()).toContain("unrecognised");
	expect(JSON.stringify(telemetry)).toContain('"source":"unrecognised"');
});

it.each([
	"messages",
	"input",
	"contents",
	"content",
	"prompt",
	"system",
	"systemInstruction",
	"instructions",
	"tools",
	"toolConfig",
	"schema",
	"json_schema",
	"responseSchema",
	"responseJsonSchema",
	"parameters",
	"metadata",
	"headers",
])("ignores reasoning-shaped user data beneath %s", async (field) => {
	const model = createFakeModels().provider.getModel();
	const capture = new ReasoningCapture(model, "off");
	await capture.options().onPayload!({ envelope: { [field]: { thinking: "private" } } }, model);
	expect(capture.finish(fauxAssistantMessage("Done"))).toEqual({
		requested: "off",
		source: "observed",
		sent: ["provider default"],
	});
});

it.each([
	null,
	undefined,
	0,
	"thinking",
	{ vendor: null },
	{
		vendor: {
			custom_prompt_mode: "private",
			prompt_mode_extra: "private",
			custom_chat_template_kwargs: "private",
			chat_template_kwargs_extra: "private",
		},
	},
	{ vendor: { effort: undefined } },
	{
		config: { thinkingConfig: { thinkingBudget: 0 } },
		reasoning: { effort: "high" },
	},
])("does not mark recognised or absent fields as unknown: %j", async (body) => {
	const model = createFakeModels().provider.getModel();
	const capture = new ReasoningCapture(model, "off");
	await capture.options().onPayload!(body, model);
	expect(capture.finish(fauxAssistantMessage("Done")).source).toBe("observed");
});

it.each(["replace unknown", "replace known"])("examines the previous callback's %s body", async (mode) => {
	const model = createFakeModels().provider.getModel();
	const capture = new ReasoningCapture(model, "high");
	const unknown = { vendor: { thinking: "private" } };
	const known = { reasoning: { effort: "high" } };
	const replacement = mode === "replace unknown" ? known : unknown;
	const original = mode === "replace unknown" ? unknown : known;
	expect(await capture.options(async () => replacement).onPayload!(original, model)).toBe(replacement);
	expect(capture.finish(fauxAssistantMessage("Done"))).toEqual({
		requested: "high",
		source: mode === "replace unknown" ? "observed" : "unrecognised",
		sent: [mode === "replace unknown" ? known : {}],
	});
});

it("does not confuse a dotted parameter name with a captured nested path", async () => {
	const model = createFakeModels().provider.getModel();
	const capture = new ReasoningCapture(model, "high");
	await capture.options().onPayload!(
		{
			config: { thinkingConfig: { thinkingBudget: 1 } },
			"config.thinkingConfig": "private",
		},
		model,
	);
	expect(capture.finish(fauxAssistantMessage("Done"))).toEqual({
		requested: "high",
		source: "unrecognised",
		sent: [{ "config.thinkingConfig": { thinkingBudget: 1 } }],
	});
});

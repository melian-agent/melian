import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RequestReasoning } from "@melian-agent/core";
import { StageTelemetry, TokenUsage } from "@melian-agent/pipeline";
import { fauxAssistantMessage } from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";
import type { Api, Model } from "../src/harness.ts";
import { ReasoningCapture } from "../src/reasoning.ts";

type Probe = {
	model: Model<Api>;
	payloads: unknown[];
	fetches: number;
	error: string;
	reasoning: RequestReasoning;
};

function probeAdapters(mode: string): { apis: string[]; probes: Probe[] } {
	// Node resolves the AWS SDK's node export; Vite selects its broken extensionless ESM build.
	return JSON.parse(
		execFileSync(
			process.execPath,
			[
				"--conditions=@melian-agent/source",
				fileURLToPath(new URL("./fixtures/reasoning-adapters.ts", import.meta.url)),
				mode,
			],
			{ encoding: "utf8", timeout: 20000 },
		),
	);
}

it("captures the installed Bedrock adapter's adaptive effort", async () => {
	const probe = probeAdapters("bedrock").probes[0]!;
	expect(probe.error).toContain("offline Bedrock payload captured");
	expect(probe.fetches).toBe(0);
	expect(probe.payloads).toMatchObject([
		{
			additionalModelRequestFields: {
				thinking: { type: "adaptive" },
				output_config: { effort: "high" },
			},
		},
	]);
	const capture = new ReasoningCapture(probe.model, "high");
	await capture.options().onPayload!(probe.payloads[0], probe.model);
	const reasoning = capture.finish(fauxAssistantMessage("Done"));
	expect(reasoning).toEqual(probe.reasoning);
	expect(reasoning).toMatchObject({
		source: "observed",
		sent: [
			{
				"additionalModelRequestFields.thinking": expect.objectContaining({ type: "adaptive" }),
				"additionalModelRequestFields.output_config.effort": "high",
			},
		],
	});
	const usage = new TokenUsage();
	usage.add("amazon-bedrock/claude", fauxAssistantMessage("Done").usage, reasoning);
	const telemetry = new StageTelemetry("revision", [
		{
			id: "probe",
			task: 1,
			name: "melian.lens",
			subject: "test",
			outcome: "completed",
			timing: "unavailable",
			reused: false,
			resumed: false,
			usage: usage.toJSON(),
		},
	]);
	expect(telemetry.models()).toBe("amazon-bedrock/claude requested=high effort=high observed");
});

it("captures a non-off request from every installed adapter with a reasoning model", async () => {
	const { apis, probes } = probeAdapters("all");
	const installed = readdirSync(new URL("../../../node_modules/@earendil-works/pi-ai/dist/api/", import.meta.url));
	expect(apis.length).toBeGreaterThan(0);
	expect(probes.map((probe) => probe.model.api)).toEqual(apis);
	for (const probe of probes) {
		expect(installed, probe.model.api).toContain(`${probe.model.api}.js`);
		expect(probe.payloads, probe.error).toHaveLength(1);
		expect(probe.fetches, probe.model.api).toBe(probe.model.api === "bedrock-converse-stream" ? 0 : 1);
		expect(probe.reasoning.source, probe.model.api).toBe("observed");
		expect(probe.reasoning.requested).toBe("high");
		expect(probe.reasoning.sent, probe.model.api).toHaveLength(1);
		expect(probe.reasoning.sent[0], probe.model.api).not.toBe("provider default");
		expect(Object.keys(probe.reasoning.sent[0]!), probe.model.api).not.toHaveLength(0);
		expect(probe.reasoning.sent[0], probe.model.api).not.toHaveProperty("unrecognised");
		const capture = new ReasoningCapture(probe.model, "high");
		await capture.options().onPayload!(probe.payloads[0], probe.model);
		expect(capture.finish(fauxAssistantMessage("Done")), probe.model.api).toEqual(probe.reasoning);
	}
});

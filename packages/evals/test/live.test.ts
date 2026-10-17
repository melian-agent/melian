import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	textOf,
} from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";
import { reportTriageGoldens } from "../src/live-output.ts";
import { loadTriageGoldens } from "../src/triage.ts";

it("prints escaped triage scores and retains each pass's telemetry from the selected fake model", async () => {
	const source = loadTriageGoldens().find((golden) => golden.name === "docs-typo")!;
	const golden = { ...source, name: "docs-typo\u001b[31m" };
	const fake = createFakeModels({ provider: "output-eval", models: [{ id: "judge" }] });
	const requests = scriptConversations(fake, [
		{
			match: "You answer typed questions about a code change",
			replies: [1, 2].map(() => (messages) => {
				const prompt = messages.map(textOf).join("\n");
				const asked = [...prompt.matchAll(/^### (.+)$/gm)].map((match) => match[1]!);
				expect(asked).toEqual(Object.keys(golden.expected.levels));
				return fauxAssistantMessage(
					fauxToolCall("answer", {
						answers: asked.map((question) => ({
							question,
							probabilities: [{ option: golden.expected.levels[question], probability: 1 }],
						})),
					}),
					{ stopReason: "toolUse" },
				);
			}),
		},
	]);
	const printed: string[] = [];
	const errors: string[] = [];
	const results = await reportTriageGoldens(
		[golden],
		fake.review,
		"output-eval/judge",
		2,
		"test-fingerprint",
		(line) => printed.push(line),
		(line) => errors.push(line),
	);
	expect(errors).toEqual([]);
	expect(Object.values(requests).flat()).toHaveLength(2);
	expect(results.fingerprint).toBe("test-fingerprint");
	expect(results.passes).toBe(2);
	expect(results.exact()).toBe(1);
	const records = results.toJSON().telemetry![golden.name]!;
	expect(records).toHaveLength(2);
	for (const record of records) expect(record.total!.models["output-eval/judge"]!.totalTokens).toBeGreaterThan(0);
	expect(printed).toEqual([
		expect.stringMatching(
			/^triage triage v\d+ on output-eval\/judge, 2 passes: exact 1\.00, mean distance 0\.00, 0 under\ndocs-typo\\u001b\[31m: exact 1\.00, \d+ tokens, \$0$/,
		),
	]);
});

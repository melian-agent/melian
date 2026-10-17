import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	textOf,
} from "@melian-agent/pipeline/testing";
import { expect, it, vi } from "vitest";
import { reportTriageGoldens } from "../src/live-output.ts";
import { loadTriageGoldens, type StoredTriageResults, TriageResults } from "../src/triage.ts";

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

it("saves both passes before a three-pass triage failure propagates", async () => {
	const golden = loadTriageGoldens().find((golden) => golden.name === "docs-typo")!;
	const fake = createFakeModels({ provider: "failed-eval", models: [{ id: "judge" }] });
	const requests = scriptConversations(fake, [
		{
			match: "You answer typed questions about a code change",
			replies: [false, true].map((failed) => (messages) => {
				const asked = [
					...messages
						.map(textOf)
						.join("\n")
						.matchAll(/^### (.+)$/gm),
				].map((match) => match[1]!);
				expect(asked).toEqual(Object.keys(golden.expected.levels));
				return failed
					? fauxAssistantMessage("no decision", { stopReason: "error", errorMessage: "provider failed" })
					: fauxAssistantMessage(
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
	const complete = fake.models.complete.bind(fake.models);
	let calls = 0;
	vi.spyOn(fake.models, "complete").mockImplementation(async (...args) => {
		const response = await complete(...args);
		const tokens = ++calls === 1 ? 100 : 10;
		return {
			...response,
			usage: {
				input: tokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: tokens,
				cost: { input: tokens / 100, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens / 100 },
			},
		};
	});
	const printed: string[] = [];
	const errors: string[] = [];
	const directory = mkdtempSync(join(realpathSync(tmpdir()), "melian-triage-output-"));
	const out = join(directory, "results.json");
	try {
		await expect(
			reportTriageGoldens(
				[golden],
				fake.review,
				"failed-eval/judge",
				3,
				"questions",
				(line) => printed.push(line),
				(line) => errors.push(line),
				out,
			),
		).rejects.toThrow("triage measurement failed");
		expect(printed).toEqual([]);
		expect(Object.values(requests).flat()).toHaveLength(2);
		expect(errors).toEqual([
			expect.stringMatching(new RegExp(`^${golden.name}: pass 1, \\d+ tokens, \\$1$`)),
			expect.stringMatching(new RegExp(`^${golden.name}: pass 2, \\d+ tokens, \\$0\\.1$`)),
			expect.stringContaining(`${golden.name}: no score (`),
		]);
		const saved = JSON.parse(readFileSync(out, "utf8")) as StoredTriageResults;
		const passes = saved.telemetry![golden.name]!;
		expect(passes).toHaveLength(2);
		expect(
			passes.map((pass) => pass.stages.find((stage) => stage.name === "melian.triage")!.usage!.total.totalTokens),
		).toEqual([100, 10]);
		expect(passes.map((pass) => pass.total!.total.cost.total)).toEqual([1, 0.1]);
		expect(saved.choices).toEqual([]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	}
}, 60_000);

it.each([undefined, ""])("keeps triage output optional for path %j", async (out) => {
	const fake = createFakeModels({ models: [{ id: "unused" }] });
	const printed: string[] = [];
	const results = await reportTriageGoldens(
		[],
		fake.review,
		"fake/unused",
		1,
		"questions",
		(line) => printed.push(line),
		() => {
			throw new Error("unexpected error output");
		},
		out,
	);
	expect(results.toJSON().telemetry).toEqual({});
	expect(printed).toHaveLength(1);
});

it("refuses a saved baseline when golden B fails on its second pass after golden A completes", async () => {
	const [first, second] = loadTriageGoldens();
	const goldens = [first!, second!];
	const fake = createFakeModels({ provider: "baseline-eval", models: [{ id: "judge" }] });
	const requests = scriptConversations(fake, [
		{
			match: "You answer typed questions about a code change",
			replies: [first!, first!, second!, second!, first!, first!, second!, second!].map(
				(golden, index) => (messages) => {
					const asked = [
						...messages
							.map(textOf)
							.join("\n")
							.matchAll(/^### (.+)$/gm),
					].map((match) => match[1]!);
					expect(asked).toEqual(Object.keys(golden.expected.levels));
					if (index === 3)
						return fauxAssistantMessage("", { stopReason: "error", errorMessage: "B pass two failed" });
					return fauxAssistantMessage(
						fauxToolCall("answer", {
							answers: asked.map((question) => ({
								question,
								probabilities: [
									{ option: index >= 6 ? "quick" : golden.expected.levels[question], probability: 1 },
								],
							})),
						}),
						{ stopReason: "toolUse" },
					);
				},
			),
		},
	]);
	const directory = mkdtempSync(join(realpathSync(tmpdir()), "melian-incomplete-baseline-"));
	const out = join(directory, "results.json");
	try {
		await expect(
			reportTriageGoldens(
				goldens,
				fake.review,
				"baseline-eval/judge",
				2,
				"questions",
				() => {},
				() => {},
				out,
			),
		).rejects.toThrow("triage measurement failed");
		const text = readFileSync(out, "utf8");
		const baseline = TriageResults.parse(text);
		expect(baseline.goldens).toEqual(goldens.map((golden) => golden.name));
		expect(new Set(baseline.choices.map((choice) => choice.golden))).toEqual(new Set([first!.name]));
		expect(baseline.toJSON().telemetry![second!.name]).toHaveLength(2);
		const complete = await reportTriageGoldens(
			goldens,
			fake.review,
			"baseline-eval/judge",
			2,
			"questions",
			() => {},
			() => {},
		);
		expect(Object.values(requests).flat()).toHaveLength(8);
		expect(complete.meanDistance()).toBeGreaterThan(baseline.meanDistance());
		expect(complete.compare(baseline)).toEqual({
			verdict: "incomparable",
			lines: ["incomparable: the baseline measurement is incomplete"],
		});
		expect(JSON.parse(text)).toMatchObject({ version: 2, complete: false });
		expect(complete.toJSON()).toMatchObject({ version: 2, complete: true });
		expect(complete.compare(TriageResults.parse(JSON.stringify(complete.toJSON()))).verdict).toBe("same");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 60_000);

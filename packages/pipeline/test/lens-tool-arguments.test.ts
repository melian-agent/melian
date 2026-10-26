import { createMemoryStorage, createReviewRegistry, openHarness } from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	textOf,
} from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";
import { backgroundContext as context, type JsonObject } from "../src/harness.ts";
import { LensDocument, lensListedTools } from "../src/lens-tools.ts";
import { lensExtension } from "../src/review.ts";

const refusal = "<harness>\n[error] Tool arguments are too large: keep them under 8 KiB.\n</harness>";
const withinLimits = (name: keyof typeof lensListedTools, reply: string) => {
	expect(Buffer.byteLength(reply)).toBeLessThanOrEqual(lensListedTools[name].outputLimits!.maxBytes!);
	expect(reply.split("\n").length).toBeLessThanOrEqual(lensListedTools[name].outputLimits!.maxLines!);
};
const cases = [
	["read_file", "path"],
	["list_files", "path"],
	["search", "paths"],
	["graph_definitions", "name"],
	["graph_references", "symbol"],
	["graph_impact", "symbol"],
	["graph_callees", "symbol"],
] as const;

async function replies(name: keyof typeof lensListedTools, argumentsList: JsonObject[]) {
	const fake = createFakeModels();
	const requests = scriptConversations(fake, [
		{
			match: "Schema boundary",
			replies: [
				fauxAssistantMessage(
					argumentsList.map((args) => fauxToolCall(name, args)),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Done."),
			],
		},
	]);
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	try {
		const root = await harness.root(context, {
			agent: {
				model: fake.ref(),
				instructions: "Schema boundary",
				tools: Object.values(lensListedTools),
				extensions: [lensExtension],
			},
		});
		await root.commit(async (tx) => {
			(await tx.doc(LensDocument, root.id)).lens = {
				name: "probe",
				version: "1",
				review: root.id,
				revision: {
					repoRoot: "/unused",
					nonce: "0123456789abcdef01234567",
					base: "a".repeat(40),
					head: "b".repeat(40),
					files: [],
				},
				tools: Object.keys(lensListedTools) as (keyof typeof lensListedTools)[],
				severities: ["P1", "P2", "P3"],
				rules: [],
				budget: 8,
				coverage: { scope: "", paths: ["**"], nearer: [] },
			};
		}, context);
		await (await root.submit({ type: "input", content: "Run." }, context)).wait(context);
		return requests["Schema boundary"]!.at(-1)!
			.filter((message) => message.role === "toolResult")
			.map(textOf);
	} finally {
		await harness.close(context);
	}
}

it.each(cases)("bounds oversized and excess-item arguments to %s before Pi validates them", async (name, field) => {
	const common: JsonObject = name === "search" ? { pattern: "needle" } : {};
	const large = field === "paths" ? ["x".repeat(70_000), ...Array(65).fill("f.ts")] : ["x".repeat(70_000)];
	const received = await replies(name, [
		{ ...common, [field]: field === "paths" ? ["x".repeat(70_000)] : "x".repeat(70_000) },
		{ ...common, [field]: large },
		{ ...common, [field]: Array(3_000).fill("f.ts") },
	]);
	expect(received).toEqual([refusal, refusal, refusal]);
	for (const reply of received) {
		expect(Buffer.byteLength(reply)).toBeLessThanOrEqual(lensListedTools[name].outputLimits!.maxBytes!);
		expect(reply.split("\n").length).toBeLessThanOrEqual(lensListedTools[name].outputLimits!.maxLines!);
	}
});

it("accepts exactly 8192 argument bytes and refuses one byte more", async () => {
	const at = { name: "x".repeat(8192 - Buffer.byteLength(JSON.stringify({ name: "" }))) };
	const over = { name: `${at.name}x` };
	expect(Buffer.byteLength(JSON.stringify(at))).toBe(8192);
	expect(Buffer.byteLength(JSON.stringify(over))).toBe(8193);
	const received = await replies("graph_definitions", [at, over]);
	expect(received[0]).toContain("this review has no Enola graph");
	expect(received[1]).toBe(refusal);
});

it("accepts 65 search paths and lets Pi refuse 66 within the byte bound, bounded", async () => {
	const received = await replies("search", [
		{ pattern: "needle", paths: Array(65).fill("f.ts") },
		{ pattern: "needle", paths: Array(66).fill("f.ts") },
	]);
	expect(received[0]).not.toContain("Validation failed");
	expect(received[1]).toContain("Validation failed");
	expect(received[1]).not.toContain("Received arguments");
	expect(received[1]).not.toContain("f.ts");
	withinLimits("search", received[1]!);
});

it("keeps Pi's validation message for nested malformed arguments, without the echoed arguments", async () => {
	let nested: JsonObject | null = null;
	for (let i = 0; i < 500; i++) nested = { nested };
	const received = await replies("graph_definitions", [{ name: nested }]);
	expect(received).toHaveLength(1);
	expect(received[0]).toContain("Validation failed");
	expect(received[0]).not.toContain("Received arguments");
	withinLimits("graph_definitions", received[0]!);
});

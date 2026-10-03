import { rmSync } from "node:fs";
import {
	defaultConfig,
	type Finding,
	type Lens,
	loadLenses,
	type MelianConfig,
	ModelRoutingError,
	resolveRange,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	createReviewRegistry,
	type Harness,
	type Message,
	openHarness,
	ReviewError,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
	textOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseAndHead, gitIn, isolatedGitEnv, lines, writeFiles } from "./fixtures/repo.ts";

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";

const user = (body: string) =>
	lines(
		"export interface User {",
		"\tname: string;",
		"\tmanager?: User;",
		"}",
		"",
		"export function managerName(user: User): string {",
		body,
		"}",
	);

let repo: string;
let fake: FakeModels;
let harness: Harness;
let lenses: Lens[];
let config: MelianConfig;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead(
		{
			"src/user.ts": user('\treturn user.manager?.name ?? "none";'),
			"src/report.ts": lines('import { managerName } from "./user.ts";', "export const line = managerName(me);"),
		},
		{ "src/user.ts": user("\treturn user.manager.name;") },
	);
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	config = { ...defaultConfig, models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } } };
	harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	lenses = await loadLenses(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"]);
});

afterEach(async () => {
	await harness.close(context);
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

async function review(options: { lenses?: Lens[]; config?: MelianConfig } = {}): Promise<readonly Finding[]> {
	return reviewChangeset({
		harness,
		changeset: await resolveRange(repo, "main...feature"),
		config: options.config ?? config,
		lenses: options.lenses ?? lenses,
		standards: [{ path: "AGENTS.md", content: "Never use the non-null assertion operator." }],
		models: fake.models,
	});
}

type Arguments = Parameters<typeof fauxToolCall>[1];

function call(name: string, args: Arguments) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function calls(...each: [string, Arguments][]) {
	return fauxAssistantMessage(
		each.map(([name, args]) => fauxToolCall(name, args)),
		{ stopReason: "toolUse" },
	);
}

const nullDeref = {
	file: "src/user.ts",
	line: 7,
	rule: "null-dereference",
	severity: "P1",
	explanation: {
		what: "managerName reads name from a manager that may be undefined.",
		why: "This change dropped the optional chain, so a user without a manager throws.",
		fix: "Restore user.manager?.name with a fallback.",
	},
};

function toolResults(messages: readonly Message[]): string[] {
	return messages.filter((message) => message.role === "toolResult").map(textOf);
}

function offered(messages: readonly Message[]): string[] {
	return messages.flatMap((message) =>
		message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
	);
}

describe("reviewChangeset", () => {
	it("runs each lens as its own conversation and returns the findings on the root", async () => {
		writeFiles(repo, { "src/user.ts": "uncommitted edits the lens must not see\n" });
		const requests = scriptConversations(fake, [
			{
				match: correctness,
				replies: [
					call("read_file", { path: "src/user.ts", startLine: 6 }),
					call("report_finding", nullDeref),
					fauxAssistantMessage("Reported 1 finding."),
				],
			},
			{ match: contracts, replies: [fauxAssistantMessage("Reported 0 findings.")] },
		]);

		const findings = await review();

		expect(findings).toHaveLength(1);
		const [finding] = findings;
		const [correctnessLens] = lenses.filter((lens) => lens.name === "correctness");
		expect(finding).toMatchObject({
			ruleId: "null-dereference",
			level: "error",
			message: { text: nullDeref.explanation.what },
			locations: [
				{
					physicalLocation: {
						artifactLocation: { uri: "src/user.ts" },
						region: { startLine: 7, snippet: { text: "\treturn user.manager.name;" } },
					},
				},
			],
			properties: {
				cause: "introduced",
				trigger: { file: "src/user.ts", index: 0, snippet: "\treturn user.manager.name;" },
				severity: "P1",
				resolution: "block",
				status: "new",
				source: { check: "lens.correctness", version: correctnessLens!.version },
				explanation: { whatToDo: nullDeref.explanation.fix },
			},
		});

		const [first, second] = requests[correctness]!;
		expect(offered(first!)).toEqual(["read_file", "search", "list_files", "report_finding"]);
		expect(systemPromptOf(first!)).toContain("Never use the non-null assertion operator.");
		expect(systemPromptOf(first!)).not.toContain(contracts);
		expect(textOf(first!.find((message) => message.role === "user")!)).toContain("--- src/user.ts (modified)");
		expect(toolResults(second!)[0]).toBe(
			"6\texport function managerName(user: User): string {\n7\t\treturn user.manager.name;\n8\t}",
		);
		expect(requests[contracts]).toHaveLength(1);
		// Three correctness requests and one contracts request; the orchestrating conversation's model is never asked.
		expect(fake.provider.state.callCount).toBe(4);
	});

	it("searches and lists the head revision, and offers only the tools a lens lists", async () => {
		const narrow = lenses.map((lens) =>
			lens.name === "contracts" ? { ...lens, tools: ["read_file" as const] } : lens,
		);
		const requests = scriptConversations(fake, [
			{
				match: correctness,
				replies: [
					calls(["search", { pattern: "managerName" }], ["list_files", { path: "src" }]),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: contracts, replies: [call("search", { pattern: "managerName" }), fauxAssistantMessage("Done.")] },
		]);

		await review({ lenses: narrow });

		const [searched, listed] = toolResults(requests[correctness]![1]!);
		expect(searched).toBe(
			'src/report.ts:1: import { managerName } from "./user.ts";\nsrc/report.ts:2: export const line = managerName(me);\nsrc/user.ts:6: export function managerName(user: User): string {',
		);
		expect(listed).toMatch(/^src\/report\.ts \(\d+ bytes\)\nsrc\/user\.ts \(\d+ bytes\)$/);
		expect(offered(requests[contracts]![0]!)).toEqual(["read_file", "report_finding"]);
		expect(toolResults(requests[contracts]![1]!)[0]).not.toContain("src/report.ts:1");
	});

	it("holds a lens to its severities and rules, and stores a repeated finding once", async () => {
		const requests = scriptConversations(fake, [
			{
				match: correctness,
				replies: [
					call("report_finding", { ...nullDeref, severity: "P3" }),
					call("report_finding", { ...nullDeref, rule: "made-up" }),
					call("report_finding", nullDeref),
					call("report_finding", { ...nullDeref, explanation: { ...nullDeref.explanation, what: "Reworded." } }),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
		]);

		const findings = await review();

		const results = requests[correctness]!.slice(1).map((messages) => toolResults(messages).at(-1));
		expect(results[0]).toContain("Tool call blocked: severity P3 is outside this lens's severities: P0, P1, P2");
		expect(results[1]).toContain(
			"Tool call blocked: rule made-up is not one of this lens's rules: null-dereference (",
		);
		expect(results[2]).toMatch(/^recorded finding [0-9a-f]{16}$/);
		expect(results[3]).toBe(results[2]);
		expect(findings).toHaveLength(1);
		expect(findings[0]!.message.text).toBe("Reworded.");
	});

	it("stops accepting findings past the lens's budget and says why", async () => {
		const tight = lenses.map((lens) => (lens.name === "correctness" ? { ...lens, budget: { findings: 1 } } : lens));
		const requests = scriptConversations(fake, [
			{
				match: correctness,
				replies: [
					call("report_finding", nullDeref),
					call("report_finding", { ...nullDeref, line: 6, endLine: 7 }),
					calls(["report_finding", { ...nullDeref, line: 3 }], ["report_finding", { ...nullDeref, line: 2 }]),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
		]);

		const findings = await review({ lenses: tight });

		expect(toolResults(requests[correctness]![2]!).at(-1)).toContain("budget reached");
		expect(toolResults(requests[correctness]![3]!).slice(-2).join("\n")).toContain("budget reached");
		expect(findings).toHaveLength(1);
	});

	it("holds a parallel round to the budget inside the commit", async () => {
		const tight = lenses.map((lens) => (lens.name === "correctness" ? { ...lens, budget: { findings: 1 } } : lens));
		const requests = scriptConversations(fake, [
			{
				match: correctness,
				replies: [
					calls(["report_finding", nullDeref], ["report_finding", { ...nullDeref, line: 6, endLine: 7 }]),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
		]);

		const findings = await review({ lenses: tight });

		const results = toolResults(requests[correctness]![1]!);
		expect(results.filter((result) => result.startsWith("recorded finding"))).toHaveLength(1);
		expect(results.join("\n")).toContain("budget reached");
		expect(findings).toHaveLength(1);
	});

	it("counts the budget and returns findings at the head under review only", async () => {
		const tight = lenses.map((lens) => (lens.name === "correctness" ? { ...lens, budget: { findings: 1 } } : lens));
		scriptConversations(fake, [
			{ match: correctness, replies: [call("report_finding", nullDeref), fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
		]);
		expect(await review({ lenses: tight })).toHaveLength(1);

		writeFiles(repo, {
			"src/report.ts": lines('import { managerName } from "./user.ts";', "export const line = 1;"),
		});
		gitIn(repo, "commit", "--quiet", "--all", "-m", "second push");
		const nextPush = { ...nullDeref, file: "src/report.ts", line: 2, rule: "wrong-result" };
		const requests = scriptConversations(fake, [
			{ match: correctness, replies: [call("report_finding", nextPush), fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
		]);
		const findings = await review({ lenses: tight });

		expect(toolResults(requests[correctness]![1]!)[0]).toMatch(/^recorded finding/);
		expect(findings.map((finding) => finding.ruleId)).toEqual(["wrong-result"]);
	});

	it("classifies cause by location, with evidence the only route to affected", async () => {
		scriptConversations(fake, [
			{ match: correctness, replies: [fauxAssistantMessage("Done.")] },
			{
				match: contracts,
				replies: [
					calls(
						["report_finding", { ...nullDeref, rule: "changed-return", severity: "P2", line: 2 }],
						[
							"report_finding",
							{
								...nullDeref,
								file: "src/report.ts",
								line: 2,
								rule: "broken-caller",
								evidence: "src/user.ts:7 now throws for a user without a manager",
							},
						],
					),
					fauxAssistantMessage("Done."),
				],
			},
		]);

		const findings = await review();

		const byFile = Object.fromEntries(
			findings.map((each) => [each.locations[0]!.physicalLocation.artifactLocation.uri, each]),
		);
		expect(byFile["src/user.ts"]!.properties.cause).toBe("pre-existing");
		expect(byFile["src/user.ts"]!.properties.resolution).toBe("acknowledge");
		expect(byFile["src/report.ts"]!.properties).toMatchObject({
			cause: "affected",
			evidence: "src/user.ts:7 now throws for a user without a manager",
		});
		expect(byFile["src/user.ts"]!.properties.evidence).toBeUndefined();
	});

	it("runs no lens that configuration switches off", async () => {
		const off = { ...config, lenses: { correctness: { enabled: false }, contracts: { enabled: false } } };
		expect(await review({ config: off })).toEqual([]);
		expect(fake.provider.state.callCount).toBe(0);
	});

	it("names the lens when it did not finish, and keeps what it reported", async () => {
		scriptConversations(fake, [
			{ match: correctness, replies: [call("report_finding", nullDeref)] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
		]);
		const error = await review().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ReviewError);
		expect(error).toMatchObject({ code: "lensFailed", lenses: ["correctness"] });
		expect((error as ReviewError).findings).toHaveLength(1);
	});

	it("refuses a tier with no model, or none with credentials", async () => {
		await expect(review({ config: { ...config, models: {} } })).rejects.toThrow(ModelRoutingError);
		const unknown = { ...config, models: { heavy: { model: "nowhere/opus", fallbacks: ["faux/missing"] } } };
		await expect(review({ config: unknown })).rejects.toMatchObject({ code: "noAvailableModel" });
	});

	it("falls back to the next model when the first is unavailable", async () => {
		const heavy = fake.ref("heavy");
		const fallback = {
			...config,
			models: { heavy: { model: "nowhere/opus", fallbacks: [`${heavy.provider}/heavy`] } },
		};
		scriptConversations(fake, [
			{ match: correctness, replies: [fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
		]);
		expect(await review({ config: fallback })).toEqual([]);
	});

	it("refuses a harness without the lens extension", async () => {
		await harness.close(context);
		harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
		await expect(review()).rejects.toMatchObject({ code: "notInstalled" });
	});
});

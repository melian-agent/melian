import { Changeset, defaultConfig, Lens } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	openHarness,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	textOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionApi } from "../src/harness.ts";
import { LensDocument, lensListedTools, reviewFiles } from "../src/lens-tools.ts";
import { maxListedMutants } from "../src/mutant-listing.ts";
import { MutationEnumeration } from "../src/mutation-enumeration.ts";
import { commit, createRepository, removeRepository } from "./fixtures/repo.ts";

const nonce = "0123456789abcdef01234567";
const tool = lensListedTools.list_mutants;
let repo: string;
let base: string;

beforeEach(() => {
	repo = createRepository();
	base = commit(repo, {
		"stryker.config.json": JSON.stringify({ mutator: { excludedMutations: ["StringLiteral"] } }),
		"src/value.ts": "export const value = (n: number) => n > 0;\n",
		"src/untouched.ts": "export const untouched = true;\n",
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	removeRepository(repo);
});

async function call(head: string, args: { path: string; startLine?: number; endLine?: number }) {
	const files = reviewFiles((await Changeset.resolve(repo, `${base}..${head}`)).revision.files);
	const api = {
		conversationId: 1,
		taskId: 1,
		snapshot: async (document: unknown) => {
			expect(document).toBe(LensDocument);
			return {
				lens: {
					name: "tests",
					version: "1",
					review: 1,
					tools: ["list_mutants"],
					severities: ["P2"],
					rules: [],
					budget: 8,
					coverage: { scope: "", paths: ["**"], nearer: [] },
					revision: { repoRoot: repo, nonce, base, head, files },
				},
			};
		},
	} as unknown as ToolExecutionApi;
	const result = (await tool.execute(args, api, context)) as {
		content?: { text: string }[];
		details?: { mutants: unknown[]; excluded: number; more?: unknown };
		diagnostics?: { message: string }[];
		isError?: boolean;
	};
	return {
		text: [...(result.content ?? []), ...(result.diagnostics ?? []).map(({ message }) => ({ text: message }))]
			.map(({ text }) => text)
			.join("\n"),
		details: result.details,
		isError: result.isError,
	};
}

// What `melian mutants list <base>..<head>` lists for one file, as the CLI asks the enumerator for a range.
async function cliRows(head: string, file: string) {
	const inventory = (
		await (
			await MutationEnumeration.open(repo, `${base}..${head}`)
		).list({
			all: true,
			limitedTo: [file],
		})
	).toJSON();
	return inventory.mutants.filter((row) => row.file === file);
}

const flags = (count: number) =>
	Array.from({ length: count }, (_, index) => `export const flag${index} = true;\n`).join("");

describe("list_mutants", { timeout: 60_000 }, () => {
	it("returns the rows melian mutants list gives for the file, less those the base's configuration excludes", async () => {
		const head = commit(repo, {
			// The head's configuration would switch the BooleanLiteral mutants off; the base's policy decides.
			"stryker.config.json": JSON.stringify({
				mutator: { excludedMutations: ["BooleanLiteral", "EqualityOperator"] },
			}),
			"src/value.ts": [
				"export const value = (n: number) => n >= 0;",
				"export const text = 'hello';",
				"// Stryker disable next-line BooleanLiteral: the change's own comment",
				"export const flag = true;",
				"",
			].join("\n"),
		});
		const rows = await cliRows(head, "src/value.ts");
		const shown = rows.filter((row) => row.ignoredBy !== "config");
		expect(rows.filter((row) => row.ignoredBy === "config").map((row) => row.mutatorName)).toEqual(["StringLiteral"]);
		expect(shown.some((row) => row.ignoredBy === "comment" && row.line === 4)).toBe(true);
		const result = await call(head, { path: "src/value.ts" });
		expect(result.details).toEqual({ mutants: shown, excluded: 1 });
		expect(result.text).toContain("[ignored by a comment in the head]");
		expect(result.text).toContain("[1 more the base's mutation configuration excludes are left out]");
		expect(result.text).toContain(`<untrusted-${nonce} label="mutants">`);
	});

	it.each([
		[maxListedMutants, undefined],
		[maxListedMutants + 1, { count: 1, startLine: maxListedMutants + 1 }],
	])("lists %s mutants on as many lines with %o left for the next call", async (count, more) => {
		const head = commit(repo, { "src/flags.ts": flags(count) });
		const rows = await cliRows(head, "src/flags.ts");
		expect(rows).toHaveLength(count);
		const first = await call(head, { path: "src/flags.ts" });
		expect(first.details).toEqual({
			mutants: rows.slice(0, maxListedMutants),
			excluded: 0,
			...(more === undefined ? {} : { more }),
		});
		if (more === undefined) {
			expect(first.text).not.toContain("call again");
			return;
		}
		expect(first.text).toContain(`[1 more mutants not shown; call again with startLine ${maxListedMutants + 1}]`);
		expect((await call(head, { path: "src/flags.ts", startLine: more.startLine })).details).toEqual({
			mutants: rows.slice(maxListedMutants),
			excluded: 0,
		});
	});

	it("cuts inside a line that holds more than the cap, and asks for the rest from the next line", async () => {
		const head = commit(repo, {
			"src/flags.ts": `export const all = [${Array(maxListedMutants + 2)
				.fill("true")
				.join(", ")}];\nexport const last = true;\n`,
		});
		const rows = await cliRows(head, "src/flags.ts");
		expect(rows.filter((row) => row.line === 1).length).toBeGreaterThan(maxListedMutants);
		const result = await call(head, { path: "src/flags.ts" });
		expect(result.details).toEqual({
			mutants: rows.slice(0, maxListedMutants),
			excluded: 0,
			more: { count: rows.length - maxListedMutants, startLine: 2, cutLine: 1 },
		});
		expect(result.text).toContain(
			`[line 1 holds more than ${maxListedMutants} mutants; the rest of it are not shown]`,
		);
	});

	it("says which lines changed when the range asked for holds none", async () => {
		const head = commit(repo, {
			"src/value.ts": "export const value = (n: number) => n > 0;\n\nexport const b = true;\n",
		});
		expect(await call(head, { path: "src/value.ts", startLine: 1, endLine: 2 })).toEqual({
			text: "No mutants on lines 1 to 2 of src/value.ts. The change adds or alters these lines of it: 2-3.",
			details: { mutants: [], excluded: 0 },
			isError: undefined,
		});
	});

	it.each([
		["src/untouched.ts", "the change adds or alters no line of it"],
		["src/value.test.ts", "the list covers only production JavaScript and TypeScript"],
		["src/a,b.ts", "Stryker's list of files to mutate is comma-separated"],
	])("lists no mutants in %s, and says why", async (path, why) => {
		const head = commit(repo, {
			"src/value.test.ts": "throw new Error('tests must not run');\n",
			"src/a,b.ts": "export const comma = true;\n",
		});
		const result = await call(head, { path });
		expect(result.text).toContain(`No mutants in ${path}: ${why}`);
		expect(result.details).toEqual({ mutants: [], excluded: 0 });
	});

	it("refuses an end line before the start line", async () => {
		const head = commit(repo, { "src/flags.ts": flags(2) });
		const result = await call(head, { path: "src/flags.ts", startLine: 2, endLine: 1 });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("endLine 1 is before startLine 2");
	});

	it("enumerates each file of a review once, however many calls page through it", async () => {
		const head = commit(repo, { "src/flags.ts": flags(maxListedMutants + 1) });
		const list = vi.spyOn(MutationEnumeration.prototype, "list");
		await call(head, { path: "src/flags.ts" });
		await call(head, { path: "src/flags.ts", startLine: maxListedMutants + 1 });
		await call(head, { path: "src/flags.ts", startLine: 1, endLine: 3 });
		expect(list.mock.calls).toEqual([[{ all: true, limitedTo: ["src/flags.ts"] }]]);
	});

	it("puts its cap in the description that keys a lens request", () => {
		expect(tool.description).toContain(`At most ${maxListedMutants} a call`);
		expect(tool.outputLimits).toEqual(lensListedTools.read_file.outputLimits);
	});
});

describe("the tests lens with list_mutants", { timeout: 60_000 }, () => {
	it("lists a change's mutants and reports one no test would catch as untested behaviour", async () => {
		const head = commit(repo, {
			"src/value.ts": "export const value = (n: number) => n >= 0;\n",
			"src/value.test.ts": "import { value } from './value.ts';\nvalue(5);\n",
		});
		const models = createFakeModels({ models: [{ id: "heavy" }] });
		const model = models.ref("heavy");
		const harness = await openHarness(createMemoryStorage(), {
			models: models.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		try {
			await harness.root(context, { agent: { model } });
			const lenses = (await Lens.load(repo, { kind: "revision", commit: base }, ["src/value.ts"])).filter(
				(lens) => lens.name === "tests",
			);
			expect(lenses[0]?.tools).toContain("list_mutants");
			const requests = scriptConversations(models, [
				{
					match: "You are the tests reviewer",
					replies: [
						fauxAssistantMessage(fauxToolCall("list_mutants", { path: "src/value.ts" }), {
							stopReason: "toolUse",
						}),
						fauxAssistantMessage(
							fauxToolCall("report_finding", {
								file: "src/value.ts",
								line: 1,
								rule: "untested-behaviour",
								severity: "P2",
								explanation: {
									what: "No test checks value at zero.",
									why: "The change moved the bound from > to >=.",
									fix: "Assert value(0) and value(-1) in src/value.test.ts.",
								},
								failureScenario:
									"No test in src/value.test.ts would fail with the EqualityOperator mutant on line 1 applied; none calls value(0).",
								evidence: [
									{ file: "src/value.ts", line: 1, role: "cause" },
									{ file: "src/value.test.ts", line: 2, role: "context" },
								],
							}),
							{ stopReason: "toolUse" },
						),
						fauxAssistantMessage("1 finding."),
					],
				},
			]);
			const reviewed = await reviewChangeset({
				harness,
				changeset: await Changeset.resolve(repo, `${base}..${head}`),
				config: {
					...defaultConfig,
					tiers: { full: ["lens.tests"] },
					models: { heavy: { model: `${model.provider}/${model.modelId}` } },
				},
				lenses,
				standards: [],
				models: models.review,
				checks: [],
			});
			const conversation = requests["You are the tests reviewer"]!;
			const listed = conversation[1]!.filter((message) => message.role === "toolResult").map(textOf);
			expect(listed.join("\n")).toMatch(/^1:\d+-1:\d+ EqualityOperator -> /m);
			expect(reviewed.findings.map((finding) => finding.ruleId)).toEqual(["untested-behaviour"]);
		} finally {
			await harness.close(context);
		}
	});
});

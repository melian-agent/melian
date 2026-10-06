import { join } from "node:path";
import { ReviewPlan } from "@melian-agent/core";
import { CallerContext, planInputs } from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	scriptConversations,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { commit, createRepository, gitIn, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import * as modelSetup from "../src/models.ts";

let repo: string;
afterEach(() => {
	vi.restoreAllMocks();
	if (repo) removeRepository(repo);
});

it("supplies CLI caller context to the model and retains its coverage in the stored verdict", async () => {
	repo = createRepository();
	commit(repo, {
		"src/a.ts": "export const a = 1;\n",
		"melian.yaml":
			"tiers:\n  fast: [lens.correctness]\n  full: [fast]\nstatic:\n  enola: {enabled: true}\n" +
			"lenses:\n" +
			["contracts", "trust-boundary", "removed-behaviour", "tests", "conventions"]
				.map((name) => `  ${name}: {enabled: false}\n`)
				.join(""),
	});
	gitIn(repo, "checkout", "-b", "feature");
	commit(repo, { "src/a.ts": "export const a = 2;\n" });
	const fake = createFakeModels();
	const ref = fake.ref();
	const requests = scriptConversations(fake, [
		{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
	]);
	vi.spyOn(modelSetup, "reviewModels").mockImplementation(async (_env, loaded, lenses, options) => ({
		models: fake.review,
		plan: ReviewPlan.resolve({
			config: loaded.config,
			routes: loaded.routes,
			model: `${ref.provider}/${ref.modelId}`,
			...(await planInputs(fake.review)),
			lenses,
			checks: options.checks,
		}),
		retry: false,
	}));
	const callers = CallerContext.from({
		groups: [
			{
				file: "src/a.ts",
				symbol: "a",
				callers: [{ name: "OutsideCaller", kind: "symbol", file: "src/caller.ts", line: 2 }],
				truncated: false,
			},
		],
		issues: [],
		notes: [],
		paths: [],
	});
	vi.spyOn(CallerContext, "open").mockResolvedValue(callers);
	vi.spyOn(callers, "recordCoverage").mockResolvedValue({ review: "a".repeat(64) });
	const lines: string[] = [],
		errors: string[] = [];
	const io: Io = {
		cwd: repo,
		env: {
			MELIAN_TEST_SCRIPT: "injected",
			MELIAN_STATE_DIR: join(repo, "state"),
			XDG_CONFIG_HOME: join(repo, "config"),
			PI_CODING_AGENT_DIR: join(repo, "pi"),
		},
		stdout: (text) => lines.push(text),
		stderr: (text) => errors.push(text),
		color: false,
	};
	expect(await main(["review", "main...feature"], io), errors.join("")).toBe(0);
	expect(CallerContext.open).toHaveBeenCalledWith(
		expect.objectContaining({ commit: gitIn(repo, "rev-parse", "HEAD").trim() }),
		[expect.objectContaining({ path: "src/a.ts" })],
		expect.anything(),
		["src/a.ts"],
	);
	expect(systemPromptOf(requests["You are the correctness reviewer"]![0]!)).toContain("OutsideCaller");
	lines.length = 0;
	expect(await main(["findings", "main...feature", "--json"], io)).toBe(0);
	expect(JSON.parse(lines.join("")).ran).toContainEqual(
		expect.objectContaining({ name: "lens.correctness", coverage: { review: "a".repeat(64) } }),
	);
}, 60_000);

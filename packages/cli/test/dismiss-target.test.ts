import { join } from "node:path";
import { type Rendering, ReviewPlan, Verdict } from "@melian-agent/core";
import { planInputs } from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage, scriptConversations } from "@melian-agent/pipeline/testing";
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

it("names the reviewed range in each melian dismiss command the terminal prints", { timeout: 60_000 }, async () => {
	repo = createRepository();
	commit(repo, {
		"src/a.ts": "export const a = 1;\n",
		"melian.yaml":
			"tiers:\n  fast: [lens.correctness]\n  full: [fast]\n" +
			"lenses:\n" +
			["contracts", "trust-boundary", "removed-behaviour", "tests", "conventions"]
				.map((name) => `  ${name}: {enabled: false}\n`)
				.join(""),
	});
	gitIn(repo, "checkout", "-b", "feature");
	commit(repo, { "src/a.ts": "export const a = 2;\n" });
	const fake = createFakeModels();
	const ref = fake.ref();
	scriptConversations(fake, [{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] }]);
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
	const render = vi.spyOn(Verdict.prototype, "render");
	const errors: string[] = [];
	const io: Io = {
		cwd: repo,
		env: {
			MELIAN_TEST_SCRIPT: "injected",
			MELIAN_STATE_DIR: join(repo, "state"),
			XDG_CONFIG_HOME: join(repo, "config"),
			PI_CODING_AGENT_DIR: join(repo, "pi"),
		},
		stdout: () => {},
		stderr: (text) => errors.push(text),
		color: false,
	};
	expect(await main(["review", "main...feature"], io), errors.join("")).toBe(0);
	expect(await main(["findings", "main...feature"], io), errors.join("")).toBe(0);
	const targets = render.mock.calls.map(([rendering]) => (rendering as Rendering).target);
	expect(targets).toEqual(["main...feature", "main...feature"]);
});

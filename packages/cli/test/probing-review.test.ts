import { join } from "node:path";
import { ReviewPlan } from "@melian-agent/core";
import { planInputs, ReviewHarness } from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	unconfinedSandbox,
} from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commit, createRepository, gitIn, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import * as modelSetup from "../src/models.ts";

const planner = "Your role at this level: the attack planner";
const reviewer = "You are the trust-boundary reviewer";

let repo: string;
afterEach(() => {
	vi.restoreAllMocks();
	if (repo) removeRepository(repo);
});

describe("melian review of a level that probes", { timeout: 60_000 }, () => {
	it.each([
		[["--trust-head"], planner],
		[[], reviewer],
	])(
		"probes a range the reviewer vouches for, and reviews one it does not without probes: %j",
		async (flags, role) => {
			repo = createRepository();
			commit(repo, {
				"src/load.ts": "export const load = (path: string) => path;\n",
				"melian.yaml":
					"tiers:\n  full: [lens.trust-boundary]\nlenses:\n  trust-boundary:\n    level: { floor: deep }\n" +
					["correctness", "contracts", "removed-behaviour", "tests", "conventions"]
						.map((name) => `  ${name}: {enabled: false}\n`)
						.join(""),
				".melian/lenses/trust-boundary/LENS.md":
					"---\nname: trust-boundary\nextends: trust-boundary\nlevels:\n  deep: { probe: {} }\n---\n",
			});
			gitIn(repo, "checkout", "-b", "feature");
			commit(repo, { "src/load.ts": "export const load = (path: string) => path.trim();\n" });
			const fake = createFakeModels();
			const ref = fake.ref();
			const requests = scriptConversations(fake, [
				{
					match: planner,
					replies: [
						fauxAssistantMessage([fauxToolCall("record_plan", { attacks: [] })], { stopReason: "toolUse" }),
						fauxAssistantMessage("Planned 0 attacks."),
					],
				},
				{ match: reviewer, replies: [fauxAssistantMessage("Reported 0 findings.")] },
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
			// The repository's own probes would run under sandbox-runtime; this one probes nothing, so any sandbox that runs
			// the empty probe that says probes run here will do.
			const open = ReviewHarness.open.bind(ReviewHarness);
			vi.spyOn(ReviewHarness, "open").mockImplementation((storage, models, options = {}, context) =>
				open(storage, models, { ...options, probeSandbox: unconfinedSandbox() }, context),
			);
			const errors: string[] = [];
			const io: Io = {
				cwd: repo,
				env: {
					MELIAN_TEST_SCRIPT: "injected",
					MELIAN_STATE_DIR: join(repo, "state"),
					XDG_CONFIG_HOME: join(repo, "config"),
					PI_CODING_AGENT_DIR: join(repo, "pi"),
				},
				stdout: () => undefined,
				stderr: (text) => errors.push(text),
				color: false,
			};
			expect(await main(["review", "main...feature", "--no-walkthrough", ...flags], io), errors.join("")).toBe(0);
			expect(Object.keys(requests).filter((match) => (requests[match] ?? []).length > 0)).toEqual([role]);
		},
	);
});

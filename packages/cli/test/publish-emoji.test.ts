import { rmSync } from "node:fs";
import { Changeset } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { baseAndHead, isolatedGitEnv } from "../../pipeline/test/fixtures/repo.ts";
import { publish } from "../src/commands.ts";
import * as targets from "../src/target.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it.each([
	["", "publish:\n  emoji: off\n", 1],
	["publish:\n  emoji: on\n", "publish:\n  emoji: off\n", 1],
	["publish:\n  emoji: off\n", "publish:\n  emoji: on\n", 2],
])(
	"posts through a provider without emojis only when the base's melian.yaml says %j, whatever the head's says",
	async (policy, headPolicy, calls) => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		const repo = baseAndHead(
			{ "melian.yaml": `${policy}tiers: { full: [guardrails] }\n` },
			{ "melian.yaml": `${headPolicy}tiers: { full: [guardrails] }\n`, "src/a.ts": "new\n" },
		);
		try {
			const changeset = await Changeset.resolve(repo, "main...feature");
			const state = pullRequestState();
			moveTo(state, changeset);
			const provider = createGitHubProvider({
				owner: state.owner,
				repo: state.repo,
				token: "t",
				fetch: fakeGitHub(state),
			});
			const gitHubFor = vi.spyOn(targets, "gitHubFor").mockResolvedValue(provider);
			vi.spyOn(targets, "pullRequestChangeset").mockResolvedValue(changeset);
			vi.spyOn(targets, "currentBase").mockResolvedValue(changeset.revision.base);
			const io = {
				cwd: repo,
				env: { ...process.env, MELIAN_TEST_SCRIPT: undefined, MELIAN_STATE_DIR: `${repo}/.state` },
				stdout: () => {},
				stderr: () => {},
				color: false,
			};
			await publish(io, "#7").catch(() => undefined);
			expect(gitHubFor.mock.calls.map((call) => call[2])).toEqual(
				calls === 1 ? [undefined] : [undefined, { emoji: false }],
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	},
);

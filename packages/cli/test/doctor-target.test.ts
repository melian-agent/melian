import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pipeline from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { GitRecordStore } from "@melian-agent/state-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { fakeGitHub, fakeState } from "../../github/test/fixtures/fake-github.ts";
import type { Io } from "../src/commands.ts";
import { doctor } from "../src/doctor.ts";

const scratch: string[] = [];
let repo: string;
let home: string;
let fake: ReturnType<typeof createFakeModels>;
let committed: string;
let local: string;

function directory(prefix: string): string {
	const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	scratch.push(path);
	return path;
}

// The base commits a lens route; the working tree of the pull request's head routes the same lens elsewhere in
// melian.local.yaml, as the host finisher did. GitHub answers from the fake, and git fetches the pull request's refs from
// a bare repository through an ssh stand-in.
beforeEach(() => {
	vi.spyOn(pipeline.Probe, "availability").mockResolvedValue({ available: true });
	vi.spyOn(GitRecordStore.prototype, "strays").mockResolvedValue([]);
	fake = createFakeModels({ models: [{ id: "finder" }, { id: "claude" }] });
	vi.spyOn(pipeline, "createReviewModels").mockReturnValue(fake.review);
	const { provider } = fake.ref("finder");
	committed = `${provider}/finder`;
	local = `${provider}/claude`;
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = directory("melian-doctor-target-");
	home = directory("melian-doctor-target-home-");
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFileSync(join(repo, "melian.yaml"), `lenses:\n  correctness:\n    route: { model: ${committed} }\n`);
	gitIn(repo, "add", "melian.yaml");
	gitIn(repo, "commit", "--quiet", "-m", "base policy");
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	writeFileSync(join(repo, "change.ts"), "export const x = 1;\n");
	gitIn(repo, "add", "change.ts");
	gitIn(repo, "commit", "--quiet", "-m", "change");
	writeFileSync(join(repo, "melian.local.yaml"), `lenses:\n  correctness:\n    route: { model: ${local} }\n`);
	const bare = directory("melian-doctor-target-origin-");
	gitIn(bare, "init", "--quiet", "--bare");
	gitIn(repo, "push", "--quiet", bare, "main:refs/heads/main", "feature:refs/pull/7/head");
	gitIn(repo, "remote", "add", "origin", "git@github.com:test/repo.git");
	const ssh = join(home, "ssh");
	writeFileSync(ssh, `#!/bin/sh\nexec git upload-pack '${bare}'\n`);
	chmodSync(ssh, 0o755);
	vi.stubEnv("GIT_SSH_COMMAND", ssh);
	const state = fakeState(
		"test",
		"repo",
		{
			number: 7,
			title: "Review",
			base: { ref: "main", sha: gitIn(repo, "rev-parse", "main") },
			head: { ref: "feature", sha: gitIn(repo, "rev-parse", "feature") },
		},
		{},
	);
	vi.stubGlobal("fetch", fakeGitHub(state));
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function run(target?: string): Promise<string[]> {
	let stdout = "";
	const io: Io = {
		cwd: repo,
		env: { ...process.env, XDG_CONFIG_HOME: home, PI_CODING_AGENT_DIR: home, GITHUB_TOKEN: "test-token" },
		stdout: (text) => {
			stdout += text;
		},
		stderr: () => {},
		color: false,
	};
	await doctor(io, target === undefined ? {} : { target });
	return stdout.split("\n").filter((line) => / {2}plan\s+/.test(line));
}

describe("doctor's plan for a review target", { timeout: 60_000 }, () => {
	it("prints a pull request's plan from its base, and names the preference it ignores", async () => {
		const plan = await run("#7");

		expect(plan.some((line) => line.includes(`correctness route: ${committed}`))).toBe(true);
		expect(plan.some((line) => line.includes(local))).toBe(false);
		expect(plan.filter((line) => line.includes("is ignored"))).toEqual([
			expect.stringMatching(
				/^warn {2}plan +melian\.local\.yaml is ignored: that review reads no working-tree preference$/,
			),
		]);
		expect(plan).toContainEqual(
			expect.stringMatching(
				new RegExp(
					`^ok {4}plan +for pull request #7's review, which reads its policy and lenses from its base, ${gitIn(repo, "rev-parse", "main").slice(0, 12)}$`,
				),
			),
		);
		expect(fake.provider.state.callCount).toBe(0);
	});

	it("names the user's preference file too, by its path, when a pull request's review does not read it", async () => {
		mkdirSync(join(home, "melian"));
		const preferences = join(home, "melian", "config.yaml");
		writeFileSync(preferences, `lenses:\n  correctness:\n    route: { model: ${local} }\n`);
		rmSync(join(repo, "melian.local.yaml"));

		const plan = await run("#7");

		expect(plan.filter((line) => line.includes("is ignored"))).toEqual([
			expect.stringMatching(
				new RegExp(
					`^warn {2}plan +${preferences.replaceAll(".", "\\.")} is ignored: that review reads no working-tree preference$`,
				),
			),
		]);
		expect(plan.some((line) => line.includes(local))).toBe(false);
	});

	it("prints a range review's plan from the working tree when its head is checked out", async () => {
		const plan = await run("main...feature");

		expect(plan).toContainEqual(
			expect.stringMatching(
				/^ok {4}plan +for a review of main\.\.\.feature on the checked-out commit, which reads the working tree and your preferences$/,
			),
		);
		expect(plan.some((line) => line.includes(`correctness route: ${local}`))).toBe(true);
		expect(plan.some((line) => line.includes("is ignored"))).toBe(false);
	});

	it("prints a range review's plan from its base when its head is not checked out", async () => {
		gitIn(repo, "checkout", "--quiet", "main");

		const plan = await run("main...feature");

		expect(plan.some((line) => line.includes(`correctness route: ${committed}`))).toBe(true);
		expect(plan.filter((line) => line.includes("is ignored"))).toEqual([
			expect.stringMatching(
				/^warn {2}plan +melian\.local\.yaml is ignored: that review reads no working-tree preference$/,
			),
		]);
	});

	it("fails the plan line when the target cannot be resolved", async () => {
		const plan = await run("no-such-ref...feature");

		expect(plan).toEqual([expect.stringMatching(/^fail {2}plan +/)]);
	});

	it("says with no target that the plan is a range review's on the checked-out commit, preferences included", async () => {
		const plan = await run();

		expect(plan.some((line) => line.includes(`correctness route: ${local}`))).toBe(true);
		expect(plan).toContainEqual(
			expect.stringMatching(
				/^ok {4}plan +for a review of a range on the checked-out commit, which reads the working tree and your preferences; run melian doctor "#<number>" for a pull request's plan$/,
			),
		);
	});
});

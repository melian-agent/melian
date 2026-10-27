import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pullRequestChangesetId, type StoredComparison } from "@melian-agent/core";
import { buildGoldenRepository, loadGoldens } from "@melian-agent/evals";
import { ComparisonReader, backgroundContext as context, openSqliteStorage } from "@melian-agent/pipeline";
import { afterEach, describe, expect, it } from "vitest";
import { gitIn, isolatedGitEnv, temporaryDirectory } from "../../core/test/fixtures/repo.ts";
import { storagePath } from "../src/repository.ts";

const bin = fileURLToPath(new URL("../bin/melian.js", import.meta.url));
const golden = loadGoldens().find((each) => each.name === "correctness-null-deref")!;
const threads = readFileSync(new URL("../../github/test/fixtures/review-threads.json", import.meta.url), "utf8");
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("offline pull request export after a later review and explicit import", { timeout: 90_000 }, () => {
	it.each([
		[true, "json", "stdout"],
		[true, "json", "file"],
		[true, "markdown", "stdout"],
		[true, "markdown", "file"],
		[false, "json", "stdout"],
		[false, "json", "file"],
		[false, "markdown", "stdout"],
		[false, "markdown", "file"],
	] as const)("preserves both rounds (snapshot %s, %s, %s)", async (snapshot, format, destination) => {
		const { repo } = buildGoldenRepository(golden);
		const files = temporaryDirectory();
		const bare = temporaryDirectory();
		directories.push(repo, files, bare);
		writeFileSync(join(repo, "melian.yaml"), "tiers:\n  fast: [guardrails]\n");
		gitIn(repo, "checkout", "--quiet", "main");
		gitIn(repo, "add", "melian.yaml");
		gitIn(repo, "commit", "--quiet", "-m", "policy");
		gitIn(repo, "checkout", "--quiet", "feature");
		gitIn(repo, "merge", "--quiet", "--no-edit", "main");
		const base = gitIn(repo, "rev-parse", "main");
		gitIn(bare, "init", "--quiet", "--bare");
		gitIn(repo, "remote", "add", "origin", "git@github.com:melian-agent/example.git");
		const ssh = join(files, "ssh");
		writeFileSync(ssh, '#!/bin/sh\nexec git upload-pack "$MELIAN_TEST_ORIGIN"\n');
		chmodSync(ssh, 0o755);
		const script = join(files, "script.json");
		writeFileSync(script, JSON.stringify(golden.script));
		const recording = join(files, "github.json");
		const env = {
			MELIAN_TEST_SCRIPT: script,
			MELIAN_TEST_GITHUB: recording,
			MELIAN_STATE_DIR: join(files, "state"),
			MELIAN_TEST_ORIGIN: bare,
			GIT_SSH_COMMAND: ssh,
		};
		const run = (args: string[], offline = false) => {
			const result = spawnSync(process.execPath, [bin, ...args], {
				cwd: repo,
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					...isolatedGitEnv,
					NO_COLOR: "1",
					...env,
					...(offline ? { MELIAN_TEST_GITHUB: join(files, "absent-recording.json") } : {}),
				},
			});
			expect(result.error).toBeUndefined();
			return result;
		};
		const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
		const publish = (heads: string[]) => {
			const head = heads.at(-1)!;
			gitIn(repo, "push", "--quiet", bare, "main:refs/heads/main", `${head}:refs/pull/7/head`);
			const recorded = JSON.parse(threads.replaceAll("1".repeat(40), head));
			for (const page of recorded.graphql.MelianReviewThreads) page.data.repository.pullRequest.headRefOid = head;
			const pull = { baseRefOid: base, headRefOid: head, mergeCommit: null };
			recorded.graphql.MelianRoundCommits = [
				{
					data: {
						repository: {
							pullRequest: { ...pull, commits: connection(heads.map((oid) => ({ commit: { oid } }))) },
						},
					},
				},
			];
			recorded.graphql.MelianRoundPushes = [
				{ data: { repository: { pullRequest: { ...pull, timelineItems: connection([]) } } } },
			];
			recorded.graphql.MelianRoundAssociations = [
				{
					data: {
						repository: {
							object: {
								associatedPullRequests: connection([
									{ number: 7, repository: { name: "example", owner: { login: "melian-agent" } } },
								]),
							},
						},
					},
				},
			];
			recorded.pullRequest = {
				number: 7,
				title: "t",
				state: "open",
				html_url: "https://github.com/melian-agent/example/pull/7",
				base: {
					ref: "main",
					sha: base,
					repo: {
						clone_url: "https://github.com/melian-agent/example.git",
						name: "example",
						owner: { login: "melian-agent" },
					},
				},
				head: { ref: "feature", sha: head },
			};
			writeFileSync(recording, JSON.stringify(recorded));
		};
		const first = gitIn(repo, "rev-parse", "feature");
		publish([first]);
		expect(run(["review", "#7"]).status).toBe(1);
		expect(run(["compare", "#7", "--from", "github"]).status).toBe(0);
		if (snapshot) expect(run(["compare", "#7"]).status).toBe(0);
		writeFileSync(join(repo, "NOTES.md"), "later push\n");
		gitIn(repo, "add", "NOTES.md");
		gitIn(repo, "commit", "--quiet", "-m", "later push");
		const second = gitIn(repo, "rev-parse", "feature");
		publish([first, second]);
		expect(run(["review", "#7"]).status).toBe(1);
		expect(run(["compare", "#7", "--from", "github"]).status).toBe(0);
		const changeset = pullRequestChangesetId("github", { owner: "melian-agent", name: "example" }, 7);
		const path = await storagePath(repo, changeset, env, true);
		const storage = await openSqliteStorage(path);
		let external: string;
		try {
			const entries = await ComparisonReader.open(storage).read(changeset);
			expect(entries.map((entry) => entry.round)).toEqual([`${changeset}.r1`, `${changeset}.r2`]);
			external = entries[1]!.comparison.externalOnly()[0]!.external[0]!.id;
		} finally {
			await storage.close(context);
		}
		for (const [verdict, note] of [
			["noise", "First r2 decision"],
			["valid", "Second r2 decision"],
		]) {
			const result = run([
				"compare",
				"adjudicate",
				"#7",
				external!,
				"--verdict",
				verdict!,
				"--note",
				note!,
				...(verdict === "valid" ? ["--reason", "no-owner"] : []),
			]);
			expect(result.status, result.stderr).toBe(0);
		}
		const reopened = await openSqliteStorage(path);
		let expected: StoredComparison;
		try {
			expected = (await ComparisonReader.open(reopened).read(changeset))[1]!.comparison.toJSON();
			expect(expected.adjudications![external!]!.history).toHaveLength(1);
		} finally {
			await reopened.close(context);
		}
		const out = join(files, `export.${format}`);
		const result = run(
			[
				"compare",
				"export",
				"#7",
				...(format === "json" ? ["--json"] : []),
				...(destination === "file" ? ["--out", out] : []),
			],
			true,
		);
		expect(result.status, result.stderr).toBe(0);
		const text = destination === "file" ? readFileSync(out, "utf8") : result.stdout;
		if (format === "json") {
			const exported = JSON.parse(text);
			expect(Object.keys(exported.comparisons)).toEqual([`${changeset}.r1`, `${changeset}.r2`]);
			expect(exported.comparisons[`${changeset}.r2`]).toEqual(expected);
			if (snapshot) {
				expect(exported.membership.version).toBe(1);
				expect(exported.membership.members.map((member: { id: string }) => member.id)).toEqual([`${changeset}.r1`]);
				expect(exported.history).toEqual([exported.membership]);
			} else expect(exported.membership).toBeUndefined();
		} else {
			expect(text).toContain(second.slice(0, 12));
			expect(text).toContain("Second r2 decision");
		}
	});
});

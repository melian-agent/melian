import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredVerdict } from "@melian-agent/core";
import { buildGoldenRepository, loadGoldens } from "@melian-agent/evals";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = join(root, "packages/cli/bin/melian.js");
const golden = loadGoldens().find((each) => each.name === "correctness-null-deref")!;
// Written by hand from GitHub's documented shape: two CodeRabbit threads, one resolved at src/user.ts lines 7 and 8,
// one outdated on a file outside the diff, a human's thread, and one CodeRabbit review body.
const threads = JSON.parse(readFileSync(join(root, "packages/github/test/fixtures/review-threads.json"), "utf8")) as {
	graphql: { MelianReviewThreads: { data: { repository: { pullRequest: { headRefOid: string } } } }[] };
};

const gitEnv = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Melian Test",
	GIT_AUTHOR_EMAIL: "test@melian.invalid",
	GIT_COMMITTER_NAME: "Melian Test",
	GIT_COMMITTER_EMAIL: "test@melian.invalid",
};

const cleanup: string[] = [];

afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(prefix: string): string {
	const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanup.push(path);
	return path;
}

function melian(cwd: string, args: string[], env: Record<string, string> = {}) {
	const result = spawnSync(process.execPath, [bin, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...gitEnv, NO_COLOR: "1", ...env },
		timeout: 60_000,
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, env: { ...process.env, ...gitEnv }, encoding: "utf8" }).trim();
}

// The null-dereference golden, checked out on its feature branch, with its script and an uncommitted melian.yaml that
// keeps the deterministic checks to guardrails for a range on the checked-out commit.
function checkout() {
	const { repo } = buildGoldenRepository(golden);
	cleanup.push(repo);
	writeFileSync(join(repo, "melian.yaml"), "tiers:\n  fast: [guardrails]\n");
	const files = scratch("melian-compare-cli-");
	const script = join(files, "script.json");
	writeFileSync(script, JSON.stringify(golden.script));
	return { repo, files, env: { MELIAN_TEST_SCRIPT: script } };
}

const range = "main...feature";

function codexFile(files: string, findings: object[]): string {
	const path = join(files, "codex.json");
	writeFileSync(path, JSON.stringify({ verdict: "needs-attention", summary: "s", findings, next_steps: [] }));
	return path;
}

const codexFinding = (line: number, title: string) => ({
	severity: "high",
	title,
	body: `${title}, in detail.`,
	file: "src/user.ts",
	line_start: line,
	line_end: line,
	confidence: 0.9,
	recommendation: "",
});

function reviewed() {
	const setup = checkout();
	expect(melian(setup.repo, ["review", range], setup.env).status).toBe(1);
	const verdict = JSON.parse(melian(setup.repo, ["findings", range, "--json"], setup.env).stdout) as StoredVerdict;
	return { ...setup, id: verdict.findings.block[0]!.properties.id };
}

describe("melian compare", { timeout: 60_000 }, () => {
	it("says Melian has no review to compare against, and imports nothing", () => {
		const { repo, files, env } = checkout();
		const path = codexFile(files, [codexFinding(7, "Null manager")]);

		const result = melian(repo, ["compare", range, "--from", `file:${path}`], env);

		expect(result).toMatchObject({ status: 1, stdout: "" });
		expect(result.stderr).toContain(`run melian review ${range}`);
	});

	it("imports a reviewer's file, matches it by site, and lists what nothing matched", () => {
		const { repo, files, env, id } = reviewed();
		const path = codexFile(files, [codexFinding(8, "Null manager"), codexFinding(1, "Interface is wide")]);

		const result = melian(repo, ["compare", range, "--from", `file:${path}`], env);

		expect(result).toMatchObject({ status: 0, stderr: "" });
		const lines = result.stdout.split("\n");
		expect(lines[0]).toBe(`Imported 2 from file:${path}.`);
		expect(lines[1]).toMatch(/^Compared 2 external findings with Melian's 1 at [0-9a-f]{12}\.$/);
		expect(lines[2]).toBe("Matched: 1. External only: 1. Melian only: 0. Skipped review bodies: 0.");
		expect(lines[3]).toBe("External only:");
		expect(lines[4]).toMatch(/^ {2}[0-9a-f]{16} {2}codex {2}src\/user\.ts:1 {2}Interface is wide$/);
		expect(result.stdout).not.toContain(id);
	});

	it("keeps a hand unmatch and a hand match across a second import", () => {
		const { repo, files, env, id } = reviewed();
		const path = codexFile(files, [codexFinding(8, "Null manager"), codexFinding(30, "Somewhere else")]);
		const first = melian(repo, ["compare", range, "--from", `file:${path}`], env);
		const far = /^ {2}([0-9a-f]{16}) {2}codex {2}src\/user\.ts:30/m.exec(first.stdout)![1]!;

		const matched = melian(repo, ["compare", "match", range, far, id], env);

		expect(matched).toMatchObject({ status: 0, stderr: "" });
		expect(matched.stdout).toBe(
			`Matched ${far} with ${id} as Melian Test <test@melian.invalid>.\nMatched: 1. External only: 0. Melian only: 0.\n`,
		);
		const again = melian(repo, ["compare", range, "--from", `file:${path}`], env);
		expect(again.stdout).toContain("Matched: 1. External only: 0. Melian only: 0.");
		const unmatched = melian(repo, ["compare", "unmatch", range, far, id], env);
		expect(unmatched.stdout).toContain(`Unmatched ${far} from ${id}`);
		expect(unmatched.stdout).toContain("Matched: 1. External only: 1. Melian only: 0.");
		// Without --from, it matches again against the stored review, keeping the unmatch.
		const rerun = melian(repo, ["compare", range], env);
		expect(rerun.stdout).toContain("Matched: 1. External only: 1. Melian only: 0.");
	});

	it("never prints a control character a reviewer's file holds, in its text, its bytes, or its keys", () => {
		const { repo, files, env } = reviewed();
		const control = "\u001b";
		const titled = join(files, "titled.json");
		writeFileSync(
			titled,
			JSON.stringify({ reviewer: { name: "codex" }, findings: [{ title: `${control}[2Jgone`, body: "", line: 1 }] }),
		);
		const raw = join(files, "raw.json");
		writeFileSync(raw, `{"reviewer": {"name": "codex"}, "findings": [{"title": "${control}[2J", "body": ""}]}`);
		const keyed = join(files, "keyed.json");
		writeFileSync(
			keyed,
			JSON.stringify({ reviewer: { name: "codex" }, findings: [{ title: "t", body: "", [control]: 1 }] }),
		);

		const shown = melian(repo, ["compare", range, "--from", `file:${titled}`], env);
		const bytes = melian(repo, ["compare", range, "--from", `file:${raw}`], env);
		const key = melian(repo, ["compare", range, "--from", `file:${keyed}`], env);

		expect(shown.status).toBe(0);
		expect(shown.stdout).toContain("\\u001b[2Jgone");
		expect(bytes).toMatchObject({
			status: 1,
			stderr: expect.stringMatching(/raw\.json: it is not JSON at position \d+\n$/),
		});
		expect(key).toMatchObject({ status: 1, stderr: expect.stringContaining("has an unknown key in /findings/0") });
		for (const result of [shown, bytes, key]) expect(result.stdout + result.stderr).not.toContain(control);
	});

	it("refuses a hand match naming a finding it does not hold", () => {
		const { repo, files, env, id } = reviewed();
		melian(repo, ["compare", range, "--from", `file:${codexFile(files, [codexFinding(8, "x")])}`], env);

		const result = melian(repo, ["compare", "match", range, "0123456789abcdef", id], env);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			`the comparison has no external finding 0123456789abcdef; melian compare ${range} lists the findings`,
		);
	});

	it.each([
		["a source it does not know", ["compare", range, "--from", "gitlab"], "--from takes github"],
		["github on a range", ["compare", range, "--from", "github"], 'name it as "#12"'],
		[
			"a hand match without both IDs",
			["compare", "match", range, "0123456789abcdef"],
			"an external ID, and a Melian ID",
		],
		[
			"a hand match with a malformed ID",
			["compare", "unmatch", range, "x", "0123456789abcdef"],
			"is not a finding ID",
		],
	])("exits 64 for %s", (_, args, message) => {
		expect(melian(root, args)).toMatchObject({ status: 64, stderr: expect.stringContaining(message) });
	});
});

describe('melian compare "#N"', { timeout: 60_000 }, () => {
	// The golden as pull request #7 of melian-agent/example: its origin is GitHub's URL, which a stand-in for ssh serves
	// from a bare repository on disk, and scripted mode answers GitHub from a recording. The base commits a melian.yaml, since a pull
	// request reads policy from its base.
	function pullRequest(moved = false) {
		const { repo, files, env } = checkout();
		git(repo, "checkout", "--quiet", "main");
		git(repo, "add", "melian.yaml");
		git(repo, "commit", "--quiet", "-m", "policy");
		git(repo, "checkout", "--quiet", "feature");
		git(repo, "merge", "--quiet", "--no-edit", "main");
		const base = git(repo, "rev-parse", "main");
		const head = git(repo, "rev-parse", "feature");
		const bare = scratch("melian-compare-origin-");
		git(bare, "init", "--quiet", "--bare");
		git(repo, "push", "--quiet", bare, "main:refs/heads/main", "feature:refs/pull/7/head");
		const url = "git@github.com:melian-agent/example.git";
		git(repo, "remote", "add", "origin", url);
		// Stands in for ssh, so git fetches from the bare repository whatever host and path it asks for.
		const ssh = join(files, "ssh");
		writeFileSync(ssh, `#!/bin/sh\nexec git upload-pack '${bare}'\n`);
		chmodSync(ssh, 0o755);
		const recorded = structuredClone(threads);
		for (const page of recorded.graphql.MelianReviewThreads) {
			page.data.repository.pullRequest.headRefOid = moved ? "f".repeat(40) : head;
		}
		const recording = {
			...recorded,
			pullRequest: {
				number: 7,
				title: "Name the manager",
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
			},
		};
		const path = join(files, "github.json");
		writeFileSync(path, JSON.stringify(recording));
		return { repo, files, env: { ...env, MELIAN_TEST_GITHUB: path, GIT_SSH_COMMAND: ssh } };
	}

	it("imports CodeRabbit's threads, matches the resolved one, and counts the review body it skipped", () => {
		const { repo, env } = pullRequest();
		const review = melian(repo, ["review", "#7"], env);
		expect(review, review.stdout + review.stderr).toMatchObject({ status: 1 });

		// A pull request imports CodeRabbit's threads when no source is named.
		const result = melian(repo, ["compare", "#7"], env);

		expect(result).toMatchObject({ status: 0, stderr: "" });
		const lines = result.stdout.split("\n");
		expect(lines[0]).toBe("Imported 2 from github:coderabbitai[bot], skipping 1 review body without a thread.");
		expect(lines[2]).toBe("Matched: 1. External only: 1. Melian only: 0. Skipped review bodies: 1.");
		expect(lines[4]).toMatch(
			/^ {2}[0-9a-f]{16} {2}coderabbit {2}docs\/removed\.md:4 \(outdated\) {2}\*\*The heading names a command/,
		);
		const human = melian(repo, ["compare", "#7", "--from", "github:octocat"], env);
		expect(human.stdout).toContain("Imported 1 from github:octocat, skipping 1 review body without a thread.");
		expect(human.stdout).toMatch(/octocat {2}src\/user\.ts:20 {2}Should this log the name too\?/);
	});

	it("refuses a pull request that moved since Melian's review, and records nothing from any source", () => {
		const { repo, files, env } = pullRequest(true);
		expect(melian(repo, ["review", "#7"], env).status).toBe(1);

		// A good file first, then GitHub, which fails: the file's finding is held back with it.
		const good = codexFile(files, [codexFinding(8, "Null manager")]);
		const result = melian(repo, ["compare", "#7", "--from", `file:${good}`, "--from", "github"], env);

		expect(result).toMatchObject({ status: 1, stdout: "" });
		expect(result.stderr).toContain(`pull request #7 is at ffffffffffff now`);
		expect(result.stderr).toContain(`run melian review "#7" first`);
		const empty = join(files, "empty.json");
		writeFileSync(empty, JSON.stringify({ reviewer: { name: "claude-code" }, findings: [] }));
		const after = melian(repo, ["compare", "#7", "--from", `file:${empty}`], env);
		expect(after.stdout).toContain("Compared 0 external findings with Melian's 1");
	});
});

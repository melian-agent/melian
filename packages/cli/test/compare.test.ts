import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
		expect(lines[2]).toBe(
			"Matched: 1 external finding, covering 1 Melian finding. External only: 1. Melian only: 0. Skipped review bodies: 0.",
		);
		expect(lines[3]).toBe("External only:");
		expect(lines[4]).toMatch(/^ {2}[0-9a-f]{16} {2}codex {2}src\/user\.ts:1 {2}Interface is wide$/);
		expect(result.stdout).not.toContain(id);
	});

	it("lists a Melian finding no reviewer raised, with its ID, severity, rule, and place", () => {
		const { repo, files, env, id } = reviewed();
		const path = codexFile(files, [codexFinding(30, "Somewhere else")]);

		const result = melian(repo, ["compare", range, "--from", `file:${path}`], env);

		expect(result).toMatchObject({ status: 0, stderr: "" });
		expect(result.stdout).toContain("External only: 1. Melian only: 1. Skipped review bodies: 0.");
		expect(result.stdout).toMatch(
			new RegExp(`^Melian only:\\n {2}${id} {2}P\\d \\S+ {2}src/user\\.ts:\\d+(-\\d+)?$`, "m"),
		);
	});

	it("keeps a hand unmatch and a hand match across a second import", () => {
		const { repo, files, env, id } = reviewed();
		const path = codexFile(files, [codexFinding(8, "Null manager"), codexFinding(30, "Somewhere else")]);
		const first = melian(repo, ["compare", range, "--from", `file:${path}`], env);
		const far = /^ {2}([0-9a-f]{16}) {2}codex {2}src\/user\.ts:30/m.exec(first.stdout)![1]!;

		const matched = melian(repo, ["compare", "match", range, far, id], env);

		expect(matched).toMatchObject({ status: 0, stderr: "" });
		expect(matched.stdout).toBe(
			`Matched ${far} with ${id} as Melian Test <test@melian.invalid>.\nMatched: 2 external findings, covering 1 Melian finding. External only: 0. Melian only: 0.\n`,
		);
		const again = melian(repo, ["compare", range, "--from", `file:${path}`], env);
		expect(again.stdout).toContain(
			"Matched: 2 external findings, covering 1 Melian finding. External only: 0. Melian only: 0.",
		);
		const unmatched = melian(repo, ["compare", "unmatch", range, far, id], env);
		expect(unmatched.stdout).toContain(`Unmatched ${far} from ${id}`);
		expect(unmatched.stdout).toContain(
			"Matched: 1 external finding, covering 1 Melian finding. External only: 1. Melian only: 0.",
		);
		// Without --from, it matches again against the stored review, keeping the unmatch.
		const rerun = melian(repo, ["compare", range], env);
		expect(rerun.stdout).toContain(
			"Matched: 1 external finding, covering 1 Melian finding. External only: 1. Melian only: 0.",
		);
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

	it("prints an error message's control characters as visible text", () => {
		const { repo, env } = reviewed();

		const result = melian(repo, ["compare", range, "--from", "gitlab\u001b[2J"], env);

		expect(result.status).toBe(64);
		expect(result.stderr).toContain("not gitlab\\u001b[2J");
		expect(result.stdout + result.stderr).not.toContain("\u001b");
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
		// The fixture's threads read at 1111…, its head, except the outdated one, read at an earlier commit.
		const recorded = JSON.parse(JSON.stringify(threads).replaceAll("1".repeat(40), head)) as typeof threads;
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
		expect(lines[2]).toBe(
			"Matched: 1 external finding, covering 1 Melian finding. External only: 1. Melian only: 0. Skipped review bodies: 1.",
		);
		expect(lines[4]).toMatch(
			/^ {2}[0-9a-f]{16} {2}coderabbit {2}docs\/removed\.md:4 \(outdated\) {2}\*\*The heading names a command .* {2}\(read at 222222222222; match it by hand\)$/,
		);
		const missed = /^ {2}([0-9a-f]{16}) {2}coderabbit/m.exec(result.stdout)![1]!;
		expect(
			melian(
				repo,
				[
					"compare",
					"adjudicate",
					"#7",
					missed,
					"--verdict",
					"valid",
					"--reason",
					"out-of-scope",
					"--golden",
					"none",
				],
				env,
			).status,
		).toBe(0);
		const exported = melian(repo, ["compare", "export", "#7"], env);
		expect(exported).toMatchObject({ status: 0, stderr: "" });
		expect(exported.stdout).toContain("https://github.com/melian-agent/example/pull/7");
		const human = melian(repo, ["compare", "#7", "--from", "github:octocat"], env);
		expect(human.stdout).toContain("Imported 1 from github:octocat, skipping 1 review body without a thread.");
		expect(human.stdout).toMatch(/octocat {2}src\/user\.ts:20 {2}Should this log the name too\?/);
	});

	it("ignores the recording without scripted mode, and fails to find a GitHub token instead of answering from it", () => {
		const { repo, env } = pullRequest();
		const { MELIAN_TEST_SCRIPT: _script, ...unscripted } = env;
		// A PATH with git alone keeps `gh` from supplying a token from the developer's login.
		const bin = scratch("melian-compare-path-");
		symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));

		const result = melian(repo, ["review", "#7"], { ...unscripted, GITHUB_TOKEN: "", GH_TOKEN: "", PATH: bin });

		expect(result).toMatchObject({ status: 2, stdout: "" });
		expect(result.stderr).toContain("no GitHub token");
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

describe("melian compare adjudicate", { timeout: 60_000 }, () => {
	it("records a miss and says judging Melian noise does not dismiss it", () => {
		const { repo, files, env, id } = reviewed();
		const path = codexFile(files, [codexFinding(30, "Missed")]);
		const imported = melian(repo, ["compare", range, "--from", `file:${path}`], env);
		const external = /^ {2}([0-9a-f]{16}) {2}codex/m.exec(imported.stdout)![1]!;
		const missing = melian(repo, ["compare", "adjudicate", range, external, "--verdict", "valid"], env);
		expect(missing).toMatchObject({ status: 1, stderr: expect.stringContaining("needs a miss reason") });
		const valid = melian(
			repo,
			[
				"compare",
				"adjudicate",
				range,
				external,
				"--verdict",
				"valid",
				"--severity",
				"P1",
				"--reason",
				"owned-missed",
				"--golden",
				"correctness",
				"--rule",
				"null-dereference",
				"--note",
				"Add a golden.",
			],
			env,
		);
		expect(valid).toMatchObject({
			status: 0,
			stderr: "",
			stdout: expect.stringContaining("Melian Test <test@melian.invalid>"),
		});
		const before = melian(repo, ["findings", range, "--json"], env).stdout;
		const noise = melian(
			repo,
			["compare", "adjudicate", range, id, "--verdict", "noise", "--golden", "correctness"],
			env,
		);
		expect(noise).toMatchObject({ status: 0, stderr: "", stdout: expect.stringContaining("does not dismiss") });
		expect(melian(repo, ["findings", range, "--json"], env).stdout).toBe(before);
	});

	it.each([
		["--verdict", "wrong"],
		["--severity", "high"],
		["--reason", "unknown"],
		["--golden", "bad lens"],
		["--note", "x".repeat(1001)],
	])("refuses invalid %s", (option, value) => {
		const result = melian(root, [
			"compare",
			"adjudicate",
			range,
			"0".repeat(16),
			"--verdict",
			"valid",
			option,
			value,
		]);
		expect(result.status).toBe(64);
	});
});

describe("melian compare stats and backlog", { timeout: 60_000 }, () => {
	it("reads the clone's stored comparisons and lists current golden debt", () => {
		const { repo, files, env } = reviewed();
		const path = codexFile(files, [codexFinding(30, "Missed")]);
		const imported = melian(repo, ["compare", range, "--from", `file:${path}`], env);
		const external = /^ {2}([0-9a-f]{16}) {2}codex/m.exec(imported.stdout)![1]!;
		expect(
			melian(
				repo,
				[
					"compare",
					"adjudicate",
					range,
					external,
					"--verdict",
					"valid",
					"--reason",
					"needs-execution",
					"--golden",
					"correctness",
				],
				env,
			).status,
		).toBe(0);
		const stats = melian(repo, ["compare", "stats", "--last", "1"], env);
		expect(stats).toMatchObject({ status: 0, stderr: "" });
		expect(stats.stdout).toContain("melian: recall 0/1 (0.000), precision 0/0 (1.000), pending 1.");
		expect(stats.stdout).toContain("needs-execution: 1.");
		expect(stats.stdout).toContain("Drain not due");
		expect(melian(repo, ["compare", "stats", "--since", "2099-01-01"], env).stdout).toContain("Comparisons: 0.");
		const backlog = melian(repo, ["compare", "backlog"], env);
		expect(backlog).toMatchObject({
			status: 0,
			stderr: "",
			stdout: expect.stringContaining(`correctness: ${range} ${external} Missed`),
		});
		expect(melian(repo, ["compare", "backlog", "--markdown"], env).stdout).toContain("## Stored comparison backlog");
		expect(
			melian(
				repo,
				[
					"compare",
					"adjudicate",
					range,
					external,
					"--verdict",
					"valid",
					"--reason",
					"needs-execution",
					"--golden",
					"none",
				],
				env,
			).status,
		).toBe(0);
		expect(melian(repo, ["compare", "backlog"], env).stdout).toBe("No goldens owed.\n");
	});

	it.each([
		["--last", "0"],
		["--last", "-1"],
		["--last", "1.5"],
		["--since", "yesterday"],
		["--since", "2026-99-99"],
		["--since", "2026-02-31"],
	])("refuses invalid %s", (option, value) => {
		expect(melian(root, ["compare", "stats", option, value]).status).toBe(64);
	});
});

describe("melian compare export", { timeout: 60_000 }, () => {
	it("exports the record to stdout or a local path, and JSON keeps replacement history", () => {
		const { repo, files, env, id } = reviewed();
		const path = codexFile(files, [codexFinding(8, "Null | <img>")]);
		expect(melian(repo, ["compare", range, "--from", `file:${path}`], env).status).toBe(0);
		for (const verdict of ["valid", "noise"])
			expect(
				melian(
					repo,
					["compare", "adjudicate", range, id, "--verdict", verdict, "--note", "Maintainer choice."],
					env,
				).status,
			).toBe(0);
		const stdout = melian(repo, ["compare", "export", range], env);
		expect(stdout).toMatchObject({ status: 0, stderr: "" });
		expect(stdout.stdout).toContain("## A. codex, round 1");
		expect(stdout.stdout).toContain("## B. Melian review, round 1");
		expect(stdout.stdout).toContain("Maintainer choice.");
		expect(stdout.stdout).toContain("&lt;img&gt;");
		const output = join(files, "comparison.md");
		expect(melian(repo, ["compare", "export", range, "--out", output], env)).toMatchObject({
			status: 0,
			stderr: "",
			stdout: `Exported comparison to ${output}.\n`,
		});
		expect(readFileSync(output, "utf8")).toBe(stdout.stdout);
		const json = melian(repo, ["compare", "export", range, "--json"], env);
		expect(json).toMatchObject({ status: 0, stderr: "" });
		const records = Object.values(JSON.parse(json.stdout).comparisons) as {
			adjudications: Record<string, { current: { verdict: string }; history: { verdict: string }[] }>;
		}[];
		expect(records[0]?.adjudications[id]).toMatchObject({
			current: { verdict: "noise" },
			history: [{ verdict: "valid" }],
		});
	});

	it("refuses export before a comparison exists", () => {
		const { repo, env } = reviewed();
		expect(melian(repo, ["compare", "export", range], env)).toMatchObject({
			status: 1,
			stderr: expect.stringContaining("no comparison recorded"),
		});
	});
});

describe("comparison review fixes", { timeout: 60_000 }, () => {
	it("exports without a review of the current head and clears a first round's debt after another review", () => {
		const { repo, files, env, id } = reviewed();
		expect(melian(repo, ["compare", range], env).status).toBe(0);
		expect(
			melian(repo, ["compare", "adjudicate", range, id, "--verdict", "noise", "--golden", "correctness"], env)
				.status,
		).toBe(0);
		git(repo, "commit", "--quiet", "--allow-empty", "-m", "next revision");
		expect(melian(repo, ["findings", range], env).status).toBe(1);
		expect(melian(repo, ["compare", "export", range], env)).toMatchObject({ status: 0, stderr: "" });
		const clean = Object.fromEntries(
			Object.keys(golden.script).map((lens) => [lens, [{ text: "Reported 0 findings." }]]),
		);
		writeFileSync(join(files, "script.json"), JSON.stringify(clean));
		expect(melian(repo, ["review", range], env).status).toBe(0);
		expect(melian(repo, ["compare", range], env).status).toBe(0);
		expect(melian(repo, ["compare", "backlog"], env).stdout).toContain(id);
		const cleared = melian(repo, ["compare", "adjudicate", range, id, "--verdict", "noise", "--golden", "none"], env);
		expect(cleared).toMatchObject({ status: 0, stderr: "", stdout: expect.stringContaining("does not dismiss") });
		expect(melian(repo, ["compare", "backlog"], env).stdout).toBe("No goldens owed.\n");
		const json = JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout) as {
			comparisons: Record<
				string,
				{ adjudications?: Record<string, { current: { golden: string }; history: { golden: string }[] }> }
			>;
		};
		const record = Object.values(json.comparisons).find((round) => round.adjudications?.[id] !== undefined)
			?.adjudications?.[id];
		expect(record).toMatchObject({ current: { golden: "none" }, history: [{ golden: "correctness" }] });
	});

	it("warns for unknown golden lenses and refuses reasons on noise or Melian findings", () => {
		const { repo, env, id } = reviewed();
		expect(melian(repo, ["compare", range], env).status).toBe(0);
		const warned = melian(
			repo,
			["compare", "adjudicate", range, id, "--verdict", "noise", "--golden", "new-lens"],
			env,
		);
		expect(warned).toMatchObject({ status: 0, stdout: expect.stringContaining("Melian knows no lens new-lens") });
		for (const verdict of ["noise", "valid"]) {
			const refused = melian(
				repo,
				["compare", "adjudicate", range, id, "--verdict", verdict, "--reason", "no-owner"],
				env,
			);
			expect(refused).toMatchObject({ status: 1, stderr: expect.stringContaining("only to a valid external") });
		}
	});

	it("says an unmatched reasonless finding becomes pending and accepts a duplicate target", () => {
		const { repo, files, env, id } = reviewed();
		const path = codexFile(files, [codexFinding(8, "Null manager")]);
		expect(melian(repo, ["compare", range, "--from", `file:${path}`], env).status).toBe(0);
		const json = JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout) as {
			comparisons: Record<string, { external: Record<string, unknown> }>;
		};
		const external = Object.keys(Object.values(json.comparisons)[0]!.external)[0]!;
		expect(melian(repo, ["compare", "adjudicate", range, external, "--verdict", "valid"], env).status).toBe(0);
		expect(melian(repo, ["compare", "unmatch", range, external, id], env)).toMatchObject({
			status: 0,
			stdout: expect.stringContaining("pending until re-adjudicated with a miss reason"),
		});
		expect(melian(repo, ["compare", "stats"], env).stdout).toContain("Valid misses without a reason: 1.");
		expect(melian(repo, ["compare", "adjudicate", range, external, "--verdict", "duplicate"], env).status).toBe(64);
		expect(
			melian(repo, ["compare", "adjudicate", range, external, "--verdict", "duplicate", "--of", id], env).status,
		).toBe(0);
		expect(melian(repo, ["compare", "export", range], env).stdout).toContain(`duplicate of ${id}`);
	});

	it("keeps the drain clone-wide when the metrics filter excludes owed changesets", () => {
		const { repo, env, id } = reviewed();
		expect(melian(repo, ["compare", range], env).status).toBe(0);
		expect(
			melian(repo, ["compare", "adjudicate", range, id, "--verdict", "noise", "--golden", "correctness"], env)
				.status,
		).toBe(0);
		for (const branch of ["second", "third"]) {
			git(repo, "branch", branch, "feature");
			const target = `main...${branch}`;
			expect(melian(repo, ["review", target], env).status).toBe(1);
			expect(melian(repo, ["compare", target], env).status).toBe(0);
		}
		for (const filter of [
			["--last", "1"],
			["--since", "2099-01-01"],
		]) {
			const stats = melian(repo, ["compare", "stats", ...filter], env);
			expect(stats).toMatchObject({
				status: 0,
				stderr: "",
				stdout: expect.stringContaining("Drain due: ship 1 owed goldens"),
			});
		}
	});
});

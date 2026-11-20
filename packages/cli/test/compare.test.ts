import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredVerdict } from "@melian-agent/core";
import { buildGoldenRepository, loadGoldens } from "@melian-agent/evals";
import { ReviewThreadImporter } from "@melian-agent/github";
import type { PrepareRecord, Stage } from "@melian-agent/pipeline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compare } from "../src/compare.ts";
import { storagePath } from "../src/repository.ts";

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
	GIT_CONFIG_COUNT: "0",
	GIT_AUTHOR_NAME: "Melian Test",
	GIT_AUTHOR_EMAIL: "test@melian.invalid",
	GIT_COMMITTER_NAME: "Melian Test",
	GIT_COMMITTER_EMAIL: "test@melian.invalid",
};

const cleanup: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
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
		expect(lines[3]).toBe("Matched:");
		expect(lines[4]).toBe(`  ${id}`);
		expect(lines[5]).toMatch(/^ {4}[0-9a-f]{16} {2}codex {2}src\/user\.ts:8$/);
		expect(lines[lines.indexOf("External only:") + 1]).toMatch(
			/^ {2}[0-9a-f]{16} {2}codex {2}src\/user\.ts:1 {2}Interface is wide$/,
		);
	});

	it("imports both files from repeated --from arguments and keeps both findings", () => {
		const { repo, files, env, id } = reviewed();
		const codex = codexFile(files, [codexFinding(8, "Null manager")]);
		const claude = join(files, "claude.json");
		writeFileSync(
			claude,
			JSON.stringify({
				reviewer: { name: "claude-code" },
				findings: [{ ref: "1", file: "src/user.ts", line: 30, title: "Somewhere else", body: "Another problem." }],
			}),
		);

		const result = melian(repo, ["compare", range, "--from", `file:${codex}`, "--from", `file:${claude}`], env);

		expect(result).toMatchObject({ status: 0, stderr: "" });
		expect(result.stdout.split("\n").slice(0, 2)).toEqual([
			`Imported 1 from file:${codex}.`,
			`Imported 1 from file:${claude}.`,
		]);
		expect(result.stdout).toMatch(/^Compared 2 external findings with Melian's 1 at [0-9a-f]{12}\.$/m);
		expect(result.stdout).toContain(`Matched:\n  ${id}\n`);
		expect(result.stdout).toMatch(/^ {4}[0-9a-f]{16} {2}codex {2}src\/user\.ts:8$/m);
		expect(result.stdout).toMatch(
			/^External only:\n {2}[0-9a-f]{16} {2}claude-code {2}src\/user\.ts:30 {2}Somewhere else$/m,
		);
		const again = melian(repo, ["compare", range], env);
		expect(again).toMatchObject({ status: 0, stderr: "" });
		expect(again.stdout).toBe(result.stdout.split("\n").slice(2).join("\n"));
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
		const near = /^ {4}([0-9a-f]{16}) {2}codex {2}src\/user\.ts:8/m.exec(first.stdout)![1]!;
		const far = /^ {2}([0-9a-f]{16}) {2}codex {2}src\/user\.ts:30/m.exec(first.stdout)![1]!;

		const matched = melian(repo, ["compare", "match", range, far, id], env);

		expect(matched).toMatchObject({ status: 0, stderr: "" });
		expect(matched.stdout).toBe(
			`Matched ${far} with ${id} as Melian Test <test@melian.invalid>.\nMatched: 2 external findings, covering 1 Melian finding. External only: 0. Melian only: 0.\nMatched:\n  ${id}\n    ${near}  codex  src/user.ts:8\n    ${far}  codex  src/user.ts:30\n`,
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

	it("refuses a round of a range that no longer resolves without creating its store", async () => {
		const { repo, env } = checkout();
		const io = { cwd: repo, env: { ...env, ...gitEnv }, color: false, stdout: () => {}, stderr: () => {} };
		const path = await storagePath(repo, "range-ffffffffffffffff", io.env, true);

		await expect(compare(io, "main...gone", [], "range-ffffffffffffffff.r1")).rejects.toThrow("has no round");

		expect(existsSync(path)).toBe(false);
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
	// With `behind`, main gains a commit after the merge, so the base branch's tip is ahead of the diff's merge base.
	// With `policy`, the base commits that melian.yaml instead.
	function pullRequest(moved = false, behind = false, policy?: string) {
		const { repo, files, env } = checkout();
		git(repo, "checkout", "--quiet", "main");
		if (policy !== undefined) writeFileSync(join(repo, "melian.yaml"), policy);
		git(repo, "add", "melian.yaml");
		git(repo, "commit", "--quiet", "-m", "policy");
		git(repo, "checkout", "--quiet", "feature");
		git(repo, "merge", "--quiet", "--no-edit", "main");
		if (behind) {
			git(repo, "checkout", "--quiet", "main");
			git(repo, "commit", "--quiet", "--allow-empty", "-m", "main moves on");
			git(repo, "checkout", "--quiet", "feature");
		}
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

	// A review the workflow's gate did not approve spends no login: the refusal comes before the secrets files are read,
	// which an unreadable one would show, and before storage opens, so nothing is stored and no model or check is asked.
	function expecting(env: Record<string, string>) {
		const state = scratch("melian-expect-state-");
		const config = scratch("melian-expect-config-");
		mkdirSync(join(config, "melian"));
		writeFileSync(join(config, "melian", "secrets.yaml"), "credentials: [\n");
		return { state, env: { ...env, MELIAN_STATE_DIR: state, XDG_CONFIG_HOME: config } };
	}
	it.each([
		["head", (base: string) => [base, "f".repeat(40)]],
		["base", (_base: string, head: string) => ["f".repeat(40), head]],
	] as const)(
		"refuses, with nothing read or stored, a pull request whose %s is not the one expected",
		(_, expected) => {
			const { repo, env: fixture } = pullRequest();
			const { state, env } = expecting(fixture);
			const [base, head] = expected(git(repo, "rev-parse", "main"), git(repo, "rev-parse", "feature"));
			const review = melian(repo, ["review", "#7", "--expect-base", base, "--expect-head", head], env);
			expect(review.status).toBe(2);
			// The recording answers no activity read, so Octokit logs a 404 for it as it does for every review of #7 here.
			expect(review.stderr.split("\n").filter((line) => line.startsWith("melian:"))).toEqual([
				`melian: pull request #7 is at base ${git(repo, "rev-parse", "main")} and head ${git(repo, "rev-parse", "feature")}, not the expected base ${base} and head ${head}, so nothing was reviewed`,
			]);
			expect(readdirSync(state)).toEqual([]);
		},
	);
	it.each([
		["head", "main"],
		["base", "feature"],
	] as const)(
		"refuses, with nothing read or stored, a pull request whose fetched %s ref moved after GitHub answered",
		(ref, to) => {
			const { repo, files, env: fixture } = pullRequest();
			const { state, env } = expecting(fixture);
			const base = git(repo, "rev-parse", "main");
			const head = git(repo, "rev-parse", "feature");
			const moved = git(repo, "rev-parse", to);
			// Stands in for a second review of #7 in this clone. Melian's last write points the base ref at GitHub's answer,
			// so moving one ref after every transaction that writes the base ref moves it after that write too, however
			// the fetch groups its refs, and before Melian resolves the changeset.
			const hook = join(repo, ".git", "hooks", "reference-transaction");
			writeFileSync(
				hook,
				[
					"#!/bin/sh",
					'[ "$1" = committed ] || exit 0',
					'[ -n "$MOVING" ] && exit 0',
					'grep -q " refs/melian/pull/7/base$" || exit 0',
					`touch "${files}/moved"`,
					`MOVING=1 exec git update-ref refs/melian/pull/7/${ref} ${moved}`,
					"",
				].join("\n"),
			);
			chmodSync(hook, 0o755);
			const review = melian(repo, ["review", "#7", "--expect-base", base, "--expect-head", head], env);
			expect(existsSync(join(files, "moved"))).toBe(true);
			expect(review.status).toBe(2);
			const resolved = ref === "head" ? { base, head: base } : { base: head, head };
			expect(review.stderr.split("\n").filter((line) => line.startsWith("melian:"))).toEqual([
				`melian: pull request #7's fetched refs resolve to base ${resolved.base} and head ${resolved.head}, not the expected base ${base} and head ${head}, so nothing was reviewed`,
			]);
			expect(readdirSync(state)).toEqual([]);
		},
	);
	it("reviews a pull request behind its base branch at the base tip and head it expects", () => {
		const { repo, env } = pullRequest(false, true);
		const base = git(repo, "rev-parse", "main");
		const head = git(repo, "rev-parse", "feature");
		expect(git(repo, "merge-base", base, head)).not.toBe(base);
		const review = melian(
			repo,
			["review", "#7", "--expect-base", base, "--expect-head", head, "--no-walkthrough"],
			env,
		);
		expect(review, review.stdout + review.stderr).toMatchObject({ status: 1 });
		expect(melian(repo, ["findings", "#7"], env).status).toBe(0);
	});
	it("decides a pull request's round from its records under the policy its base commits", () => {
		const guardrails = "tiers:\n  fast: [guardrails]\n";
		const { repo, files, env } = pullRequest(false, false, `${guardrails}trust:\n  writers: true\n`);
		const base = git(repo, "rev-parse", "main");
		const head = git(repo, "rev-parse", "feature");
		const store = join(files, "records");
		const review = melian(
			repo,
			[
				"review",
				"#7",
				"--expect-base",
				base,
				"--expect-head",
				head,
				"--no-walkthrough",
				"--records",
				`dir:${store}`,
			],
			env,
		);
		expect(review, review.stdout + review.stderr).toMatchObject({ status: 1 });
		const host = JSON.parse(melian(repo, ["findings", "#7", "--json"], env).stdout) as StoredVerdict;
		// The checked-out head's working tree silences the P1, and a pull request never reads it.
		writeFileSync(join(repo, "melian.yaml"), `${guardrails}resolution:\n  P1: silent\n`);

		const json = melian(repo, ["findings", "#7", "--records", `dir:${store}`, "--json"], env);

		expect(json, json.stderr).toMatchObject({ status: 0 });
		expect(JSON.parse(json.stdout)).toEqual([{ round: expect.any(String), verdict: host }]);
	});
	it("reviews a pull request at the base and head it expects", () => {
		const { repo, env } = pullRequest();
		const base = git(repo, "rev-parse", "main");
		const head = git(repo, "rev-parse", "feature");
		const review = melian(
			repo,
			["review", "#7", "--expect-base", base, "--expect-head", head, "--no-walkthrough"],
			env,
		);
		expect(review, review.stdout + review.stderr).toMatchObject({ status: 1 });
		expect(melian(repo, ["findings", "#7"], env).status).toBe(0);
	});
	it.each([
		[
			"--expect-head alone",
			["review", "#7", "--expect-head", "f".repeat(40)],
			"review takes --expect-base and --expect-head together",
		],
		[
			"--expect-base alone",
			["review", "#7", "--expect-base", "f".repeat(40)],
			"review takes --expect-base and --expect-head together",
		],
		[
			"both on a range",
			["review", range, "--expect-base", "f".repeat(40), "--expect-head", "f".repeat(40)],
			'--expect-base and --expect-head take a pull request such as "#12", not a range',
		],
		[
			"both on another command",
			["findings", "#7", "--expect-base", "f".repeat(40), "--expect-head", "f".repeat(40)],
			"--expect-base and --expect-head are only available for review",
		],
	])("exits 64 for %s", (_, args, message) => {
		const { repo, env } = pullRequest();
		expect(melian(repo, args, env)).toMatchObject({ status: 64, stderr: expect.stringContaining(message) });
	});
	it("imports CodeRabbit's threads, matches the resolved one, and counts the review body it skipped", () => {
		const { repo, env } = pullRequest();
		const review = melian(repo, ["review", "#7"], env);
		expect(review, review.stdout + review.stderr).toMatchObject({ status: 1 });
		const { prepare, stages } = JSON.parse(melian(repo, ["telemetry", "#7", "--json"], env).stdout) as {
			prepare: PrepareRecord;
			stages: Stage[];
		};
		const walkthrough = stages.find(({ name }) => name === "melian.walkthrough")!;
		expect(walkthrough.endedAt).toBeDefined();
		// The walkthrough is a task; the review's own steps stop while it runs.
		for (const span of prepare.spans)
			expect(
				span.endedAt <= walkthrough.startedAt! || span.startedAt >= walkthrough.endedAt!,
				`${span.name} overlaps the walkthrough`,
			).toBe(true);

		// Explicit imports retain current-revision behaviour until build 4 adds membership routing.
		const result = melian(repo, ["compare", "#7", "--from", "github"], env);

		expect(result).toMatchObject({ status: 0, stderr: "" });
		const lines = result.stdout.split("\n");
		expect(lines[0]).toBe("Imported 2 from github:coderabbitai[bot], skipping 1 review body without a thread.");
		expect(lines[2]).toBe(
			"Matched: 1 external finding, covering 1 Melian finding. External only: 1. Melian only: 0. Skipped review bodies: 1.",
		);
		expect(lines[lines.indexOf("External only:") + 1]).toMatch(
			/^ {2}[0-9a-f]{16} {2}coderabbit {2}docs\/removed\.md:4 \(outdated\) {2}The heading names a command that no longer exists\. {2}\(read at 222222222222; match it by hand\)$/,
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

	it("counts an adjudicated pull request in stats and the backlog", () => {
		const { repo, env } = pullRequest();
		expect(melian(repo, ["review", "#7"], env).status).toBe(1);
		const imported = melian(repo, ["compare", "#7", "--from", "github"], env);
		const missed = /^ {2}([0-9a-f]{16}) {2}coderabbit/m.exec(imported.stdout)![1]!;
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
					"no-owner",
					"--golden",
					"correctness",
				],
				env,
			).status,
		).toBe(0);
		const stats = melian(repo, ["compare", "stats"], env);
		expect(stats).toMatchObject({ status: 0, stderr: "" });
		expect(stats.stdout).toContain("Comparisons: 1.");
		expect(stats.stdout).toContain("coderabbit");
		const backlog = melian(repo, ["compare", "backlog"], env);
		expect(backlog).toMatchObject({
			status: 0,
			stderr: "",
			stdout: expect.stringContaining(`correctness: #7 ${missed}`),
		});
	});

	it("counts the review bodies skipped by every source the comparison holds, not only this run's", () => {
		const { repo, env } = pullRequest();
		expect(melian(repo, ["review", "#7"], env).status).toBe(1);
		expect(melian(repo, ["compare", "#7", "--from", "github"], env).stdout).toContain("Skipped review bodies: 1.");

		const human = melian(repo, ["compare", "#7", "--from", "github:octocat"], env);

		expect(human.stdout).toContain("Imported 1 from github:octocat, skipping 1 review body without a thread.");
		expect(human.stdout).toContain("Skipped review bodies: 2.");
	});

	it("writes a pull request's valid miss as a misses file", () => {
		const { repo, files, env } = pullRequest();
		expect(melian(repo, ["review", "#7"], env).status).toBe(1);
		const path = join(files, "claude.json");
		writeFileSync(
			path,
			JSON.stringify({
				reviewer: { name: "claude-code" },
				findings: [{ file: "src/user.ts", line: 2, title: "Unchecked token", body: "b" }],
			}),
		);
		expect(melian(repo, ["compare", "#7", "--from", `file:${path}`], env).status).toBe(0);
		const [name, stored] = Object.entries(
			JSON.parse(melian(repo, ["compare", "export", "#7", "--json"], env).stdout).comparisons,
		)[0] as [string, { base: string; head: string; external: Record<string, { title: string }> }];
		const missed = Object.keys(stored.external)[0]!;
		expect(
			melian(repo, ["compare", "adjudicate", "#7", missed, "--verdict", "valid", "--reason", "owned-missed"], env)
				.status,
		).toBe(0);
		const output = join(files, "misses.json");

		const result = melian(repo, ["compare", "misses", "#7", "--out", output, "--reason", "owned-missed"], env);

		expect(result).toMatchObject({ status: 0, stdout: `Exported 1 miss to ${output}.\n`, stderr: "" });
		expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
			{
				name: `${name.split(".")[0]}-${missed}`,
				repo: git(repo, "rev-parse", "--show-toplevel"),
				base: stored.base,
				head: stored.head,
				file: "src/user.ts",
				lines: [2, 2],
			},
		]);
	});

	it("passes the repository, pull request and author to the thread importer", async () => {
		const { repo, env } = pullRequest();
		expect(melian(repo, ["review", "#7"], env).status).toBe(1);
		const open = vi.spyOn(ReviewThreadImporter, "open");

		expect(
			await compare({ cwd: repo, env, color: false, stdout: () => {}, stderr: () => {} }, "#7", [
				{ kind: "github", login: "octocat" },
			]),
		).toBe(0);

		expect(open).toHaveBeenCalledExactlyOnceWith({
			owner: "melian-agent",
			repo: "example",
			pullRequest: 7,
			login: "octocat",
			token: "scripted",
			fetch: expect.any(Function),
		});
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
		expect(stats.stdout).toContain("Drain not due; next comparison threshold: 3.\n");
		expect(melian(repo, ["compare", "stats", "--since", "2099-01-01"], env).stdout).toMatch(
			/Comparisons: 0\.\nClone-wide, not narrowed by the filter:\nPending matches: \d+\./,
		);
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

	it("titles a Melian golden from its verdict and keeps candidate checks clone-wide", () => {
		const { repo, files, env, id } = reviewed();
		const stored = JSON.parse(melian(repo, ["findings", range, "--json"], env).stdout) as StoredVerdict;
		const what = stored.findings.block[0]!.properties.explanation.what;
		expect(melian(repo, ["compare", range], env).status).toBe(0);
		expect(
			melian(repo, ["compare", "adjudicate", range, id, "--verdict", "valid", "--golden", "correctness"], env)
				.status,
		).toBe(0);
		expect(melian(repo, ["compare", "backlog"], env).stdout).toContain(
			`correctness: ${range} ${id} ${what} (valid).`,
		);
		const path = codexFile(files, [codexFinding(30, "Missed")]);
		const targets = [range];
		git(repo, "branch", "second", "feature");
		targets.push("main...second");
		for (const target of targets) {
			if (target !== range) expect(melian(repo, ["review", target], env).status).toBe(1);
			const imported = melian(repo, ["compare", target, "--from", `file:${path}`], env);
			const external = /^ {2}([0-9a-f]{16}) {2}codex/m.exec(imported.stdout)![1]!;
			expect(
				melian(
					repo,
					[
						"compare",
						"adjudicate",
						target,
						external,
						"--verdict",
						"valid",
						"--reason",
						"no-owner",
						"--rule",
						"null-dereference",
					],
					env,
				).status,
			).toBe(0);
		}
		for (const filter of [[], ["--last", "1"], ["--since", "2099-01-01"]]) {
			expect(melian(repo, ["compare", "stats", ...filter], env).stdout).toMatch(
				/^Candidate check: rule:null-dereference, seen on 2 changesets \(.+\)\.$/m,
			);
		}
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

	it.each([
		[["compare", "stats", "--since", "2026-01-01", "--last", "1"], "--since or --last, not both"],
		[["compare", "stats", range], "compare stats takes no target"],
		[["compare", "backlog", range], "compare backlog takes no target"],
	])("refuses %j", (args, message) => {
		expect(melian(root, args)).toMatchObject({ status: 64, stderr: expect.stringContaining(message) });
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
		expect(stdout.stdout).toMatch(/^## A\. codex, round range-[0-9a-f]{16}\.r1$/m);
		expect(stdout.stdout).toMatch(/^## B\. Melian review, round range-[0-9a-f]{16}\.r1$/m);
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

describe("melian compare misses", { timeout: 60_000 }, () => {
	it("writes each valid miss as a misses file, and names each one it cannot place at its compared head", () => {
		const { repo, files, env } = reviewed();
		const path = join(files, "claude.json");
		writeFileSync(
			path,
			JSON.stringify({
				reviewer: { name: "claude-code" },
				findings: [
					{ file: "src/user.ts", line: 2, title: "Unchecked token", body: "b" },
					{ file: "src/user.ts", line: 400, title: "Past the end", body: "b" },
					{ file: "src/org-chart.ts", line: 2, title: "Unchanged file", body: "b" },
					{ title: "No line", body: "b" },
				],
			}),
		);
		expect(melian(repo, ["compare", range, "--from", `file:${path}`], env).status).toBe(0);
		const stored = Object.values(
			JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons,
		)[0] as {
			base: string;
			head: string;
			external: Record<string, { title: string }>;
		};
		const idOf = (title: string) => Object.entries(stored.external).find(([, each]) => each.title === title)![0];
		const [missed, past, unchanged, unplaced] = ["Unchecked token", "Past the end", "Unchanged file", "No line"].map(
			idOf,
		);
		for (const id of [missed, past, unchanged, unplaced])
			expect(
				melian(repo, ["compare", "adjudicate", range, id!, "--verdict", "valid", "--reason", "owned-missed"], env)
					.status,
			).toBe(0);
		const output = join(files, "misses.json");
		const result = melian(repo, ["compare", "misses", range, "--out", output, "--reason", "owned-missed"], env);
		const changeset = /^range-[0-9a-f]{16}/.exec(
			Object.keys(JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons)[0]!,
		)![0];
		expect(result).toMatchObject({ status: 0, stdout: `Exported 1 miss to ${output}.\n` });
		expect(result.stderr.split("\n").sort()).toEqual(
			[
				"",
				`Not exported: ${changeset}-${past} lines 400-400 run past src/user.ts, which has 9 lines at ${stored.head}.`,
				`Not exported: ${changeset}-${unchanged} src/org-chart.ts is not among the files ${stored.base}...${stored.head} changes.`,
				`Not exported: ${changeset}-${unplaced} names no file and line.`,
			].sort(),
		);
		expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
			{
				name: `${changeset}-${missed}`,
				repo: realpathSync(repo),
				base: stored.base,
				head: stored.head,
				file: "src/user.ts",
				lines: [2, 2],
			},
		]);
	});

	it("warns of the misses it left out only once the file is written", () => {
		const { repo, files, env } = reviewed();
		const path = join(files, "claude.json");
		writeFileSync(
			path,
			JSON.stringify({
				reviewer: { name: "claude-code" },
				findings: [
					{ file: "src/user.ts", line: 2, title: "Unchecked token", body: "b" },
					{ file: "src/user.ts", line: 400, title: "Past the end", body: "b" },
				],
			}),
		);
		expect(melian(repo, ["compare", range, "--from", `file:${path}`], env).status).toBe(0);
		const stored = Object.values(
			JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons,
		)[0] as { external: Record<string, unknown> };
		for (const id of Object.keys(stored.external))
			expect(
				melian(repo, ["compare", "adjudicate", range, id, "--verdict", "valid", "--reason", "owned-missed"], env)
					.status,
			).toBe(0);
		const output = join(files, "absent", "misses.json");

		const result = melian(repo, ["compare", "misses", range, "--out", output, "--reason", "owned-missed"], env);

		expect(result.status).not.toBe(0);
		expect(result.stderr).not.toContain("Not exported");
		expect(existsSync(output)).toBe(false);
	});

	it("writes a miss on a file's last line and names one a line past it, with or without a closing newline", () => {
		const { repo, files, env } = checkout();
		writeFileSync(join(repo, "src", "ends.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
		writeFileSync(join(repo, "src", "tail.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;");
		git(repo, "add", "src/ends.ts", "src/tail.ts");
		git(repo, "commit", "--quiet", "-m", "add a file with a closing newline and one without");
		expect(melian(repo, ["review", range], env).status).toBe(1);
		const path = join(files, "claude.json");
		writeFileSync(
			path,
			JSON.stringify({
				reviewer: { name: "claude-code" },
				findings: [
					{ file: "src/ends.ts", line: 3, title: "Last line", body: "b" },
					{ file: "src/ends.ts", line: 4, title: "One past the end", body: "b" },
					{ file: "src/tail.ts", line: 3, title: "Last line, no newline", body: "b" },
					{ file: "src/tail.ts", line: 4, title: "One past, no newline", body: "b" },
				],
			}),
		);
		expect(melian(repo, ["compare", range, "--from", `file:${path}`], env).status).toBe(0);
		const exported = () =>
			Object.values(JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons)[0] as {
				base: string;
				head: string;
				external: Record<string, { title: string }>;
			};
		const stored = exported();
		const idOf = (title: string) => Object.entries(stored.external).find(([, each]) => each.title === title)![0];
		const [last, past, tail, tailPast] = [
			"Last line",
			"One past the end",
			"Last line, no newline",
			"One past, no newline",
		].map(idOf);
		for (const id of [last, past, tail, tailPast])
			expect(
				melian(repo, ["compare", "adjudicate", range, id!, "--verdict", "valid", "--reason", "owned-missed"], env)
					.status,
			).toBe(0);
		const output = join(files, "misses.json");
		const result = melian(repo, ["compare", "misses", range, "--out", output, "--reason", "owned-missed"], env);
		const changeset = /^range-[0-9a-f]{16}/.exec(
			Object.keys(JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons)[0]!,
		)![0];
		expect(result).toMatchObject({ status: 0, stdout: `Exported 2 misses to ${output}.\n` });
		expect(result.stderr.split("\n").sort()).toEqual(
			[
				"",
				`Not exported: ${changeset}-${past} lines 4-4 run past src/ends.ts, which has 3 lines at ${stored.head}.`,
				`Not exported: ${changeset}-${tailPast} lines 4-4 run past src/tail.ts, which has 3 lines at ${stored.head}.`,
			].sort(),
		);
		const place = (name: string, file: string, line: number) => ({
			name: `${changeset}-${name}`,
			repo: realpathSync(repo),
			base: stored.base,
			head: stored.head,
			file,
			lines: [line, line],
		});
		expect(
			(JSON.parse(readFileSync(output, "utf8")) as { name: string }[]).sort((a, b) => a.name.localeCompare(b.name)),
		).toEqual(
			[place(last!, "src/ends.ts", 3), place(tail!, "src/tail.ts", 3)].sort((a, b) => a.name.localeCompare(b.name)),
		);
	});

	it("writes the miss it can place beside misses on a deleted file, a symlink and a binary file, and names each of those", () => {
		const { repo, files, env } = checkout();
		git(repo, "rm", "--quiet", "src/org-chart.ts");
		symlinkSync("user.ts", join(repo, "src", "link.ts"));
		writeFileSync(join(repo, "src", "blob.bin"), "a\0b\n");
		git(repo, "add", "src/link.ts", "src/blob.bin");
		git(repo, "commit", "--quiet", "-m", "delete a file, add a symlink and a binary file");
		expect(melian(repo, ["review", range], env).status).toBe(0);
		const path = join(files, "claude.json");
		writeFileSync(
			path,
			JSON.stringify({
				reviewer: { name: "claude-code" },
				findings: [
					{ file: "src/user.ts", line: 2, title: "Placed", body: "b" },
					{ file: "src/org-chart.ts", line: 1, title: "Deleted", body: "b" },
					{ file: "src/link.ts", line: 1, title: "Symlink", body: "b" },
					{ file: "src/blob.bin", line: 1, title: "Binary", body: "b" },
				],
			}),
		);
		expect(melian(repo, ["compare", range, "--from", `file:${path}`], env).status).toBe(0);
		const stored = Object.values(
			JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons,
		)[0] as { base: string; head: string; external: Record<string, { title: string }> };
		const idOf = (title: string) => Object.entries(stored.external).find(([, each]) => each.title === title)![0];
		const [placed, deleted, link, binary] = ["Placed", "Deleted", "Symlink", "Binary"].map(idOf);
		for (const id of [placed, deleted, link, binary])
			expect(
				melian(repo, ["compare", "adjudicate", range, id!, "--verdict", "valid", "--reason", "owned-missed"], env)
					.status,
			).toBe(0);
		const output = join(files, "misses.json");

		const result = melian(repo, ["compare", "misses", range, "--out", output, "--reason", "owned-missed"], env);

		const changeset = /^range-[0-9a-f]{16}/.exec(
			Object.keys(JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons)[0]!,
		)![0];
		expect(result).toMatchObject({ status: 0, stdout: `Exported 1 miss to ${output}.\n` });
		expect(result.stderr.split("\n").sort()).toEqual(
			[
				"",
				`Not exported: ${changeset}-${deleted} src/org-chart.ts does not exist at ${stored.head}.`,
				`Not exported: ${changeset}-${link} src/link.ts is a symbolic link at ${stored.head}.`,
				`Not exported: ${changeset}-${binary} src/blob.bin is binary at ${stored.head}.`,
			].sort(),
		);
		expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
			{
				name: `${changeset}-${placed}`,
				repo: realpathSync(repo),
				base: stored.base,
				head: stored.head,
				file: "src/user.ts",
				lines: [2, 2],
			},
		]);
	});

	it("names a miss on the line a lens's read of a long file cuts, and writes the line before it", () => {
		const { repo, files, env } = checkout();
		writeFileSync(join(repo, "src", "long.txt"), `x\n${"a".repeat(9 * 1024 * 1024)}`);
		git(repo, "add", "src/long.txt");
		git(repo, "commit", "--quiet", "-m", "add a file longer than a lens reads");
		expect(melian(repo, ["review", range], env).status).toBe(1);
		const path = join(files, "claude.json");
		writeFileSync(
			path,
			JSON.stringify({
				reviewer: { name: "claude-code" },
				findings: [
					{ file: "src/long.txt", line: 1, title: "Whole line", body: "b" },
					{ file: "src/long.txt", line: 2, title: "Cut line", body: "b" },
				],
			}),
		);
		expect(melian(repo, ["compare", range, "--from", `file:${path}`], env).status).toBe(0);
		const stored = Object.values(
			JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons,
		)[0] as { base: string; head: string; external: Record<string, { title: string }> };
		const idOf = (title: string) => Object.entries(stored.external).find(([, each]) => each.title === title)![0];
		const [whole, cut] = ["Whole line", "Cut line"].map(idOf);
		for (const id of [whole, cut])
			expect(
				melian(repo, ["compare", "adjudicate", range, id!, "--verdict", "valid", "--reason", "owned-missed"], env)
					.status,
			).toBe(0);
		const output = join(files, "misses.json");

		const result = melian(repo, ["compare", "misses", range, "--out", output, "--reason", "owned-missed"], env);

		const changeset = /^range-[0-9a-f]{16}/.exec(
			Object.keys(JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons)[0]!,
		)![0];
		expect(result).toMatchObject({
			status: 0,
			stdout: `Exported 1 miss to ${output}.\n`,
			stderr: `Not exported: ${changeset}-${cut} a lens reads only the first 1 lines of src/long.txt at ${stored.head}.\n`,
		});
		expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
			{
				name: `${changeset}-${whole}`,
				repo: realpathSync(repo),
				base: stored.base,
				head: stored.head,
				file: "src/long.txt",
				lines: [1, 1],
			},
		]);
	});

	it("writes nothing when no valid miss remains", () => {
		const { repo, files, env } = reviewed();
		const path = codexFile(files, [codexFinding(400, "Unchecked token")]);
		expect(melian(repo, ["compare", range, "--from", `file:${path}`], env).status).toBe(0);
		const output = join(files, "misses.json");
		expect(melian(repo, ["compare", "misses", range, "--out", output], env)).toMatchObject({
			status: 1,
			stderr: expect.stringContaining(`no valid miss of ${range} ruled needs-execution names its lines`),
		});
		expect(existsSync(output)).toBe(false);
	});

	it("writes the misses of the reasons --reason names, needs-execution by default, and refuses any other", () => {
		const { repo, files, env } = reviewed();
		const path = join(files, "claude.json");
		writeFileSync(
			path,
			JSON.stringify({
				reviewer: { name: "claude-code" },
				findings: [
					{ file: "src/user.ts", line: 2, title: "Owned", body: "b" },
					{ file: "src/user.ts", line: 3, title: "Runs", body: "b" },
				],
			}),
		);
		expect(melian(repo, ["compare", range, "--from", `file:${path}`], env).status).toBe(0);
		const stored = Object.values(
			JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons,
		)[0] as { external: Record<string, { title: string }> };
		const idOf = (title: string) => Object.entries(stored.external).find(([, each]) => each.title === title)![0];
		const [owned, runs] = ["Owned", "Runs"].map(idOf);
		for (const [id, reason] of [
			[owned, "owned-missed"],
			[runs, "needs-execution"],
		])
			expect(
				melian(repo, ["compare", "adjudicate", range, id!, "--verdict", "valid", "--reason", reason!], env).status,
			).toBe(0);
		const output = join(files, "misses.json");
		const names = (...reasons: string[]) => {
			const result = melian(
				repo,
				["compare", "misses", range, "--out", output, ...reasons.flatMap((reason) => ["--reason", reason])],
				env,
			);
			expect(result.status).toBe(0);
			return (JSON.parse(readFileSync(output, "utf8")) as { name: string }[]).map(({ name }) => name.slice(-16));
		};

		expect(names()).toEqual([runs]);
		expect(names("owned-missed")).toEqual([owned]);
		expect(names("owned-missed", "needs-execution").sort()).toEqual([owned, runs].sort());
		for (const [reason, why] of [
			["out-of-scope", "no lens owed"],
			["typo", "owned-missed, no-owner or needs-execution"],
		])
			expect(melian(repo, ["compare", "misses", range, "--reason", reason!], env)).toMatchObject({
				status: 64,
				stderr: expect.stringContaining(why!),
			});
	});

	it("refuses --json", () => {
		expect(melian(root, ["compare", "misses", range, "--json"])).toMatchObject({
			status: 64,
			stderr: expect.stringContaining("compare misses always writes JSON"),
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
		const earlier = Object.keys(
			JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons,
		)[0]!;
		const cleared = melian(
			repo,
			["compare", "adjudicate", range, id, "--verdict", "noise", "--golden", "none", "--round", earlier],
			env,
		);
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
		for (const golden of ["correctness", "none"])
			expect(
				melian(repo, ["compare", "adjudicate", range, id, "--verdict", "noise", "--golden", golden], env),
			).toMatchObject({ status: 0, stdout: expect.not.stringContaining("Warning") });
		for (const verdict of ["noise", "valid"]) {
			const refused = melian(
				repo,
				["compare", "adjudicate", range, id, "--verdict", verdict, "--reason", "no-owner"],
				env,
			);
			expect(refused).toMatchObject({ status: 1, stderr: expect.stringContaining("only to a valid external") });
		}
	});

	it("records a judgement when a lens file cannot be read", () => {
		const { repo, env, id } = reviewed();
		expect(melian(repo, ["compare", range], env).status).toBe(0);
		mkdirSync(join(repo, ".melian/lenses/broken"), { recursive: true });
		writeFileSync(join(repo, ".melian/lenses/broken/LENS.md"), "no front matter here\n");
		const result = melian(repo, ["compare", "adjudicate", range, id, "--verdict", "noise", "--golden", "other"], env);
		expect(result).toMatchObject({
			status: 0,
			stdout: expect.stringContaining("Warning: could not read lenses:"),
		});
		expect(result.stdout).toContain(`Adjudicated ${id} as noise`);
	});

	it("adjudicates a stored-round finding after the head moved without a new review", () => {
		const { repo, files, env, id } = reviewed();
		const path = codexFile(files, [codexFinding(8, "Null manager")]);
		expect(melian(repo, ["compare", range, "--from", `file:${path}`], env).status).toBe(0);
		git(repo, "commit", "--quiet", "--allow-empty", "-m", "next revision");
		expect(melian(repo, ["findings", range], env).status).toBe(1);
		const earlier = Object.keys(
			JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout).comparisons,
		)[0]!;
		const result = melian(repo, ["compare", "adjudicate", range, id, "--verdict", "valid", "--round", earlier], env);
		expect(result).toMatchObject({ status: 0, stderr: "" });
		const json = JSON.parse(melian(repo, ["compare", "export", range, "--json"], env).stdout) as {
			comparisons: Record<string, { adjudications?: Record<string, { current: { verdict: string } }> }>;
		};
		expect(
			Object.values(json.comparisons).find((round) => round.adjudications?.[id] !== undefined)?.adjudications?.[id]
				?.current.verdict,
		).toBe("valid");
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

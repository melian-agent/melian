import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderFindingsTerminal, type Verdict } from "@melian-agent/core";
import { buildGoldenRepository, type Golden, loadGoldens } from "@melian-agent/evals";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = join(root, "packages/cli/bin/melian.js");
const goldens = Object.fromEntries(loadGoldens().map((golden) => [golden.name, golden]));

const gitEnv = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Melian Test",
	GIT_AUTHOR_EMAIL: "test@melian.invalid",
	GIT_COMMITTER_NAME: "Melian Test",
	GIT_COMMITTER_EMAIL: "test@melian.invalid",
};

let scratch: string;
const repos: string[] = [];

beforeAll(() => {
	// The test runs the built binary, as a user would, so it builds the CLI and what it imports first.
	execFileSync("npx", ["tsc", "-b", "packages/cli/tsconfig.build.json"], { cwd: root, stdio: "pipe" });
}, 120_000);

afterEach(() => {
	for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
	if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

function melian(cwd: string, args: string[], env: Record<string, string> = {}) {
	const result = spawnSync(process.execPath, [bin, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...gitEnv, NO_COLOR: "1", ...env },
		timeout: 60_000,
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// A golden's repository, checked out on its feature branch, and a script the CLI's scripted mode answers lenses from.
function goldenCheckout(golden: Golden, script: unknown = golden.script) {
	const { repo } = buildGoldenRepository(golden);
	repos.push(repo);
	scratch = mkdtempSync(join(tmpdir(), "melian-cli-"));
	const scriptPath = join(scratch, "script.json");
	writeFileSync(scriptPath, JSON.stringify(script));
	return { repo, env: { MELIAN_TEST_SCRIPT: scriptPath } };
}

describe("melian review and findings", { timeout: 60_000 }, () => {
	it("exits 0 for a review that passed, and prints the terminal rendering of its verdict", () => {
		const { repo, env } = goldenCheckout(goldens["clean-rename"]!);

		const review = melian(repo, ["review", "main"], env);

		expect(review).toMatchObject({ status: 0, stderr: "" });
		const stored = melian(repo, ["findings", "main", "--json"], env);
		expect(stored.status).toBe(0);
		const verdict = JSON.parse(stored.stdout) as Verdict;
		expect(verdict.status).toBe("passed");
		expect(review.stdout).toBe(renderFindingsTerminal(verdict));
		expect(review.stdout).toMatch(/^Verdict: passed\n/);
	});

	it("exits 1 for a blocking finding, and findings prints what review printed", () => {
		const { repo, env } = goldenCheckout(goldens["correctness-null-deref"]!);

		const review = melian(repo, ["review", "main"], env);

		expect(review.status).toBe(1);
		expect(review.stdout).toMatch(/^Verdict: findings, blocking\n/);
		expect(review.stdout).toContain("null-dereference");
		expect(melian(repo, ["findings", "main"], env)).toMatchObject({ status: 0, stdout: review.stdout });
		const open = melian(repo, ["findings", "main", "--open", "--json"], env);
		const log = JSON.parse(open.stdout) as { runs: { results: { ruleId: string }[] }[] };
		expect(log.runs[0]!.results.map((result) => result.ruleId)).toEqual(["null-dereference"]);
	});

	it("exits 3 for findings with nothing blocking", () => {
		const golden = goldens["correctness-null-deref"]!;
		const script = JSON.parse(JSON.stringify(golden.script).replace('"severity":"P1"', '"severity":"P2"'));
		const { repo, env } = goldenCheckout(golden, script);

		const review = melian(repo, ["review", "main"], env);

		expect(review.status).toBe(3);
		expect(review.stdout).toMatch(/^Verdict: findings\n/);
	});

	it("exits 2 when a lens does not finish, naming it", () => {
		const golden = goldens["correctness-null-deref"]!;
		const { repo, env } = goldenCheckout(golden, { correctness: golden.script.correctness });

		const review = melian(repo, ["review", "main"], env);

		expect(review.status).toBe(2);
		expect(review.stdout).toMatch(/^Verdict: not reviewed, blocking\n/);
		expect(review.stdout).toContain("lens.contracts  failed");
		expect(review.stderr).toContain("lenses did not finish: contracts");
	});

	it("tells the author to review first when nothing is stored", () => {
		const { repo, env } = goldenCheckout(goldens["clean-rename"]!);

		expect(melian(repo, ["findings", "main"], env)).toMatchObject({
			status: 1,
			stderr: expect.stringContaining("run melian review main"),
		});
	});
});

describe("melian doctor", () => {
	it("checks the tools and names where credentials come from, never their values", () => {
		const token = "test-token-never-printed";
		const home = mkdtempSync(join(tmpdir(), "melian-doctor-"));
		scratch = home;

		const doctor = melian(root, ["doctor"], { GITHUB_TOKEN: token, PI_CODING_AGENT_DIR: home });

		expect(doctor.status).toBe(0);
		expect(doctor.stdout).toMatch(/^ok {4}node {8}\d+\.\d+\.\d+; Melian needs 22\.19\.0 or later$/m);
		expect(doctor.stdout).toMatch(/^ok {4}git {9}\d+\.\d+(\.\d+)?, --attr-source supported$/m);
		expect(doctor.stdout).toContain(`${join(home, "auth.json")} not found`);
		expect(doctor.stdout).toMatch(/^ok {4}github {6}token from GITHUB_TOKEN$/m);
		expect(doctor.stdout).not.toContain(token);
		expect(readFileSync(bin, "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
	});
});

describe("melian's command line", () => {
	it("refuses to publish a range", () => {
		const result = melian(root, ["publish", "main"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Melian never posts a review of a range");
	});

	it("prints usage to stderr and exits 64 without a command, and to stdout with --help", () => {
		expect(melian(root, [])).toMatchObject({
			status: 64,
			stdout: "",
			stderr: expect.stringMatching(/^Usage: melian/),
		});
		expect(melian(root, ["--help"])).toMatchObject({ status: 0, stdout: expect.stringMatching(/^Usage: melian/) });
	});

	it("exits 64 for a command it does not know", () => {
		expect(melian(root, ["reveiw", "main"])).toMatchObject({
			status: 64,
			stderr: expect.stringContaining("unknown command reveiw"),
		});
	});
});

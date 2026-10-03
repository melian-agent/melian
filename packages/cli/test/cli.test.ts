import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The goldens have no tsconfig.json, so tsc cannot check them, and Biome's defaults would add findings of their own.
// Their tests keep the deterministic checks to guardrails; the static tools have a repository of their own below.
const guardrailsOnly = "tiers:\n  fast: [guardrails]\n";

function scriptFile(script: unknown): Record<string, string> {
	scratch = mkdtempSync(join(tmpdir(), "melian-cli-"));
	const scriptPath = join(scratch, "script.json");
	writeFileSync(scriptPath, JSON.stringify(script));
	return { MELIAN_TEST_SCRIPT: scriptPath };
}

// A golden's repository, checked out on its feature branch, and a script the CLI's scripted mode answers lenses from.
// Its uncommitted melian.yaml, unless policy is null, applies to a range on the checked-out commit.
function goldenCheckout(golden: Golden, script: unknown = golden.script, policy: string | null = guardrailsOnly) {
	const { repo } = buildGoldenRepository(golden);
	repos.push(repo);
	if (policy !== null) writeFileSync(join(repo, "melian.yaml"), policy);
	return { repo, env: scriptFile(script) };
}

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, env: { ...process.env, ...gitEnv }, encoding: "utf8" }).trim();
}

const tsconfig = JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext" },
});

// A TypeScript repository under the default tiers, whose feature branch adds `added`, checked out on that branch.
function staticCheckout(added: string) {
	const repo = mkdtempSync(join(tmpdir(), "melian-cli-static-"));
	repos.push(repo);
	git(repo, "init", "--quiet", "--initial-branch=main");
	writeFileSync(join(repo, "tsconfig.json"), tsconfig);
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src/a.ts"), "export const a: number = 1;\n");
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "-m", "base");
	git(repo, "checkout", "--quiet", "-b", "feature");
	writeFileSync(join(repo, "src/b.ts"), added);
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "-m", "head");
	const quiet = [{ text: "Reported 0 findings." }];
	return { repo, env: scriptFile({ correctness: quiet, contracts: quiet }) };
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

	it("runs a failed lens again with --rerun, and reports the stored failure without it", () => {
		const golden = goldens["correctness-null-deref"]!;
		const { repo, env } = goldenCheckout(golden, { correctness: golden.script.correctness });
		expect(melian(repo, ["review", "main"], env).status).toBe(2);
		writeFileSync(env.MELIAN_TEST_SCRIPT, JSON.stringify(golden.script));

		expect(melian(repo, ["review", "main"], env).status).toBe(2);
		const rerun = melian(repo, ["review", "main", "--rerun"], env);

		expect(rerun.status).toBe(1);
		expect(rerun.stdout).toMatch(/^Verdict: findings, blocking\n/);
	});

	it("runs guardrails, Biome, and tsc before the lenses, and passes a clean change", { timeout: 120_000 }, () => {
		const { repo, env } = staticCheckout("export const b: number = 2;\n");

		const review = melian(repo, ["review", "main"], env);

		expect(review).toMatchObject({ status: 0, stderr: "" });
		const verdict = JSON.parse(melian(repo, ["findings", "main", "--json"], env).stdout) as Verdict;
		expect(verdict.notRun.map((check) => check.name)).toEqual(["decisions.fast"]);
	});

	it("reports what Biome finds in the head", { timeout: 120_000 }, () => {
		const { repo, env } = staticCheckout("export const b = (x: number) => x == 1;\n");

		const review = melian(repo, ["review", "main"], env);

		expect(review.status).toBe(3);
		expect(review.stdout).toMatch(/^Verdict: findings\n/);
		expect(review.stdout).toContain("biome/suspicious/noDoubleEquals");
	});

	it("tells the author to review first when nothing is stored", () => {
		const { repo, env } = goldenCheckout(goldens["clean-rename"]!);

		expect(melian(repo, ["findings", "main"], env)).toMatchObject({
			status: 1,
			stderr: expect.stringContaining("run melian review main"),
		});
		// Every command a message suggests can be pasted into a shell as it stands.
		expect(melian(repo, ["findings", "main~0"], env)).toMatchObject({
			status: 1,
			stderr: expect.stringContaining('run melian review "main~0"'),
		});
		expect(melian(repo, ["findings", "#5"], env)).toMatchObject({
			status: 1,
			stderr: expect.stringContaining('run melian review "#5" first'),
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
		// This checkout has its own install, so the static checks use its Biome and tsc.
		expect(doctor.stdout).toMatch(/^ok {4}static {6}biome from the checkout, tsc from the checkout$/m);
		expect(doctor.stdout).not.toContain(token);
		expect(readFileSync(bin, "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
		// The test runs this checkout's own binary, so the code under review would be its reviewer.
		expect(doctor.stdout).toContain(
			`warn  melian      ${bin}, inside this checkout, so the change can alter its reviewer`,
		);
	});

	it("warns when melian.yaml routes no tier, names the routes when it does, and runs Melian's own Biome and tsc without an install", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);

		const unrouted = melian(repo, ["doctor"]);
		writeFileSync(join(repo, "melian.yaml"), "models:\n  heavy:\n    model: anthropic/claude-opus-5-5\n");
		const routed = melian(repo, ["doctor"]);
		writeFileSync(join(repo, "melian.local.yaml"), "models:\n  heavy:\n    model: amazon-bedrock/claude-opus\n");
		const local = melian(repo, ["doctor"]);

		expect(unrouted.stdout).toMatch(
			/^warn {2}routes {6}no tier is routed to a model; .*melian\.local\.yaml.*--model/m,
		);
		expect(routed.stdout).toMatch(/^ok {4}routes {6}heavy to anthropic\/claude-opus-5-5$/m);
		expect(local.stdout).toMatch(/^ok {4}routes {6}heavy to amazon-bedrock\/claude-opus$/m);
		expect(routed.stdout).toMatch(/^ok {4}static {6}biome from Melian's own copy, tsc from Melian's own copy$/m);
		expect(routed.stdout).toMatch(/^ok {4}melian {6}.*, outside this checkout$/m);
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

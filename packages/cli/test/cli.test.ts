import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Decider,
	type DecisionRequest,
	findingId,
	Rendering,
	type StoredVerdict,
	standardsLimits,
	Verdict,
} from "@melian-agent/core";
import { buildGoldenRepository, type Golden, loadGoldens } from "@melian-agent/evals";
import * as pipelineTesting from "@melian-agent/pipeline/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { review as reviewIn } from "../src/commands.ts";
import { doctor as doctorIn } from "../src/doctor.ts";

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

// An empty configuration directory, so no test reads the developer's own ~/.config/melian.
const noUserFiles = mkdtempSync(join(tmpdir(), "melian-xdg-"));

afterEach(() => {
	vi.restoreAllMocks();
	for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
	if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

afterAll(() => rmSync(noUserFiles, { recursive: true, force: true }));

function melian(cwd: string, args: string[], env: Record<string, string> = {}) {
	const result = spawnSync(process.execPath, [bin, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...gitEnv, NO_COLOR: "1", XDG_CONFIG_HOME: noUserFiles, ...env },
		timeout: 60_000,
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// The goldens have no tsconfig.json, so tsc cannot check them, and Biome's defaults would add findings of their own.
// Their tests keep the deterministic checks to guardrails; the static tools have a repository of their own below.
const guardrailsOnly = "tiers:\n  fast: [guardrails]\n";

// Every lens the default full tier runs, so a script can answer each.
const builtinLenses = ["correctness", "contracts", "trust-boundary", "removed-behaviour", "tests", "conventions"];

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

// A configuration directory holding the user's own secrets file, `secrets`, readable by its owner alone.
function userDirectory(secrets: string): { XDG_CONFIG_HOME: string } {
	const directory = mkdtempSync(join(tmpdir(), "melian-xdg-"));
	repos.push(directory);
	mkdirSync(join(directory, "melian"));
	writeFileSync(join(directory, "melian/secrets.yaml"), secrets, { mode: 0o600 });
	return { XDG_CONFIG_HOME: directory };
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
	return { repo, env: scriptFile(Object.fromEntries(builtinLenses.map((name) => [name, quiet]))) };
}

const verifierWarnings =
	"melian: Plan: lenses verify, but the verifier tier routes no model of its own; verification falls back to lens tiers, heavy then medium then light\nmelian: Plan: every verification candidate would be judged by its finder's own family\n";

describe("melian review and findings", { timeout: 60_000 }, () => {
	it("triages through the decider the host hands it, and records the decision the lenses ran under", async () => {
		const { repo, env } = goldenCheckout(goldens["clean-rename"]!);
		const requests: DecisionRequest[] = [];
		const decider: Decider = {
			name: "test-decider",
			calibrated: false,
			decide: async (request) => {
				requests.push(request);
				return {
					answers: request.questions.map(({ id }) => ({ question: id, distribution: { quick: 1 } })),
				};
			},
		};
		const out: string[] = [];
		const io = {
			cwd: repo,
			env: { ...process.env, ...gitEnv, NO_COLOR: "1", XDG_CONFIG_HOME: noUserFiles, ...env },
			stdout: (text: string) => void out.push(text),
			stderr: () => undefined,
			color: false,
			decide: async () => ({ decider, model: "test-model" }),
		};

		await reviewIn(io, "main", { rerun: false });

		expect(requests).toHaveLength(1);
		expect(requests[0]!.questionSet.name).toBe("triage");
		expect(requests[0]!.questions.map(({ id }) => id).sort()).toEqual([...builtinLenses].sort());
		const stored = melian(repo, ["findings", "main", "--json"], env);
		expect(stored.stdout.match(/"level": "quick"/g)).toHaveLength(builtinLenses.length);
	});

	it("reads committed nested standards despite uncommitted checkout-only imports", async () => {
		const { repo, env } = staticCheckout("export const b = 2;\n");
		writeFileSync(join(repo, "src/AGENTS.md"), "COMMITTED_HEAD_STANDARD\n");
		git(repo, "add", "src/AGENTS.md");
		git(repo, "commit", "--quiet", "-m", "head standards");
		writeFileSync(join(repo, "src/AGENTS.md"), "UNCOMMITTED_STANDARD\n@checkout-only.md\n");
		writeFileSync(join(repo, "src/checkout-only.md"), "CHECKOUT_ONLY_IMPORT\n");
		writeFileSync(join(repo, "melian.yaml"), "tiers:\n  full: [lens.correctness]\n");
		const capture = vi.spyOn(pipelineTesting, "scriptLenses");
		const code = await reviewIn(
			{
				cwd: repo,
				env: { ...process.env, ...gitEnv, XDG_CONFIG_HOME: noUserFiles, ...env },
				stdout: () => undefined,
				stderr: () => undefined,
				color: false,
			},
			"main",
			{ rerun: false },
		);
		expect(code).toBe(0);
		const requests = capture.mock.results[0]!.value as ReturnType<typeof pipelineTesting.scriptLenses>;
		const prompts = Object.values(requests).flat().map(pipelineTesting.systemPromptOf);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("COMMITTED_HEAD_STANDARD");
		expect(prompts[0]).not.toContain("UNCOMMITTED_STANDARD");
		expect(prompts[0]).not.toContain("CHECKOUT_ONLY_IMPORT");
	});

	it("reads base nested standards and imports when the range head is not checked out", async () => {
		const { repo, env } = staticCheckout("export const b = 2;\n");
		git(repo, "checkout", "--quiet", "main");
		writeFileSync(join(repo, "melian.yaml"), "tiers:\n  full: [lens.correctness]\n");
		writeFileSync(join(repo, "src/AGENTS.md"), "BASE_STANDARD\n@rules.md\n");
		writeFileSync(join(repo, "src/rules.md"), "BASE_IMPORT\n");
		git(repo, "add", "--all");
		git(repo, "commit", "--quiet", "-m", "base standards");
		git(repo, "checkout", "--quiet", "-b", "standards-head");
		writeFileSync(join(repo, "src/AGENTS.md"), "HEAD_STANDARD\n@rules.md\n");
		writeFileSync(join(repo, "src/rules.md"), "HEAD_IMPORT\n");
		writeFileSync(join(repo, "src/b.ts"), "export const b = 2;\n");
		git(repo, "add", "--all");
		git(repo, "commit", "--quiet", "-m", "head standards");
		git(repo, "checkout", "--quiet", "main");
		writeFileSync(join(repo, "src/AGENTS.md"), "CHECKOUT_STANDARD\n@rules.md\n");
		writeFileSync(join(repo, "src/rules.md"), "CHECKOUT_IMPORT\n");
		const capture = vi.spyOn(pipelineTesting, "scriptLenses");
		const code = await reviewIn(
			{
				cwd: repo,
				env: { ...process.env, ...gitEnv, XDG_CONFIG_HOME: noUserFiles, ...env },
				stdout: () => undefined,
				stderr: () => undefined,
				color: false,
			},
			"main...standards-head",
			{ rerun: false },
		);
		expect(code).toBe(0);
		const requests = capture.mock.results[0]!.value as ReturnType<typeof pipelineTesting.scriptLenses>;
		const prompts = Object.values(requests).flat().map(pipelineTesting.systemPromptOf);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("BASE_STANDARD");
		expect(prompts[0]).toContain("BASE_IMPORT");
		for (const excluded of ["HEAD_STANDARD", "HEAD_IMPORT", "CHECKOUT_STANDARD", "CHECKOUT_IMPORT"])
			expect(prompts[0]).not.toContain(excluded);
	});

	it.each([
		["\u0007", "\\u0007"],
		["\u001b[2J", "\\u001b[2J"],
	])("renders standards error paths containing %j as visible text", (control, escaped) => {
		const { repo, env } = staticCheckout("export const b = 2;\n");
		const directory = `unsafe${control}`;
		mkdirSync(join(repo, directory, ".melian/standards"), { recursive: true });
		for (let i = 0; i < 5; i++) {
			writeFileSync(join(repo, directory, `.melian/standards/${i}.md`), "x".repeat(220 * 1024));
		}
		git(repo, "add", "--all");
		git(repo, "commit", "--quiet", "-m", "nested standards exceed the chain bound");

		const result = melian(repo, ["review", "main"], env);

		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("exceed 1048576 bytes");
		expect(result.stderr).toContain(`unsafe${escaped}`);
		expect(result.stderr).not.toContain(control);
	});

	it("exits 0 for a review that passed, and prints the terminal rendering of its verdict", () => {
		const { repo, env } = goldenCheckout(goldens["clean-rename"]!);

		const review = melian(repo, ["review", "main"], env);

		expect(review).toMatchObject({ status: 0, stderr: verifierWarnings });
		const stored = melian(repo, ["findings", "main", "--json"], env);
		expect(stored.status).toBe(0);
		const verdict = Verdict.from(JSON.parse(stored.stdout) as StoredVerdict);
		expect(verdict.status).toBe("passed");
		expect(review.stdout).toBe(verdict.render(new Rendering({ ids: true })));
		expect(review.stdout).toMatch(/^Verdict: passed\n/);
	});

	it("refuses a decision provider it has no adapter for, saying how to triage without one (issue #24)", () => {
		const { repo, env } = goldenCheckout(
			goldens["clean-rename"]!,
			undefined,
			`${guardrailsOnly}decisions:\n  provider: clef\n`,
		);

		const review = melian(repo, ["review", "main"], env);

		expect(review.status).toBe(2);
		expect(review.stderr).toBe(
			"melian: melian.yaml sets decisions.provider to clef, and Melian has no adapter for a decision provider until milestone 4; remove the key, and triage runs on the LLM fallback\n",
		);
		expect(review.stdout).toBe("");
		expect(existsSync(join(repo, ".git/melian"))).toBe(false);
	});

	it("records each lens the scripted model ran off the committed route, and says so before the verdict", () => {
		const opus = "    model: anthropic/claude-opus-5-5\n";
		const { repo, env } = goldenCheckout(
			goldens["clean-rename"]!,
			undefined,
			`${guardrailsOnly}models:\n  heavy:\n${opus}`,
		);

		const review = melian(repo, ["review", "main"], env);

		expect(review.status).toBe(0);
		expect(review.stderr).toBe(
			"melian: Plan: heavy runs faux/scripted, set by --model; the committed route wants anthropic/claude-opus-5-5, and does not accept faux/scripted\n" +
				verifierWarnings,
		);
		expect(review.stdout).toContain("left the committed routes:\n  lens.");
		const stored = Verdict.from(
			JSON.parse(melian(repo, ["findings", "main", "--json"], env).stdout) as StoredVerdict,
		);
		expect(stored.ran?.find((check) => check.name === "lens.correctness")?.lineage).toEqual({
			model: "faux/scripted",
			wanted: "anthropic/claude-opus-5-5",
			by: "--model",
			outside: true,
		});
	});

	const unreviewedLenses = builtinLenses.map((name) => `  ${name}: { paths: ["nothing/**"] }`).join("\n");
	const namedPolicy = `${guardrailsOnly}lenses:\n${unreviewedLenses}\nmodels:\n  heavy:\n    model: openai/gpt-5.5\n`;

	it("does not run a named credential's command when no lens covers the change", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, namedPolicy);
		const runs = join(repo, ".git", "runs");
		const xdg = userDirectory(
			[
				"credentials:",
				`  vault: { provider: openai, command: "echo run >> ${runs}; echo sk-COMMAND-SENTINEL" }`,
				"  pinned: { provider: anthropic, key: sk-LITERAL-SENTINEL }",
				"",
			].join("\n"),
		);

		const review = melian(repo, ["review", "main"], xdg);

		expect(review.status).toBe(0);
		expect(existsSync(runs)).toBe(false);
		for (const output of [review.stdout, review.stderr]) expect(output).not.toMatch(/SENTINEL/);
	});

	it("ignores an unused failing credential command and prints none of its output", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, namedPolicy);
		const xdg = userDirectory(
			'credentials:\n  vault: { provider: openai, command: "echo sk-COMMAND-SENTINEL; exit 3" }\n',
		);

		const review = melian(repo, ["review", "main"], xdg);

		expect(review.status).toBe(0);
		expect(review.stderr).toBe(verifierWarnings);
		expect(review.stdout).not.toContain("SENTINEL");
	});

	it("layers the user's own config.yaml over melian.yaml for a range on the checked-out commit", () => {
		const golden = goldens["correctness-null-deref"]!;
		const { repo, env } = goldenCheckout(golden);
		const xdg = userDirectory("credentials: {}\n");
		const plain = melian(repo, ["review", "main"], { ...env, ...xdg });
		// A preference that lowers what the review's one P1 finding requires turns a blocking verdict into one that is not.
		writeFileSync(join(xdg.XDG_CONFIG_HOME, "melian/config.yaml"), "resolution:\n  P1: advisory\n");
		const preferred = melian(repo, ["review", "main", "--rerun"], { ...env, ...xdg });

		expect(plain.status).toBe(1);
		expect(preferred.status).toBe(3);
	});

	it("findings prints the plan the review stored, not one resolved now", () => {
		const opus = "    model: anthropic/claude-opus-5-5\n";
		const { repo, env } = goldenCheckout(
			goldens["clean-rename"]!,
			undefined,
			`${guardrailsOnly}models:\n  heavy:\n${opus}`,
		);
		const review = melian(repo, ["review", "main"], env);
		// The routes change after the review; findings still tells what the review ran under.
		writeFileSync(join(repo, "melian.yaml"), guardrailsOnly);

		const findings = melian(repo, ["findings", "main"], env);

		expect(findings.status).toBe(0);
		expect(findings.stderr).toBe(review.stderr);
		expect(findings.stderr).toContain("melian: Plan: heavy runs faux/scripted, set by --model");
		expect(melian(repo, ["findings", "main", "--json"], env).stderr).toBe("");
	});

	it("fails every lens closed, exiting 2, where policy refuses a route outside accept", () => {
		const route = "  heavy:\n    model: anthropic/claude-opus-5-5\n    acceptOverridden: false\n";
		const { repo, env } = goldenCheckout(goldens["clean-rename"]!, undefined, `${guardrailsOnly}models:\n${route}`);

		const review = melian(repo, ["review", "main"], env);

		expect(review.status).toBe(2);
		expect(review.stdout).toMatch(/^Verdict: not reviewed\n/);
		expect(review.stdout).toContain(
			"lens.correctness  failed at careful: models.heavy.acceptOverridden is false, and --model puts it on faux/scripted, which models.heavy.accept does not list",
		);
		expect(review.stderr).toContain("melian: Plan: heavy, for ");
	});

	it("exits 1 for a blocking finding, and findings adds its agent prompt", () => {
		const { repo, env } = goldenCheckout(goldens["correctness-null-deref"]!);

		const review = melian(repo, ["review", "main"], env);

		expect(review.status).toBe(1);
		expect(review.stdout).toMatch(/^Verdict: findings, blocking\n/);
		expect(review.stdout).toContain("null-dereference");
		const storedVerdict = Verdict.from(
			JSON.parse(melian(repo, ["findings", "main", "--json"], env).stdout) as StoredVerdict,
		);
		const nonce = (text: string) => text.replace(/quoted-[0-9a-f]{24}/g, "quoted-NONCE");
		const found = melian(repo, ["findings", "main"], env);
		expect(found.status).toBe(0);
		expect(nonce(found.stdout)).toBe(nonce(review.stdout + storedVerdict.agentPrompt("main")));
		const openText = melian(repo, ["findings", "main", "--open"], env);
		expect(openText.status).toBe(0);
		expect(openText.stdout).toContain("null-dereference");
		expect(nonce(openText.stdout).endsWith(nonce(storedVerdict.agentPrompt("main")))).toBe(true);
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

	it("loads a folder's lens for a file the change moves out of that folder, and runs it", () => {
		const repo = mkdtempSync(join(tmpdir(), "melian-cli-rename-"));
		repos.push(repo);
		git(repo, "init", "--quiet", "--initial-branch=main");
		mkdirSync(join(repo, "services/pay/.melian/lenses/pay"), { recursive: true });
		writeFileSync(
			join(repo, "services/pay/.melian/lenses/pay/LENS.md"),
			[
				"---",
				"name: pay",
				"description: The payment service's own checks.",
				"tier: medium",
				"rules:",
				"  - id: lost-charge",
				"    description: A charge is lost.",
				"---",
				"You are the payments reviewer.",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(repo, "services/pay/charge.ts"),
			"// Charges a card.\nexport const charge = (cents: number) => cents;\n",
		);
		git(repo, "add", "--all");
		git(repo, "commit", "--quiet", "-m", "base");
		git(repo, "checkout", "--quiet", "-b", "feature");
		mkdirSync(join(repo, "lib"));
		git(repo, "mv", "services/pay/charge.ts", "lib/charge.ts");
		git(repo, "commit", "--quiet", "-m", "move the charge out of the service");
		writeFileSync(join(repo, "melian.yaml"), `${guardrailsOnly}  full: [fast, lens.pay]\n`);

		const review = melian(repo, ["review", "main"], scriptFile({ pay: [{ text: "Reported 0 findings." }] }));

		expect(review).toMatchObject({ status: 0, stderr: verifierWarnings });
		expect(review.stdout).toContain("lens.pay  careful");
	});

	it("runs guardrails, Biome, and tsc before the lenses, and passes a clean change", { timeout: 120_000 }, () => {
		const { repo, env } = staticCheckout("export const b: number = 2;\n");

		const review = melian(repo, ["review", "main"], env);

		expect(review).toMatchObject({ status: 0, stderr: verifierWarnings });
		const verdict = JSON.parse(melian(repo, ["findings", "main", "--json"], env).stdout) as StoredVerdict;
		expect(verdict.notRun.map((check) => check.name)).toEqual(["decisions.fast"]);
	});

	it("runs a failed deterministic check again with --rerun, and reports the stored failure without it", {
		timeout: 120_000,
	}, () => {
		const { repo, env } = staticCheckout("export const b: number = 2;\n");
		const tsc = join(repo, "node_modules/.bin/tsc");
		mkdirSync(dirname(tsc), { recursive: true });
		writeFileSync(
			tsc,
			'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\necho segfault\nexit 139\n',
			{ mode: 0o755 },
		);
		const first = melian(repo, ["review", "main"], env);
		expect(first.stdout).toContain("static.tsc  failed");
		rmSync(join(repo, "node_modules"), { recursive: true, force: true });

		const stored = melian(repo, ["review", "main"], env);
		const rerun = melian(repo, ["review", "main", "--rerun"], env);

		expect(stored.status).toBe(first.status);
		expect(stored.stdout).toContain("static.tsc  failed");
		expect(rerun.stdout).not.toContain("static.tsc  failed");
		expect(rerun.status).toBe(0);
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

describe("melian dismiss", { timeout: 60_000 }, () => {
	const reason = "The manager is always set for users in this report.";

	// A reviewed golden whose one blocking finding is the null dereference, and that finding's ID. The range names its
	// branch, so another worktree, where HEAD names something else, names the same changeset.
	const range = "main...feature";
	function reviewedNullDeref() {
		const { repo, env } = goldenCheckout(goldens["correctness-null-deref"]!);
		expect(melian(repo, ["review", range], env).status).toBe(1);
		const stored = JSON.parse(melian(repo, ["findings", range, "--json"], env).stdout) as StoredVerdict;
		const id = stored.findings.block[0]!.properties.id;
		return { repo, env, id };
	}

	it("records a dismissal from any worktree of the clone, and the verdict, findings, and a rerun count it out", () => {
		const { repo, env, id } = reviewedNullDeref();
		// The storage sits in the git common directory, so a second worktree of the clone shares it.
		const worktree = mkdtempSync(join(tmpdir(), "melian-cli-worktree-"));
		rmSync(worktree, { recursive: true });
		repos.push(worktree);
		git(repo, "worktree", "add", "--quiet", "--detach", worktree, "HEAD");

		const dismissed = melian(worktree, ["dismiss", range, id, "--reason", reason], env);

		expect(dismissed).toMatchObject({ status: 0, stderr: "" });
		expect(dismissed.stdout).toBe(
			`Dismissed null-dereference in src/user.ts line 7 (${id}) as Melian Test <test@melian.invalid>.\nVerdict now: passed.\n`,
		);
		const findings = melian(repo, ["findings", range], env);
		expect(findings.stdout).toMatch(/^Verdict: passed\n/);
		expect(findings.stdout).toContain("1 dismissed finding not shown.");
		expect(findings.stdout).not.toContain(reason);
		const all = melian(repo, ["findings", range, "--all"], env);
		expect(all.stdout).toContain("Dismissed: 1 finding");
		expect(all.stdout).toMatch(
			new RegExp(
				`\\(introduced, dismissed, block, confirmed\\)  ${id}\\n    Verified:[^\\n]+\\n    Dismissed by Melian Test <test@melian\\.invalid> at \\d{4}-[^:]+:\\d\\d:[^:]+: ${reason}\\n`,
			),
		);
		const verdict = JSON.parse(melian(repo, ["findings", range, "--json"], env).stdout) as StoredVerdict;
		expect(verdict.dismissed[0]!.properties.dismissal).toMatchObject({
			by: "Melian Test <test@melian.invalid>",
			reason,
		});
		const rerun = melian(repo, ["review", range], env);
		expect(rerun.status).toBe(0);
		expect(rerun.stdout).not.toContain("verifier  ran");
		expect(melian(repo, ["findings", range], env).stdout).toBe(
			rerun.stdout + Verdict.from(verdict).agentPrompt(range),
		);
		expect(JSON.parse(melian(repo, ["findings", range, "--json"], env).stdout)).toEqual({
			...verdict,
			ran: verdict.ran?.filter((check) => check.name !== "verifier"),
		});
	});

	it("updates the reason of a finding dismissed again and keeps the first", () => {
		const { repo, env, id } = reviewedNullDeref();
		melian(repo, ["dismiss", range, id, "--reason", reason], env);

		const again = melian(repo, ["dismiss", range, id, "--reason", "Covered by the caller's check."], env);

		expect(again.status).toBe(0);
		expect(again.stdout).toContain(`Updated the dismissal of null-dereference in src/user.ts line 7 (${id})`);
		expect(again.stdout).toContain(`It was dismissed by Melian Test <test@melian.invalid>: ${reason}\n`);
		const all = melian(repo, ["findings", range, "--all"], env).stdout;
		expect(all).toContain(": Covered by the caller's check.\n");
		expect(all).toMatch(
			new RegExp(`Earlier dismissal, replaced at [^,]+, by Melian Test <test@melian\\.invalid> at [^ ]+: ${reason}`),
		);
	});

	// The null dereference golden, with the contracts lens reporting the same lines under a rule of its own, so
	// adjudication merges the two reports as one defect that correctness speaks for.
	function reviewedMerged() {
		const golden = goldens["correctness-null-deref"]!;
		const script = golden.script as { correctness: { calls?: { name: string; arguments: object }[] }[] };
		const call = script.correctness
			.flatMap((step) => step.calls ?? [])
			.find((each) => each.name === "report_finding")!;
		const changedReturn = { ...call, arguments: { ...call.arguments, rule: "changed-return", severity: "P2" } };
		const contracts = [{ calls: [changedReturn] }, { text: "Reported 1 finding." }];
		const { repo, env } = goldenCheckout(golden, { ...script, contracts });
		const review = melian(repo, ["review", range], env);
		expect(review.status).toBe(1);
		const stored = JSON.parse(melian(repo, ["findings", range, "--json"], env).stdout) as StoredVerdict;
		const [speaker] = stored.findings.block;
		const [member] = speaker!.properties.alsoReportedAs!;
		return { repo, env, review, id: speaker!.properties.id, member: member!.id };
	}

	it("prints a finding's merged reports, and names each one dismissing the finding dismisses with it", () => {
		const { repo, env, review, id, member } = reviewedMerged();
		expect(review.stdout).toContain(
			`null-dereference  (introduced, new, block, confirmed)  ${id}\n    Merged report: P2 changed-return from lens.contracts  ${member}\n`,
		);

		const dismissed = melian(repo, ["dismiss", range, id, "--reason", reason], env);

		expect(dismissed).toMatchObject({ status: 0, stderr: "" });
		expect(dismissed.stdout).toBe(
			[
				`Dismissed null-dereference in src/user.ts line 7 (${id}) as Melian Test <test@melian.invalid>.`,
				"Also dismissed, as reports adjudication merged into it:",
				`  changed-return from lens.contracts (${member})`,
				"To dismiss one report alone, run melian dismiss with --only.",
				"Verdict now: passed.",
				"",
			].join("\n"),
		);
	});

	it("dismisses the one report --only names, and leaves the report merged with it live", () => {
		const { repo, env, id, member } = reviewedMerged();

		const dismissed = melian(repo, ["dismiss", range, id, "--only", "--reason", reason], env);

		expect(dismissed).toMatchObject({ status: 0, stderr: "" });
		expect(dismissed.stdout).not.toContain("Also dismissed");
		expect(dismissed.stdout).toContain("Verdict now: findings.\n");
		const verdict = JSON.parse(melian(repo, ["findings", range, "--json"], env).stdout) as StoredVerdict;
		expect(verdict.dismissed.map((each) => each.properties.id)).toEqual([id]);
		const live = Object.values(verdict.findings).flat();
		expect(live.map((each) => each.properties.id)).toEqual([member]);
		expect(melian(repo, ["findings", range], env).stdout).toContain(
			`changed-return  (introduced, new, acknowledge, confirmed)  ${member}\n    Also reported, dismissed: P1 null-dereference from lens.correctness  ${id}\n`,
		);
	});

	it("says in one line that git has no author to record as the dismisser", () => {
		const { repo, env, id } = reviewedNullDeref();
		const {
			GIT_AUTHOR_NAME: _,
			GIT_AUTHOR_EMAIL: __,
			...rest
		} = { ...process.env, ...gitEnv, NO_COLOR: "1", ...env };
		// Only an identity set in configuration counts, so git cannot guess one from the host.
		const strict = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" };

		const result = spawnSync(process.execPath, [bin, "dismiss", range, id, "--reason", reason], {
			cwd: repo,
			encoding: "utf8",
			env: { ...rest, ...strict },
			timeout: 60_000,
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toBe(
			"melian: Melian records who dismissed a finding as the git author, and git has none: git var failed: Author identity unknown; set user.name and user.email\n",
		);
	});

	it("exits 1 when the review or the finding is not found", () => {
		const { repo, env } = goldenCheckout(goldens["correctness-null-deref"]!);
		expect(melian(repo, ["dismiss", "main", "0123456789abcdef", "--reason", reason], env)).toMatchObject({
			status: 1,
			stderr: expect.stringContaining("run melian review main"),
		});
		expect(melian(repo, ["review", "main"], env).status).toBe(1);
		expect(melian(repo, ["dismiss", "main", "0123456789abcdef", "--reason", reason], env)).toMatchObject({
			status: 1,
			stderr: expect.stringContaining("has no finding 0123456789abcdef; melian findings main --all lists them"),
		});
	});

	it.each([
		["no reason", ["dismiss", "main", "0123456789abcdef"], "dismiss needs --reason <text>"],
		["a blank reason", ["dismiss", "main", "0123456789abcdef", "--reason", "  "], "a dismissal needs a reason"],
		["an overlong reason", ["dismiss", "main", "0123456789abcdef", "--reason", "x".repeat(1001)], "the most is 1000"],
		["a malformed ID", ["dismiss", "main", "null-dereference", "--reason", reason], "is not a finding ID"],
		["no ID", ["dismiss", "main", "--reason", reason], "dismiss takes a range or pull request and a finding ID"],
		["findings with --open and --all", ["findings", "main", "--open", "--all"], "--open or --all, not both"],
	])("exits 64 for %s", (_, args, message) => {
		expect(melian(root, args)).toMatchObject({ status: 64, stderr: expect.stringContaining(message) });
	});
});

describe("melian doctor", { timeout: 60_000 }, () => {
	it("checks the tools and names where credentials come from, never their values", async () => {
		const token = "test-token-never-printed";
		const home = mkdtempSync(join(tmpdir(), "melian-doctor-"));
		scratch = home;

		const state = pullRequestState();
		state.owner = "melian-agent";
		state.repo = "melian";
		let stdout = "";
		const status = await doctorIn(
			{
				cwd: root,
				env: {
					...process.env,
					...gitEnv,
					XDG_CONFIG_HOME: noUserFiles,
					GITHUB_TOKEN: token,
					PI_CODING_AGENT_DIR: home,
					MELIAN_STATE_DIR: join(home, "state"),
				},
				stdout: (text) => {
					stdout += text;
				},
				stderr: () => {},
				color: false,
				executable: bin,
			},
			{ fetch: fakeGitHub(state) },
		);
		const doctor = { status, stdout };

		expect(doctor.status, doctor.stdout).toBe(0);
		expect(doctor.stdout).toMatch(/^ok {4}node {8}\d+\.\d+\.\d+; Melian needs 22\.19\.0 or later$/m);
		expect(doctor.stdout).toMatch(/^ok {4}git {9}\d+\.\d+(\.\d+)?, --attr-source supported$/m);
		expect(doctor.stdout).toContain(`${join(home, "auth.json")} not found`);
		expect(doctor.stdout).toMatch(/^ok {4}github {6}token from GITHUB_TOKEN$/m);
		// This checkout has its own install, so the static checks use its Biome and tsc.
		expect(doctor.stdout).toMatch(/^ok {4}static {6}biome from the checkout, tsc from the checkout$/m);
		expect(doctor.stdout).toMatch(/^ok {4}levels {6}each lens's levels cost more from quick to deep$/m);
		expect(doctor.stdout).not.toContain(token);
		expect(readFileSync(bin, "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
		// The test runs this checkout's own binary, so the code under review would be its reviewer.
		expect(doctor.stdout).toContain(
			`warn  melian      ${bin}, inside this checkout, so the change can alter its reviewer`,
		);
	});

	it("lists nested standards carriers and their total bytes", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		const files = {
			"AGENTS.md": "root\n",
			"src/CLAUDE.md": "@AGENTS.md\n",
			"src/.melian/standards/style.md": "style\n",
		};
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(join(repo, path, ".."), { recursive: true });
			writeFileSync(join(repo, path), text);
		}
		const doctor = melian(repo, ["doctor"]);
		expect(doctor.stdout).toContain(
			"ok    standards   3 files, 22 bytes; AGENTS.md, src/.melian/standards/style.md, src/CLAUDE.md",
		);
	});

	it("warns for oversized nested standards and skipped symlinks", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		writeFileSync(join(repo, "src/AGENTS.md"), "x".repeat(standardsLimits.fileBytes + 1));
		symlinkSync("AGENTS.md", join(repo, "src/CLAUDE.md"));
		const doctor = melian(repo, ["doctor"]);
		expect(doctor.status).toBe(0);
		expect(doctor.stdout).toContain(
			`warn  standards   1 file, ${standardsLimits.fileBytes + 1} bytes; src/AGENTS.md (over 256 KiB), src/CLAUDE.md (symlink skipped); 1 over 256 KiB; 1 symlink skipped`,
		);
	});

	it("counts omitted regular standards separately from skipped symlinks", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		for (let index = 0; index < 12; index++) {
			const directory = join(repo, `p${String(index).padStart(2, "0")}`);
			mkdirSync(directory);
			writeFileSync(join(directory, "AGENTS.md"), "x");
		}
		symlinkSync("AGENTS.md", join(repo, "p10/CLAUDE.md"));
		const doctor = melian(repo, ["doctor"]);
		const line = doctor.stdout.split("\n").find((line) => line.startsWith("warn  standards"))!;
		expect(line).toContain("12 files, 12 bytes");
		expect(line).toMatch(/, and 2 more files, 1 more skipped symlink; 1 symlink skipped$/);
		expect(line).not.toContain("and 3 more");
	});

	it("limits the standards path list to ten entries", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		for (let index = 0; index < 12; index++) {
			mkdirSync(join(repo, `p${String(index).padStart(2, "0")}`));
			writeFileSync(join(repo, `p${String(index).padStart(2, "0")}/AGENTS.md`), "x");
		}
		const doctor = melian(repo, ["doctor"]);
		const line = doctor.stdout.split("\n").find((line) => line.startsWith("ok    standards"))!;
		expect(line).toContain("12 files, 12 bytes");
		expect(line).toContain("p09/AGENTS.md, and 2 more");
		expect(line).not.toContain("p10/AGENTS.md");
	});

	it("warns when an extending lens's top-level tier or budget leaves a level cheaper than the one below it", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		mkdirSync(join(repo, ".melian/lenses/correctness"), { recursive: true });
		writeFileSync(
			join(repo, ".melian/lenses/correctness/LENS.md"),
			"---\nname: correctness\nextends: correctness\ntier: light\nbudget: { tokens: 500k }\n---\n",
		);

		const doctor = melian(repo, ["doctor"]);

		expect(doctor.stdout).toContain(
			"warn  levels      correctness: careful runs on light, below quick's medium; deep allows 400,000 tokens, fewer than careful's 500,000; set the level's own tier or budget",
		);
	});

	it("reports a decision provider as its own failing line and still prints the plan", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		writeFileSync(
			join(repo, "melian.yaml"),
			"decisions:\n  provider: clef\nmodels:\n  light:\n    model: anthropic/claude-haiku-4-5\n",
		);

		// A literal key in the user's own secrets file, so the light tier resolves whatever credentials this machine holds.
		const xdg = userDirectory(
			"credentials:\n  test-anthropic: { provider: anthropic, key: sk-ant-test-never-printed }\n",
		);

		const doctor = melian(repo, ["doctor"], xdg);

		expect(doctor.status).toBe(1);
		expect(doctor.stdout).toMatch(
			/^fail {2}decisions {3}melian\.yaml sets decisions\.provider to clef, and Melian has no adapter/m,
		);
		expect(doctor.stdout).toMatch(/^(ok|warn) {2,4}plan {8}light: /m);
	});

	it("prints the plan: each routed tier with its credential and file, each lens's levels, and every warning", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		// A literal key in the user's own secrets file, so the plan does not depend on this machine's credentials.
		const xdg = userDirectory(
			"credentials:\n  test-anthropic: { provider: anthropic, key: sk-ant-test-never-printed }\n",
		);
		const secrets = join(xdg.XDG_CONFIG_HOME, "melian/secrets.yaml");
		const preferences = join(xdg.XDG_CONFIG_HOME, "melian/config.yaml");
		const credential = `with test-anthropic in ${secrets}`;

		const unrouted = melian(repo, ["doctor"], xdg);
		// The built-in lenses all run on heavy, so a route for light alone still leaves every review unable to run them.
		writeFileSync(join(repo, "melian.yaml"), "models:\n  light:\n    model: anthropic/claude-haiku-4-5\n");
		const partly = melian(repo, ["doctor"], xdg);
		writeFileSync(join(repo, "melian.yaml"), "models:\n  heavy:\n    model: anthropic/claude-opus-5-5\n");
		const routed = melian(repo, ["doctor"], xdg);
		writeFileSync(preferences, "models:\n  heavy:\n    model: anthropic/claude-sonnet-5-5\n");
		const user = melian(repo, ["doctor"], xdg);
		writeFileSync(join(repo, "melian.local.yaml"), "models:\n  heavy:\n    model: nowhere/opus\n");
		const local = melian(repo, ["doctor"], xdg);

		const heavy = [...builtinLenses].sort();
		const lenses = `${heavy.slice(0, -1).join(", ")}, and ${heavy.at(-1)}`;
		const needHeavy = `no model for heavy, for ${lenses}; set models.heavy.model in melian.local.yaml, or pass --model to review`;
		expect(unrouted.stdout).toMatch(new RegExp(`^warn {2}plan {8}${needHeavy}$`, "m"));
		expect(unrouted.stdout).toMatch(new RegExp(`^ok {4}secrets {5}test-anthropic for anthropic in ${secrets}$`, "m"));
		expect(partly.stdout).toContain(
			`ok    plan        light: anthropic/claude-haiku-4-5 ${credential}; routed by melian.yaml\n`,
		);
		expect(partly.stdout).toMatch(new RegExp(`^warn {2}plan {8}${needHeavy}$`, "m"));
		expect(routed.stdout).toContain(
			`ok    plan        heavy: anthropic/claude-opus-5-5 ${credential}; routed by melian.yaml\n`,
		);
		expect(routed.stdout).toContain(
			`ok    plan        ${lenses}: quick on medium (no model), careful on heavy (anthropic/claude-opus-5-5), deep on heavy (anthropic/claude-opus-5-5)\n`,
		);
		expect(routed.stdout).toContain("verifier: anthropic/claude-opus-5-5 (claude); fallback from lens tiers");
		expect(user.stdout).toContain(
			`ok    plan        heavy: anthropic/claude-sonnet-5-5 ${credential}; routed by ${preferences}\n`,
		);
		expect(user.stdout).toContain(
			`warn  plan        heavy runs anthropic/claude-sonnet-5-5, set by ${preferences}; the committed route wants anthropic/claude-opus-5-5, and does not accept anthropic/claude-sonnet-5-5\n`,
		);
		// The per-clone file wins over the user's, and a route the maintainer chose is never swapped for another.
		expect(local.stdout).toMatch(
			/^warn {2}plan {8}heavy, for .*: none of nowhere\/opus has credentials; log in with pi, set the provider's API key, or add a credential to melian\.secrets\.yaml$/m,
		);
		for (const run of [unrouted, partly, routed, user, local]) expect(run.stdout).not.toContain("sk-ant-test");
		expect(routed.stdout).toMatch(/^ok {4}static {6}biome from Melian's own copy, tsc from Melian's own copy$/m);
		expect(routed.stdout).toMatch(/^ok {4}melian {6}.*, outside this checkout$/m);
	});

	it("leaves a disabled lens out of the plan", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		writeFileSync(join(repo, "melian.yaml"), "models:\n  heavy:\n    model: anthropic/claude-opus-5-5\n");
		const before = melian(repo, ["doctor"]);
		writeFileSync(
			join(repo, "melian.yaml"),
			"models:\n  heavy:\n    model: anthropic/claude-opus-5-5\nlenses:\n  correctness: { enabled: false }\n",
		);
		const after = melian(repo, ["doctor"]);

		expect(before.stdout).toMatch(/^ok {4}plan {8}.*\bcorrectness\b.*: quick on/m);
		expect(after.stdout).toMatch(/^ok {4}plan {8}.*: quick on/m);
		expect(after.stdout).not.toMatch(/^.{0,16}plan.*\bcorrectness\b/m);
	});

	it("names one or two lenses on an unrouted tier without a series comma", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);

		writeFileSync(join(repo, "melian.yaml"), "tiers:\n  full: [standard, lens.contracts]\n");
		const two = melian(repo, ["doctor"]);
		writeFileSync(join(repo, "melian.yaml"), "tiers:\n  full: [standard]\n");
		const one = melian(repo, ["doctor"]);

		expect(two.stdout).toMatch(/^warn {2}plan {8}no model for heavy, for contracts and correctness; /m);
		expect(one.stdout).toMatch(/^warn {2}plan {8}no model for heavy, for correctness; /m);
	});

	it("fails when git tracks a file only a maintainer may hold, and refuses to read credentials from it", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		writeFileSync(
			join(repo, "melian.secrets.yaml"),
			"credentials:\n  a: { provider: openai, env: OPENAI_API_KEY }\n",
		);
		writeFileSync(join(repo, "melian.local.yaml"), "resolution:\n  P0: block\n");
		git(repo, "add", "--force", "melian.secrets.yaml", "melian.local.yaml");

		const doctor = melian(repo, ["doctor"]);

		expect(doctor.status).toBe(1);
		expect(doctor.stdout).toContain(
			"fail  secrets     git tracks melian.local.yaml, which is yours alone; run git rm --cached melian.local.yaml\n",
		);
		expect(doctor.stdout).toContain("fail  secrets     git tracks melian.secrets.yaml, which is yours alone");
		expect(doctor.stdout).toMatch(
			/^fail {2}secrets {5}.*git tracks melian\.secrets\.yaml, so it is the repository's/m,
		);
	});

	it("never prints a malformed secrets file's lines, in review or in doctor", () => {
		const { repo, env } = goldenCheckout(goldens["clean-rename"]!);
		const xdg = userDirectory("credentials:\n  a: { provider: openai, key: sk-SENTINEL-never-printed\n");

		const review = melian(repo, ["review", "main"], { ...env, ...xdg });
		const doctor = melian(repo, ["doctor"], xdg);

		expect(review.status).toBe(2);
		expect(review.stderr).toMatch(/secrets\.yaml: YAML error [A-Z_]+ at line \d+, column \d+\n/);
		expect(doctor.stdout).toMatch(
			/^fail {2}secrets {5}.*secrets\.yaml: YAML error [A-Z_]+ at line \d+, column \d+$/m,
		);
		for (const output of [review.stdout, review.stderr, doctor.stdout, doctor.stderr]) {
			expect(output).not.toContain("SENTINEL");
		}
	});

	it("prints no path git tracks beneath a directory named like a maintainer's file, escaped or not", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		writeFileSync(join(repo, "blob"), "x\n");
		const blob = git(repo, "hash-object", "-w", "blob");
		const forged = "melian.secrets.yaml/\u001b]0;pwned\u0007\nok    plan        heavy: routed by melian.yaml";
		git(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},${forged}`);

		const doctor = melian(repo, ["doctor"]);

		expect(doctor.stdout).not.toContain("\u001b");
		expect(doctor.stdout).not.toContain("pwned");
		expect(doctor.stdout).not.toMatch(/^ok {4}plan {8}heavy: routed by melian\.yaml$/m);
	});

	it("warns, in doctor and in review, of a secrets file others can read", () => {
		const { repo, env } = goldenCheckout(goldens["clean-rename"]!);
		const xdg = userDirectory("credentials:\n  pinned: { provider: openai, key: sk-test }\n");
		const secrets = join(xdg.XDG_CONFIG_HOME, "melian/secrets.yaml");
		chmodSync(secrets, 0o644);
		const warning = `${secrets} is readable by others (mode 644); chmod 600 ${secrets}`;

		const doctor = melian(repo, ["doctor"], xdg);
		const review = melian(repo, ["review", "main"], { ...env, ...xdg });

		expect(doctor.stdout).toContain(`warn  secrets     ${warning}\n`);
		expect(review.status).toBe(0);
		expect(review.stderr).toContain(`melian: ${warning}\n`);
	});

	it("plans a lens on the tier melian.yaml gives it", () => {
		// Were the committed tier lost, heavy's guard would refuse correctness on light, a model it does not accept.
		const heavy = "  heavy:\n    model: anthropic/claude-opus-5-5\n    acceptOverridden: false\n";
		const light = "  light:\n    model: anthropic/claude-haiku-4-5\n";
		const policy = `models:\n${heavy}${light}lenses:\n  correctness: { tier: light }\n`;
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, policy);
		const xdg = userDirectory("credentials:\n  pinned: { provider: anthropic, key: sk-ant-test }\n");

		const doctor = melian(repo, ["doctor"], xdg);

		expect(doctor.stdout).toContain(
			"ok    plan        correctness: quick on light (anthropic/claude-haiku-4-5), careful on light (anthropic/claude-haiku-4-5), deep on light (anthropic/claude-haiku-4-5)\n",
		);
		expect(doctor.stdout).not.toMatch(/^warn {2}plan {8}correctness/m);
	});

	it("names a command credential in the plan without running its command", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, "models:\n  heavy:\n    model: openai/gpt-5.5\n");
		const marker = join(repo, ".git", "ran");
		const xdg = userDirectory(
			`credentials:\n  vault: { provider: openai, command: "touch ${marker}; echo sk-key" }\n`,
		);
		const secrets = join(xdg.XDG_CONFIG_HOME, "melian/secrets.yaml");

		const doctor = melian(repo, ["doctor"], xdg);

		expect(doctor.stdout).toContain(
			`ok    plan        heavy: openai/gpt-5.5 with vault in ${secrets}; routed by melian.yaml\n`,
		);
		expect(existsSync(marker)).toBe(false);
	});

	it("prints an expired command bearer's source in doctor without running its command", () => {
		const { repo } = goldenCheckout(
			goldens["clean-rename"]!,
			{},
			"models:\n  heavy:\n    model: openai-codex/gpt-6.1-sol\n",
		);
		const marker = join(repo, ".git", "bearer-ran");
		const token = `e30.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
		const xdg = userDirectory(
			`credentials:\n  codex-login: { provider: openai-codex, command: "touch ${marker}; printf '${token}'" }\n`,
		);
		const secrets = join(xdg.XDG_CONFIG_HOME, "melian/secrets.yaml");
		const doctor = melian(repo, ["doctor"], { ...xdg, PI_CODING_AGENT_DIR: repo });
		expect(doctor.status).toBe(0);
		expect(doctor.stdout).toContain(`codex-login for openai-codex in ${secrets}`);
		expect(doctor.stdout).toContain(
			`ok    plan        heavy: openai-codex/gpt-6.1-sol with codex-login in ${secrets}; routed by melian.yaml\n`,
		);
		expect(existsSync(marker)).toBe(false);
		expect(doctor.stdout).not.toContain(token);
	});

	it("fails, naming the credential, for a secrets file whose provider the catalogue does not know", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		const xdg = userDirectory("credentials:\n  typo: { provider: antropic, env: ANTHROPIC_API_KEY }\n");
		const secrets = join(xdg.XDG_CONFIG_HOME, "melian/secrets.yaml");

		const doctor = melian(repo, ["doctor"], xdg);

		expect(doctor.status).toBe(1);
		expect(doctor.stdout).toContain(
			`fail  models      credential typo in ${secrets} names the provider antropic, which Melian's model catalogue does not know\n`,
		);
	});

	it("fails when git tracks a maintainer's file under another case of its name", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);
		writeFileSync(join(repo, "melian.secrets.yaml"), "credentials: {}\n");
		// A head's MELIAN.SECRETS.YAML, which a case-insensitive filesystem opens under the lower-case name.
		const blob = git(repo, "hash-object", "-w", "melian.secrets.yaml");
		git(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},MELIAN.SECRETS.YAML`);

		const doctor = melian(repo, ["doctor"]);

		expect(doctor.status).toBe(1);
		expect(doctor.stdout).toContain("fail  secrets     git tracks MELIAN.SECRETS.YAML, which is yours alone");
	});
});

describe("Melian's state directory", { timeout: 60_000 }, () => {
	const sqliteFiles = (directory: string): string[] =>
		readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".sqlite"));

	it("keeps storage under MELIAN_STATE_DIR, in a directory per clone, when it is set", () => {
		const { repo, env } = goldenCheckout(goldens["clean-rename"]!);
		const state = mkdtempSync(join(tmpdir(), "melian-state-"));
		repos.push(state);

		const review = melian(repo, ["review", "main"], { ...env, MELIAN_STATE_DIR: state });

		expect(review.status).toBe(0);
		expect(sqliteFiles(state)).toEqual([expect.stringMatching(/^[0-9a-f]{16}\/scripted\/[^/]+\.sqlite$/)]);
		expect(sqliteFiles(join(repo, ".git"))).toEqual([]);
		expect(melian(repo, ["findings", "main"], { ...env, MELIAN_STATE_DIR: state })).toMatchObject({
			status: 0,
			stdout:
				review.stdout +
				Verdict.from(
					JSON.parse(
						melian(repo, ["findings", "main", "--json"], { ...env, MELIAN_STATE_DIR: state }).stdout,
					) as StoredVerdict,
				).agentPrompt("main"),
		});
	});

	// A sandbox that keeps .git read-only looks like this to Melian. Root writes anywhere, so the test means nothing there.
	it.skipIf(process.getuid?.() === 0)(
		"names the directory and MELIAN_STATE_DIR when it cannot write, and doctor warns",
		() => {
			const { repo, env } = goldenCheckout(goldens["clean-rename"]!);
			const state = mkdtempSync(join(tmpdir(), "melian-state-"));
			repos.push(state);
			chmodSync(state, 0o500);
			try {
				const review = melian(repo, ["review", "main"], { ...env, MELIAN_STATE_DIR: state });
				const doctor = melian(repo, ["doctor"], { MELIAN_STATE_DIR: state });

				expect(review.status).toBe(2);
				expect(review.stderr).toMatch(/Melian cannot write its storage at .*MELIAN_STATE_DIR/);
				expect(doctor.stdout).toMatch(/^warn {2}state {7}.* is not writable \(EACCES\); .*MELIAN_STATE_DIR/m);
			} finally {
				chmodSync(state, 0o700);
			}
		},
	);

	it.skipIf(process.getuid?.() === 0)("turns SQLite's refusal in a read-only .git/melian into the same advice", () => {
		const { repo, env } = goldenCheckout(goldens["clean-rename"]!);
		const scripted = join(repo, ".git/melian/scripted");
		mkdirSync(scripted, { recursive: true });
		chmodSync(scripted, 0o500);
		try {
			const review = melian(repo, ["review", "main"], env);

			expect(review.status).toBe(2);
			expect(review.stderr).toMatch(
				/Melian cannot write its storage at .*unable to open database file.*MELIAN_STATE_DIR/,
			);
		} finally {
			chmodSync(scripted, 0o700);
		}
	});

	it("reports the state directory as writable by default", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!);
		expect(melian(repo, ["doctor"]).stdout).toMatch(/^ok {4}state {7}.*\.git\/melian, writable$/m);
	});
});

describe("melian's command line", { timeout: 60_000 }, () => {
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

describe("scripted verification", { timeout: 60_000 }, () => {
	it("exits 2 when the verifier tier cannot run", () => {
		const { repo, env } = goldenCheckout(
			goldens["correctness-null-deref"]!,
			undefined,
			`${guardrailsOnly}models:\n  verifier:\n    model: faux/missing\n    unavailable: fail\n`,
		);
		const reviewed = melian(repo, ["review", "main"], env);
		expect(reviewed.status).toBe(2);
		expect(reviewed.stdout).toMatch(/^Verdict: not reviewed/);
		expect(reviewed.stdout).toContain("verifier  failed");
		expect(reviewed.stderr).toContain("the verifier did not judge every claim");
	});

	it("shows verification in JSON and corrections in text, with refutations behind all", () => {
		const golden = goldens["correctness-null-deref"]!;
		const id = findingId({
			file: "src/user.ts",
			rule: "null-dereference",
			snippet: "const manager = user.manager as User;\nreturn manager.name.trim();",
			occurrence: 0,
		});
		const { repo, env } = goldenCheckout(golden, {
			...golden.script,
			verifier: {
				[id]: {
					verdict: "refuted",
					reason: "The scripted guard prevents the failure.",
					correction: "Keep the guarded value.",
					evidence: [{ file: "src/user.ts", line: 7, role: "context" }],
				},
			},
		});
		const reviewed = melian(repo, ["review", "main"], env);
		expect(reviewed.status).toBe(0);
		expect(reviewed.stdout).toContain("1 refuted finding not shown.");
		const stored = JSON.parse(melian(repo, ["findings", "main", "--json"], env).stdout) as StoredVerdict;
		expect(stored.refuted?.[0]?.properties.verification?.verdict).toBe("refuted");
		expect(stored.ran?.some((check) => check.name === "verifier")).toBe(true);
		const all = melian(repo, ["findings", "main", "--all"], env);
		expect(all.stdout).toContain("Refuted: 1 finding");
		expect(all.stdout).toContain("Correction: Keep the guarded value.");
	});
});

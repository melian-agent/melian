import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Rendering, type StoredVerdict, Verdict } from "@melian-agent/core";
import { buildGoldenRepository, type Golden, loadGoldens } from "@melian-agent/evals";
import { afterEach, describe, expect, it } from "vitest";

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

describe("melian review and findings", { timeout: 60_000 }, () => {
	it("exits 0 for a review that passed, and prints the terminal rendering of its verdict", () => {
		const { repo, env } = goldenCheckout(goldens["clean-rename"]!);

		const review = melian(repo, ["review", "main"], env);

		expect(review).toMatchObject({ status: 0, stderr: "" });
		const stored = melian(repo, ["findings", "main", "--json"], env);
		expect(stored.status).toBe(0);
		const verdict = Verdict.from(JSON.parse(stored.stdout) as StoredVerdict);
		expect(verdict.status).toBe("passed");
		expect(review.stdout).toBe(verdict.render(new Rendering({ ids: true })));
		expect(review.stdout).toMatch(/^Verdict: passed\n/);
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
		expect(melian(repo, ["findings", "main"], env)).toMatchObject({
			status: 0,
			stdout: review.stdout + storedVerdict.agentPrompt("main"),
		});
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

		expect(review).toMatchObject({ status: 0, stderr: "" });
		expect(review.stdout).toContain("lens.pay  careful");
	});

	it("runs guardrails, Biome, and tsc before the lenses, and passes a clean change", { timeout: 120_000 }, () => {
		const { repo, env } = staticCheckout("export const b: number = 2;\n");

		const review = melian(repo, ["review", "main"], env);

		expect(review).toMatchObject({ status: 0, stderr: "" });
		const verdict = JSON.parse(melian(repo, ["findings", "main", "--json"], env).stdout) as StoredVerdict;
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
				`\\(introduced, dismissed, block\\)  ${id}\\n    Dismissed by Melian Test <test@melian\\.invalid> at \\d{4}-[^:]+:\\d\\d:[^:]+: ${reason}\\n`,
			),
		);
		const verdict = JSON.parse(melian(repo, ["findings", range, "--json"], env).stdout) as StoredVerdict;
		expect(verdict.dismissed[0]!.properties.dismissal).toMatchObject({
			by: "Melian Test <test@melian.invalid>",
			reason,
		});
		const rerun = melian(repo, ["review", range], env);
		expect(rerun).toMatchObject({
			status: 0,
			stdout: findings.stdout.replace(Verdict.from(verdict).agentPrompt(range), ""),
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
			`null-dereference  (introduced, new, block)  ${id}\n    Merged report: P2 changed-return from lens.contracts  ${member}\n`,
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
			`changed-return  (introduced, new, acknowledge)  ${member}\n    Also reported, dismissed: P1 null-dereference from lens.correctness  ${id}\n`,
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
		expect(doctor.stdout).toMatch(/^ok {4}levels {6}each lens's levels cost more from quick to deep$/m);
		expect(doctor.stdout).not.toContain(token);
		expect(readFileSync(bin, "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
		// The test runs this checkout's own binary, so the code under review would be its reviewer.
		expect(doctor.stdout).toContain(
			`warn  melian      ${bin}, inside this checkout, so the change can alter its reviewer`,
		);
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

	it("warns when melian.yaml routes no tier, names the routes when it does, and runs Melian's own Biome and tsc without an install", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);

		const unrouted = melian(repo, ["doctor"]);
		// The built-in lenses all run on heavy, so a route for light alone still leaves every review unable to run them.
		writeFileSync(join(repo, "melian.yaml"), "models:\n  light:\n    model: anthropic/claude-haiku\n");
		const partly = melian(repo, ["doctor"]);
		writeFileSync(join(repo, "melian.yaml"), "models:\n  heavy:\n    model: anthropic/claude-opus-5-5\n");
		const routed = melian(repo, ["doctor"]);
		writeFileSync(join(repo, "melian.local.yaml"), "models:\n  heavy:\n    model: amazon-bedrock/claude-opus\n");
		const local = melian(repo, ["doctor"]);

		const heavy = [...builtinLenses].sort();
		const needHeavy = `no model for heavy, for ${heavy.slice(0, -1).join(", ")}, and ${heavy.at(-1)}; `;
		expect(unrouted.stdout).toMatch(
			new RegExp(
				`^warn {2}routes {6}no tier is routed to a model; ${needHeavy}.*melian\\.local\\.yaml.*--model`,
				"m",
			),
		);
		expect(partly.stdout).toMatch(
			new RegExp(`^warn {2}routes {6}light to anthropic/claude-haiku; ${needHeavy}`, "m"),
		);
		expect(routed.stdout).toMatch(/^ok {4}routes {6}heavy to anthropic\/claude-opus-5-5$/m);
		expect(local.stdout).toMatch(/^ok {4}routes {6}heavy to amazon-bedrock\/claude-opus$/m);
		expect(routed.stdout).toMatch(/^ok {4}static {6}biome from Melian's own copy, tsc from Melian's own copy$/m);
		expect(routed.stdout).toMatch(/^ok {4}melian {6}.*, outside this checkout$/m);
	});

	it("names one or two lenses on an unrouted tier without a series comma", () => {
		const { repo } = goldenCheckout(goldens["clean-rename"]!, {}, null);

		writeFileSync(join(repo, "melian.yaml"), "tiers:\n  full: [standard, lens.contracts]\n");
		const two = melian(repo, ["doctor"]);
		writeFileSync(join(repo, "melian.yaml"), "tiers:\n  full: [standard]\n");
		const one = melian(repo, ["doctor"]);

		expect(two.stdout).toMatch(
			/^warn {2}routes {6}no tier is routed to a model; no model for heavy, for contracts and correctness; /m,
		);
		expect(one.stdout).toMatch(
			/^warn {2}routes {6}no tier is routed to a model; no model for heavy, for correctness; /m,
		);
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

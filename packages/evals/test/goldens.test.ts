import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Changeset,
	defaultConfig,
	evaluateGuardrails,
	Finding,
	loadConfig,
	Merge,
	type Severity,
	type Verification,
} from "@melian-agent/core";
import {
	buildGoldenRepository,
	type Golden,
	goldensDirectory,
	loadGoldens,
	runGolden,
	scoreCorpus,
	scoreGolden,
	scriptedMismatches,
	selectGoldens,
} from "@melian-agent/evals";
import * as testing from "@melian-agent/pipeline/testing";
import { describe, expect, it, vi } from "vitest";

const goldens = loadGoldens();

describe("the golden corpus", () => {
	it("holds the corpus", () => {
		expect(goldens.map((golden) => golden.name)).toEqual([
			"clean-rename",
			"contracts-breaking-signature",
			"conventions-bare-reference",
			"conventions-clean",
			"conventions-free-constructor",
			"conventions-free-domain-function",
			"conventions-injection",
			"conventions-missing-doc-update",
			"conventions-tsdoc-internal",
			"conventions-unpinned-action",
			"correctness-deleted-guard",
			"correctness-deleted-rethrow",
			"correctness-null-deref",
			"design-bound-on-wrong-measure",
			"design-bound-on-wrong-measure-clean",
			"design-clean",
			"design-decision-injection",
			"design-fail-open-default",
			"design-identity-missing-input",
			"design-injection",
			"design-resumed-identity",
			"design-resumed-identity-clean",
			"design-rewrites-its-own-decision",
			"design-single-slot-overwrite",
			"design-single-slot-overwrite-clean",
			"design-superseded-at-base-clean",
			"design-supersedes-its-own-decision",
			"design-terminology-change",
			"design-terminology-change-in-design",
			"design-trust-by-label",
			"design-trust-by-label-clean",
			"design-unshipped-artifact",
			"durability-attach-key",
			"durability-clean-upsert",
			"durability-injection",
			"durability-partial-handoff",
			"durability-replayed-append",
			"durability-resumed-publish",
			"durability-superseded-write",
			"guardrails-bare-issue-reference",
			"guardrails-overlong-sentence",
			"injection-in-comment",
			"pre-existing-beside-change",
			"removed-behaviour-clean-extract",
			"removed-behaviour-dropped-cleanup",
			"removed-behaviour-dropped-error-path",
			"removed-behaviour-dropped-guard",
			"removed-behaviour-injection",
			"removed-behaviour-moved-status",
			"tests-clean-covered",
			"tests-injection",
			"tests-teardown-asymmetry",
			"tests-untested-behaviour",
			"tests-vacuous-test",
			"tests-weakened-assertion",
			"trust-boundary-clean-build-config",
			"trust-boundary-clean-plugin",
			"trust-boundary-clean-summary",
			"trust-boundary-clean-test-runner",
			"trust-boundary-fail-open",
			"trust-boundary-injection",
			"trust-boundary-policy-from-head",
			"trust-boundary-secret-env",
			"trust-boundary-terminal-escape",
		]);
	});
});

describe("a golden's standards and policy", () => {
	it("supplies design-only base vocabulary to the scripted golden conversation", async () => {
		const scripted = vi.spyOn(testing, "scriptLenses");
		try {
			const golden = goldens.find((each) => each.name === "design-terminology-change-in-design")!;
			const run = await runGolden(golden, { kind: "scripted" });
			expect(run.toolMismatches).toEqual([]);
			expect(scoreGolden(golden, run.findings)).toMatchObject({ precision: 1, recall: 1 });
			const requests = scripted.mock.results[0]!.value as ReturnType<typeof testing.scriptLenses>;
			const prompts = Object.values(requests).flat().map(testing.systemPromptOf);
			const prompt = prompts.find((prompt) => prompt.includes("You are the design reviewer"))!;
			expect(prompt).toContain("## Design sections at base");
			expect(prompt).toContain("docs/design.md:2 — Writer trust");
			expect(prompt).not.toContain("docs/design.md:2 — Publisher eligibility");
		} finally {
			scripted.mockRestore();
		}
	}, 60_000);

	it("renders a nested base AGENTS.md into the scripted lens's instructions", async () => {
		const directory = mkdtempSync(join(tmpdir(), "melian-nested-standards-golden-"));
		const scripted = vi.spyOn(testing, "scriptLenses");
		try {
			const golden = goldens.find((each) => each.name === "clean-rename")!;
			const copy = join(directory, golden.name);
			cpSync(golden.directory, copy, { recursive: true });
			writeFileSync(join(copy, "base", "src/AGENTS.golden.md"), "# Base golden conventions\n");
			writeFileSync(join(copy, "head", "src/AGENTS.golden.md"), "# Head golden conventions\n");
			const run = await runGolden({ ...golden, directory: copy }, { kind: "scripted" });
			expect(run.toolMismatches).toEqual([]);
			const requests = scripted.mock.results[0]!.value as ReturnType<typeof testing.scriptLenses>;
			const instructions = Object.values(requests).flat().map(testing.systemPromptOf);
			expect(instructions.length).toBeGreaterThan(0);
			for (const prompt of instructions) {
				expect(prompt).toContain("### src/AGENTS.md\n\n# Base golden conventions");
				expect(prompt).not.toContain("# Head golden conventions");
			}
		} finally {
			scripted.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("are stored under inert names, so the repository the corpus sits in never reads them as its own", () => {
		const live = new Set(["AGENTS.md", "CLAUDE.md", "melian.yaml", "melian.local.yaml", "LENS.md"]);
		const entries = readdirSync(goldensDirectory, { recursive: true, withFileTypes: true });
		const named = entries.filter((entry) => live.has(entry.name));
		// The corpus's own melian.yaml is Melian's policy for the tree, not a golden's.
		expect(named.map((entry) => join(entry.parentPath, entry.name))).toEqual([join(goldensDirectory, "melian.yaml")]);
		// A .melian or .agents directory holds only a repository lens under its inert name: anything else beneath one,
		// such as a standards file, is read by Melian whatever its name.
		const homes = /(?:^|\/)\.(?:melian|agents)\/(.*)$/s;
		const beneath = entries
			.filter((entry) => entry.isFile())
			.map((entry) => relative(goldensDirectory, join(entry.parentPath, entry.name)).split(sep).join("/"))
			.flatMap((path) => homes.exec(path)?.[1] ?? []);
		expect(beneath.filter((path) => !/^lenses\/[a-z0-9-]+\/LENS\.golden\.md$/.test(path))).toEqual([]);
	});

	it("carry each repository lens as an exact copy of Melian's own, so a golden measures the lens Melian runs", () => {
		const melian = join(goldensDirectory, "../../..");
		const copies = readdirSync(goldensDirectory, { recursive: true, withFileTypes: true }).filter(
			(entry) => entry.name === "LENS.golden.md",
		);
		expect(copies.length).toBeGreaterThan(0);
		for (const copy of copies) {
			const original = readFileSync(join(melian, ".melian/lenses", basename(copy.parentPath), "LENS.md"), "utf8");
			expect(readFileSync(join(copy.parentPath, copy.name), "utf8"), join(copy.parentPath, copy.name)).toBe(
				original,
			);
		}
	});

	it("carry every repository lens of Melian's in a tree that carries any, so a golden never runs half the hand-offs", () => {
		const melian = join(goldensDirectory, "../../..");
		const own = readdirSync(join(melian, ".melian/lenses")).sort();
		expect(own).toEqual(expect.arrayContaining(["correctness", "durability", "removed-behaviour"]));
		const trees = new Map<string, string[]>();
		for (const copy of readdirSync(goldensDirectory, { recursive: true, withFileTypes: true })) {
			if (copy.name !== "LENS.golden.md") continue;
			const tree = join(copy.parentPath, "../../..");
			trees.set(tree, [...(trees.get(tree) ?? []), basename(copy.parentPath)]);
		}
		expect(trees.size).toBeGreaterThan(0);
		for (const [tree, names] of trees) expect(names.sort(), tree).toEqual(own);
	});

	it("carry Melian's own full tier, which keeps every check of the default full tier", async () => {
		const melian = join(goldensDirectory, "../../..");
		const fullTier = async (policy: string) => {
			const repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-goldens-tier-")));
			try {
				execFileSync("git", ["init", "--quiet"], { cwd: repo });
				writeFileSync(join(repo, "melian.yaml"), policy);
				return (await loadConfig(repo, { kind: "worktree" }, ".")).config.tiers.full;
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		};
		const root = await fullTier(readFileSync(join(melian, "melian.yaml"), "utf8"));
		expect(root).toEqual(expect.arrayContaining([...defaultConfig.tiers.full!]));
		const copies = readdirSync(goldensDirectory, { recursive: true, withFileTypes: true }).filter(
			(entry) => entry.name === "melian.golden.yaml",
		);
		expect(copies.length).toBeGreaterThan(0);
		// A guardrail golden names no lens of its own, so its policy sets no tiers and runs the default ones.
		const exempt = ["guardrails-bare-issue-reference", "guardrails-overlong-sentence"];
		const tiered = copies.filter((copy) => !exempt.includes(basename(copy.parentPath)));
		expect(tiered.length).toBeGreaterThan(0);
		expect(copies.length - tiered.length).toBe(exempt.length);
		for (const copy of tiered) {
			const path = join(copy.parentPath, copy.name);
			expect(await fullTier(readFileSync(path, "utf8")), path).toEqual(root);
		}
	});

	it("leave policy-change-review to a change of Melian's own configuration, the corpus's included, not a golden's", async () => {
		const melian = join(goldensDirectory, "../../..");
		const repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-goldens-policy-")));
		const golden = "packages/evals/goldens/trust-boundary-clean-build-config/head/tsconfig.json";
		const write = (files: Record<string, string>) => {
			for (const [path, content] of Object.entries(files)) {
				mkdirSync(dirname(join(repo, path)), { recursive: true });
				writeFileSync(join(repo, path), content);
			}
			const identity = ["-c", "user.name=Melian Evals", "-c", "user.email=evals@melian.invalid"];
			execFileSync("git", ["add", "--all"], { cwd: repo });
			execFileSync("git", [...identity, "commit", "--quiet", "--no-gpg-sign", "-m", "commit"], { cwd: repo });
			return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		};
		try {
			execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo });
			const policy = ["melian.yaml", "packages/evals/goldens/melian.yaml"];
			const base = write({
				...Object.fromEntries(policy.map((path) => [path, readFileSync(join(melian, path), "utf8")])),
				"tsconfig.json": "{}\n",
				[golden]: "{}\n",
			});
			// The corpus's melian.yaml switches the review off beneath it, which must not reach a change to the file itself.
			const corpus = `${readFileSync(join(melian, policy[1]!), "utf8")}  # widened\n`;
			const head = write({
				"tsconfig.json": '{ "compilerOptions": { "noCheck": true } }\n',
				[golden]: "{ }\n",
				[policy[1]!]: corpus,
			});
			const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
			const { findings } = await evaluateGuardrails({
				repoRoot: repo,
				revision,
				source: { kind: "revision", commit: base },
			});
			expect(
				findings
					.filter((finding) => finding.ruleId === "guardrail/policy-change-review")
					.map((finding) => finding.properties.path),
			).toEqual(["packages/evals/goldens/melian.yaml", "tsconfig.json"]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("reach the golden's own repository under their live names", () => {
		const golden = goldens.find((each) => each.name === "conventions-clean")!;
		const { repo } = buildGoldenRepository(golden);
		try {
			const tracked = (ref: string) =>
				execFileSync("git", ["ls-tree", "-r", "--name-only", ref], { cwd: repo, encoding: "utf8" }).split("\n");
			for (const ref of ["main", "feature"]) {
				expect(tracked(ref)).toContain("AGENTS.md");
				expect(tracked(ref)).not.toContain("AGENTS.golden.md");
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("reach the golden's own repository with its repository lens under its live name", () => {
		const golden = goldens.find((each) => each.name === "durability-clean-upsert")!;
		const { repo } = buildGoldenRepository(golden);
		try {
			const tracked = (ref: string) =>
				execFileSync("git", ["ls-tree", "-r", "--name-only", ref], { cwd: repo, encoding: "utf8" }).split("\n");
			for (const ref of ["main", "feature"]) {
				expect(tracked(ref)).toContain(".melian/lenses/durability/LENS.md");
				expect(tracked(ref)).not.toContain(".melian/lenses/durability/LENS.golden.md");
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("a guardrail golden", () => {
	it.each(["bare-issue-reference", "overlong-sentence"])(
		"runs the %s rule as the root melian.yaml states it",
		async (rule) => {
			const golden = goldens.find((each) => each.name === `guardrails-${rule}`)!;
			const { repo, base } = buildGoldenRepository(golden);
			try {
				const own = await loadConfig(repo, { kind: "revision", commit: base }, ".");
				const root = await loadConfig(join(goldensDirectory, "../../.."), { kind: "worktree" }, ".");
				const { paths, ...golden_ } = own.config.guardrails["forbidden-patterns"].rules[rule]!;
				const { paths: _, ...live } = root.config.guardrails["forbidden-patterns"].rules[rule]!;
				expect(paths).toEqual(["docs/**/*.md"]);
				expect(golden_).toEqual(live);
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		},
	);
});

describe("the live flag", () => {
	it("keeps a golden whose expected.json sets live: false out of live runs, while the scripted runs below cover it", () => {
		expect(goldens.filter((golden) => !golden.live).map((golden) => golden.name)).toEqual([
			"guardrails-bare-issue-reference",
			"guardrails-overlong-sentence",
			"pre-existing-beside-change",
		]);
	});

	it("rejects a live flag that is not a boolean", () => {
		const directory = mkdtempSync(join(tmpdir(), "melian-goldens-"));
		try {
			const golden = goldens.find((each) => each.name === "clean-rename")!;
			const copy = join(directory, golden.name);
			cpSync(golden.directory, copy, { recursive: true });
			const expected = JSON.parse(readFileSync(join(copy, "expected.json"), "utf8"));
			writeFileSync(join(copy, "expected.json"), JSON.stringify({ ...expected, live: "no" }));
			expect(() => loadGoldens(directory)).toThrow(/expected\.json: \/live /);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("MELIAN_EVAL_GOLDEN", { timeout: 60_000 }, () => {
	it("selects every golden when unset or empty, and only the named one when set", () => {
		expect(selectGoldens(goldens, undefined)).toEqual(goldens);
		expect(selectGoldens(goldens, "")).toEqual(goldens);
		expect(selectGoldens(goldens, "contracts-breaking-signature").map((golden) => golden.name)).toEqual([
			"contracts-breaking-signature",
		]);
	});

	it("refuses a name no golden has, listing the goldens", () => {
		expect(() => selectGoldens(goldens, "contracts")).toThrow(
			/^No golden is named contracts\. Goldens: clean-rename, contracts-breaking-signature, /,
		);
	});

	it("refuses a golden that sets live: false, since it runs scripted only", () => {
		expect(() => selectGoldens(goldens, "pre-existing-beside-change")).toThrow(
			/^pre-existing-beside-change sets live: false in its expected\.json, so it runs scripted only\.$/,
		);
	});

	it("exits live.ts with status 2, saying no golden has the name, when the name matches no golden", () => {
		const live = fileURLToPath(new URL("../src/live.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--conditions=@melian-agent/source", live], {
			env: { PATH: process.env.PATH, MELIAN_EVAL_LIVE: "1", MELIAN_EVAL_GOLDEN: "no-such-golden" },
			encoding: "utf8",
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/^No golden is named no-such-golden\./);
	});

	it("exits live.ts with status 2, saying the golden runs scripted only, when it sets live: false", () => {
		const live = fileURLToPath(new URL("../src/live.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--conditions=@melian-agent/source", live], {
			env: { PATH: process.env.PATH, MELIAN_EVAL_LIVE: "1", MELIAN_EVAL_GOLDEN: "pre-existing-beside-change" },
			encoding: "utf8",
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/^pre-existing-beside-change sets live: false .* runs scripted only\./);
	});
});

// Scripted runs replay each golden's canned lens replies on the fake model, so the plumbing from lens to findings
// document to rendered output runs in the gate. They prove the pipeline, not the lenses' judgement; live runs do that.
describe.each(goldens.map((golden): [string, Golden] => [golden.name, golden]))(
	"scripted %s",
	{ timeout: 60_000 },
	(_, golden) => {
		it("finds exactly what the golden expects, with its cause, failure scenario, and evidence", async () => {
			const run = await runGolden(golden, { kind: "scripted" });

			expect(run.toolMismatches).toEqual([]);
			expect(scoreGolden(golden, run.findings)).toMatchObject({ precision: 1, recall: 1 });
			expect(scriptedMismatches(golden, run.findings)).toEqual([]);
			await expect(run.rendered).toMatchFileSnapshot(join(golden.directory, "scripted.txt"));
		});
	},
);

describe("runGolden", () => {
	it("excludes refuted findings from the run and its recall", { timeout: 60_000 }, async () => {
		const golden = goldens.find((each) => each.name === "correctness-null-deref")!;
		const confirmed = await runGolden(golden, { kind: "scripted" });
		expect(confirmed.toolMismatches).toEqual([]);
		expect(confirmed.findings).toHaveLength(1);
		expect(confirmed.findings[0]!.properties.verification?.verdict).toBe("confirmed");
		expect(scoreGolden(golden, confirmed.findings)).toMatchObject({ reported: 1, recall: 1 });
		const scriptLenses = testing.scriptLenses;
		let requests: ReturnType<typeof scriptLenses> = {};
		const scripted = vi.spyOn(testing, "scriptLenses").mockImplementation((fake, lenses, script, mismatches) => {
			requests = scriptLenses(
				fake,
				lenses,
				{
					...script,
					verifier: {
						[confirmed.findings[0]!.id]: {
							verdict: "refuted",
							reason: "The scripted judge rejects the planted claim.",
							evidence: [{ file: "src/user.ts", line: 7, role: "context" }],
						},
					},
				},
				mismatches,
			);
			return requests;
		});
		try {
			const refuted = await runGolden(golden, { kind: "scripted" });
			expect(refuted.toolMismatches).toEqual([]);
			expect(
				Object.values(requests)
					.flat(2)
					.filter((message) => message.role === "assistant")
					.flatMap((message) => message.content),
			).toContainEqual(
				expect.objectContaining({
					type: "toolCall",
					name: "report_verdict",
					arguments: expect.objectContaining({ verdict: "refuted" }),
				}),
			);
			expect.soft(refuted.findings).toEqual([]);
			expect.soft(scoreGolden(golden, refuted.findings)).toMatchObject({ reported: 0, recall: 0 });
		} finally {
			scripted.mockRestore();
		}
	});
	it("loads a folder's lens for a file the change moves out of that folder, as the CLI does", async () => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-golden-rename-")));
		const lens = [
			"---",
			"name: legacy",
			"description: The legacy module's own checks.",
			"tier: medium",
			"severities: [P2]",
			"rules:",
			"  - id: lost-answer",
			"    description: The answer changes.",
			"---",
			"You are the legacy reviewer.",
			"",
		].join("\n");
		const module = ["// The answer every caller expects.", "export const answer = 42;", ""].join("\n");
		const files: Record<string, string> = {
			"base/legacy/.melian/lenses/legacy/LENS.md": lens,
			"base/legacy/answer.ts": module,
			"head/legacy/.melian/lenses/legacy/LENS.md": lens,
			"head/src/answer.ts": module,
			"melian.golden.yaml": "tiers:\n  full: [lens.legacy]\n",
		};
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(directory, path)), { recursive: true });
			writeFileSync(join(directory, path), content);
		}
		const report = {
			file: "src/answer.ts",
			line: 2,
			rule: "lost-answer",
			severity: "P2",
			explanation: { what: "The answer moved.", why: "The change moved it.", fix: "Leave it." },
			failureScenario: "A caller importing legacy/answer.ts no longer finds the answer and fails to build.",
			evidence: [{ file: "src/answer.ts", line: 2, role: "cause" }],
		};
		const golden: Golden = {
			name: "rename-out-of-a-folder-lens",
			directory,
			expected: { pr_title: "Move the answer out of legacy", comments: [] },
			script: {
				legacy: [{ calls: [{ name: "report_finding", arguments: report }] }, { text: "Reported 1 finding." }],
			},
			live: false,
		};
		try {
			const run = await runGolden(golden, { kind: "scripted" });

			expect(run.toolMismatches).toEqual([]);
			expect(run.findings).toMatchObject([
				{
					ruleId: "lost-answer",
					locations: [{ physicalLocation: { artifactLocation: { uri: "src/answer.ts" } } }],
					properties: { source: { check: "lens.legacy" } },
				},
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("expectToolResult", () => {
	it("reports a scripted call whose result lacks the expected text, as a broken search would return", async () => {
		const golden = goldens.find((each) => each.name === "correctness-null-deref")!;
		const [read, , ...rest] = golden.script.correctness!;
		const broken = {
			...golden,
			script: {
				...golden.script,
				correctness: [
					read!,
					{
						calls: [
							{ name: "search", arguments: { pattern: "nowhere-at-all" }, expectToolResult: "src/org-chart.ts" },
						],
					},
					...rest,
				],
			},
		};
		const run = await runGolden(broken, { kind: "scripted" });
		expect(run.toolMismatches).toEqual([
			'correctness step 2: search returned "No matches.", expected it to contain "src/org-chart.ts"',
		]);
	});
});

describe("scriptedMismatches", () => {
	it("uses evidence from the expected rule and source", () => {
		const template = goldens.find((each) => each.name === "design-supersedes-its-own-decision")!;
		const comment = { ...template.expected.comments[0]!, source: "lens.design" };
		const golden = { ...template, expected: { ...template.expected, comments: [comment] } };
		const finding = {
			ruleId: comment.rule,
			locations: [{ physicalLocation: { artifactLocation: { uri: comment.file } } }],
			properties: {
				path: comment.file,
				cause: comment.cause,
				failureScenario: comment.failureScenario,
				evidence: comment.evidence.map(({ line, ...location }) => ({
					...location,
					startLine: line,
					revision: location.revision ?? "head",
				})),
				source: { check: "lens.design", version: "v2" },
				otherClaims: [
					{
						ruleId: comment.rule,
						source: { check: "lens.trust-boundary", version: "v2" },
						failureScenario: "Another source’s scenario",
						evidence: [],
					},
					{
						ruleId: "criterion-selection-bias",
						source: { check: "lens.design", version: "v1" },
						failureScenario: "Another rule’s scenario",
						evidence: [],
					},
				],
			},
		} as never;
		expect(scriptedMismatches(golden, [finding])).toEqual([]);
	});
	it("skips refuted evidence before choosing an eligible claim with the same rule and source", () => {
		const golden = goldens.find((each) => each.name === "design-fail-open-default")!;
		const comment = golden.expected.comments[0]!;
		const evidence = comment.evidence.map(({ line, ...location }) => ({
			...location,
			startLine: line,
			revision: "head" as const,
			snippet: "return options.writersTrusted ?? true;",
		}));
		const finding = Finding.create({
			rule: "fail-open",
			file: comment.file,
			startLine: 6,
			discriminator: "publisher",
			message: "The publisher trusts an absent answer.",
			severity: "P1",
			cause: comment.cause,
			source: { check: "lens.trust-boundary", version: "v" },
			explanation: { what: "Trust is granted.", whyHere: "The argument is absent.", whatToDo: "Require it." },
		});
		const claim = {
			id: finding.id,
			ruleId: comment.rule,
			source: { check: "lens.design", version: "v" },
			failureScenario: comment.failureScenario,
			evidence,
		};
		const merged = Finding.from({
			...finding.toJSON(),
			properties: {
				...finding.properties,
				otherClaims: [
					{
						...claim,
						failureScenario: "The rejected claim’s scenario.",
						evidence: [],
						verification: {
							verdict: "refuted",
							reason: "The earlier claim was wrong.",
							executor: "llm",
							model: "fake/judge",
							version: "v",
						},
					},
					{ ...claim, source: { ...claim.source, version: "v2" } },
				],
			},
		});
		expect(scriptedMismatches(golden, [merged])).toEqual([]);
	});
	it("names a finding whose cause, failure scenario, or evidence differs from the golden's", async () => {
		const golden = goldens.find((each) => each.name === "contracts-breaking-signature")!;
		const run = await runGolden(golden, { kind: "scripted" });
		const [cart, price] = golden.expected.comments;
		const drifted = {
			...golden,
			expected: {
				...golden.expected,
				comments: [
					{ ...cart!, cause: "pre-existing" as const, failureScenario: "Something else." },
					{ ...price!, evidence: [{ file: "src/price.ts", line: 2, role: "cause" as const }] },
				],
			},
		};
		expect(scriptedMismatches(drifted, run.findings)).toEqual([
			"src/cart.ts broken-caller: cause affected, expected pre-existing",
			expect.stringMatching(/^src\/cart\.ts broken-caller: failure scenario "summary/),
			expect.stringMatching(/^src\/price\.ts wrong-result: evidence \[.*"revision":"base".*\], expected \[/),
		]);
		expect(scriptedMismatches(drifted, [])).toEqual([
			"src/cart.ts broken-caller: not reported",
			"src/price.ts wrong-result: not reported",
		]);
	});
});

describe("scoreGolden", () => {
	const nullDeref = goldens.find((each) => each.name === "correctness-null-deref");
	const finding = (path: string, rule: string) =>
		({
			ruleId: rule,
			properties: { path },
			locations: [{ physicalLocation: { artifactLocation: { uri: path } } }],
		}) as never;

	it("matches alternative files and keeps a merged claim’s rule paired with its source", () => {
		const golden = goldens.find((each) => each.name === "design-supersedes-its-own-decision")!;
		const merged = {
			ruleId: "fail-open",
			locations: [{ physicalLocation: { artifactLocation: { uri: "src/publish.ts" } } }],
			properties: {
				path: "src/publish.ts",
				source: { check: "lens.trust-boundary", version: "v" },
				reportedBy: [
					{ check: "lens.trust-boundary", version: "v" },
					{ check: "lens.design", version: "v" },
				],
				otherClaims: [{ ruleId: "fail-open-default", source: { check: "lens.design", version: "v" } }],
			},
		} as never;
		const sourced = (rule: string, source: string) => ({
			...golden,
			expected: { ...golden.expected, comments: [{ ...golden.expected.comments[0]!, rule, source }] },
		});
		expect(scoreGolden(golden, [merged])).toMatchObject({ precision: 1, recall: 1 });
		expect(scoreGolden(sourced("fail-open-default", "lens.design"), [merged])).toMatchObject({
			precision: 1,
			recall: 1,
		});
		expect(scoreGolden(sourced("fail-open-default", "lens.trust-boundary"), [merged])).toMatchObject({
			precision: 0,
			recall: 0,
		});
		expect(scoreGolden(sourced("fail-open", "lens.design"), [merged])).toMatchObject({ precision: 0, recall: 0 });
		expect(scoreGolden(sourced("fail-open", "lens.trust-boundary"), [merged])).toMatchObject({
			precision: 1,
			recall: 1,
		});
		expect(
			scoreGolden(
				{
					...golden,
					expected: {
						...golden.expected,
						comments: [{ ...golden.expected.comments[0]!, alternativeFiles: undefined }],
					},
				},
				[merged],
			),
		).toMatchObject({ precision: 0, recall: 0 });
	});
	it.each([
		{ speaker: "design", designSeverity: "P0", trustSeverity: "P1" },
		{ speaker: "trust-boundary", designSeverity: "P1", trustSeverity: "P0" },
	] as const)(
		"rejects a refuted design claim in a live merged defect spoken by $speaker",
		({ speaker, designSeverity, trustSeverity }) => {
			const template = goldens.find((each) => each.name === "design-fail-open-default")!;
			const comment = { ...template.expected.comments[0]!, source: "lens.design" };
			const golden = { ...template, expected: { ...template.expected, comments: [comment] } };
			const report = (check: string, rule: string, verdict: Verification["verdict"], severity: Severity) =>
				Finding.create({
					rule,
					file: comment.file,
					startLine: 6,
					snippet: "return options.writersTrusted ?? true;",
					occurrence: 0,
					message: "An absent answer grants trust.",
					severity,
					cause: comment.cause,
					failureScenario: comment.failureScenario,
					evidence: comment.evidence.map(({ line, ...location }) => ({
						...location,
						startLine: line,
						revision: "head",
						snippet: "return options.writersTrusted ?? true;",
					})),
					source: { check, version: "v" },
					explanation: { what: "Trust is granted.", whyHere: "The argument is absent.", whatToDo: "Require it." },
					verification: {
						verdict,
						reason: "Scripted judgement.",
						executor: "llm",
						model: "fake/judge",
						version: "v",
					},
				});
			const design = report("lens.design", comment.rule, "refuted", designSeverity);
			const trust = report("lens.trust-boundary", "fail-open", "confirmed", trustSeverity);
			const defects = new Merge([design, trust], defaultConfig).defects();
			expect(defects).toHaveLength(1);
			const defect = defects[0]!;
			expect(defect.refuted()).toBe(false);
			expect(defect.speaker.properties.source.check).toBe(`lens.${speaker}`);
			expect(defect.speaker.properties.verification?.verdict).toBe("confirmed");
			expect(scoreGolden(golden, [defect.speaker])).toMatchObject({ reported: 1, precision: 0, recall: 0 });
			expect(scoreGolden(template, [defect.speaker])).toMatchObject({ precision: 0, recall: 0 });
			expect(scriptedMismatches(golden, [defect.speaker])).toEqual([
				"src/publish.ts fail-open-default from lens.design: not reported",
			]);
			const trusted = {
				...golden,
				expected: {
					...golden.expected,
					comments: [{ ...comment, rule: "fail-open", source: "lens.trust-boundary" }],
				},
			};
			expect(scoreGolden(trusted, [defect.speaker])).toMatchObject({ precision: 1, recall: 1 });
			expect(scriptedMismatches(trusted, [defect.speaker])).toEqual([]);
			expect(scoreGolden(template, [design])).toMatchObject({ precision: 0, recall: 0 });
		},
	);
	it.each([
		{ differing: "id", change: { id: "other-claim" } },
		{ differing: "source", change: { source: { check: "lens.tests", version: "v" } } },
		{ differing: "version", change: { source: { check: "lens.design", version: "v1" } } },
	])("does not borrow a refutation from a claim with another $differing", ({ change }) => {
		const golden = goldens.find((each) => each.name === "design-fail-open-default")!;
		const comment = golden.expected.comments[0]!;
		const original = Finding.create({
			rule: comment.rule,
			file: comment.file,
			startLine: 6,
			discriminator: "publisher",
			message: "An absent answer grants trust.",
			severity: "P1",
			cause: comment.cause,
			failureScenario: comment.failureScenario,
			source: { check: "lens.design", version: "v" },
			explanation: { what: "Trust is granted.", whyHere: "The argument is absent.", whatToDo: "Require it." },
			verification: {
				verdict: "confirmed",
				reason: "Scripted judgement.",
				executor: "llm",
				model: "fake/judge",
				version: "v",
			},
		});
		const finding = Finding.from({
			...original.toJSON(),
			properties: {
				...original.properties,
				otherClaims: [
					{
						...original.claims()[0]!,
						...change,
						verification: { ...original.properties.verification!, verdict: "refuted" },
					},
				],
			},
		});
		expect(scoreGolden(golden, [finding])).toMatchObject({ precision: 1, recall: 1 });
	});
	it("keeps a prior version’s different rule from erasing a current reporter", () => {
		const golden = goldens.find((each) => each.name === "design-supersedes-its-own-decision")!;
		const expected = {
			...golden,
			expected: {
				...golden.expected,
				comments: [{ ...golden.expected.comments[0]!, rule: "fail-open", source: "lens.trust-boundary" }],
			},
		};
		const finding = {
			ruleId: "fail-open",
			locations: [{ physicalLocation: { artifactLocation: { uri: "src/publish.ts" } } }],
			properties: {
				path: "src/publish.ts",
				reportedBy: [{ check: "lens.trust-boundary", version: "v2" }],
				otherClaims: [{ ruleId: "fail-open-default", source: { check: "lens.trust-boundary", version: "v1" } }],
			},
		} as never;
		expect(scoreGolden(expected, [finding])).toMatchObject({ precision: 1, recall: 1 });
	});
	it("scores two lens sightings of one defect once after adjudication", async () => {
		const golden = goldens.find((each) => each.name === "design-fail-open-default")!;
		const report = golden.script
			.design!.flatMap((step) => ("calls" in step ? step.calls : []))
			.find((call) => call.name === "report_finding")!.arguments;
		const duplicate = {
			...golden,
			script: {
				...golden.script,
				"trust-boundary": [
					{ calls: [{ name: "report_finding", arguments: { ...report, rule: "fail-open" } }] },
					{ text: "Reported 1 finding." },
				],
			},
		};
		const run = await runGolden(duplicate, { kind: "scripted" });
		expect(run.findings).toHaveLength(1);
		expect(scoreGolden(duplicate, run.findings)).toMatchObject({ reported: 1, precision: 1, recall: 1 });
	});
	it("matches on file and rule", () => {
		expect(
			scoreGolden(nullDeref!, [finding("src/user.ts", "null-dereference"), finding("src/user.ts", "wrong-result")]),
		).toMatchObject({
			truePositives: 1,
			found: 1,
			precision: 0.5,
			recall: 1,
		});
		expect(scoreGolden(nullDeref!, [])).toMatchObject({ precision: 1, recall: 0 });
		expect(scoreGolden(nullDeref!, [finding("src/user.ts", "wrong-result")])).toMatchObject({
			precision: 0,
			recall: 0,
		});
	});

	it("counts a second finding matching one expectation as a false positive", () => {
		expect(
			scoreGolden(nullDeref!, [
				finding("src/user.ts", "null-dereference"),
				finding("src/user.ts", "null-dereference"),
			]),
		).toMatchObject({ truePositives: 1, found: 1, precision: 0.5, recall: 1 });
	});

	it("matches an expectation that names a source only to a finding that source reported", () => {
		const [comment] = nullDeref!.expected.comments;
		const golden = {
			...nullDeref!,
			expected: { ...nullDeref!.expected, comments: [{ ...comment!, source: "lens.tests" }] },
		};
		const reportedBy = (...checks: string[]) =>
			({
				ruleId: "null-dereference",
				properties: { path: "src/user.ts", reportedBy: checks.map((check) => ({ check, version: "v" })) },
				locations: [{ physicalLocation: { artifactLocation: { uri: "src/user.ts" } } }],
			}) as never;
		expect(scoreGolden(golden, [reportedBy("lens.correctness")])).toMatchObject({
			truePositives: 0,
			found: 0,
			precision: 0,
			recall: 0,
		});
		expect(scoreGolden(golden, [reportedBy("lens.correctness", "lens.tests")])).toMatchObject({
			truePositives: 1,
			found: 1,
			precision: 1,
			recall: 1,
		});
		expect(scriptedMismatches(golden, [reportedBy("lens.correctness")])).toEqual([
			"src/user.ts null-dereference from lens.tests: not reported",
		]);
	});

	it("pairs findings with expectations so that a finding several lenses reported does not take another's only match", () => {
		const [comment] = nullDeref!.expected.comments;
		const golden = {
			...nullDeref!,
			expected: {
				...nullDeref!.expected,
				comments: [
					{ ...comment!, source: "lens.correctness" },
					{ ...comment!, source: "lens.tests" },
				],
			},
		};
		const reportedBy = (...checks: string[]) =>
			({
				ruleId: "null-dereference",
				properties: { path: "src/user.ts", reportedBy: checks.map((check) => ({ check, version: "v" })) },
				locations: [{ physicalLocation: { artifactLocation: { uri: "src/user.ts" } } }],
			}) as never;
		expect(
			scoreGolden(golden, [reportedBy("lens.correctness", "lens.tests"), reportedBy("lens.correctness")]),
		).toMatchObject({ truePositives: 2, found: 2, precision: 1, recall: 1 });
	});

	it("averages over every finding in the corpus, not per golden", () => {
		const scores = [
			scoreGolden(nullDeref!, [finding("src/user.ts", "null-dereference")]),
			scoreGolden(goldens[0]!, [finding("src/main.ts", "wrong-result"), finding("src/main.ts", "state-ordering")]),
		];
		expect(scoreCorpus(scores)).toEqual({ precision: 1 / 3, recall: 1 });
	});
});

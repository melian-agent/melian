import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	Changeset,
	type Decider,
	defaultConfig,
	EnolaImpact,
	EnolaPolicy,
	GraphSnapshot,
	Lens,
	loadConfig,
	ReviewCoverage,
	staticFindings,
	ToolManifest,
} from "@melian-agent/core";
import {
	CallerContext,
	CoverageCache,
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	decisionExtension,
	openHarness,
	readFindings,
	reviewChangeset,
	revisionKey,
	runChecks,
	runStaticTool,
	ToolProvisioning,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commit, createRepository, gitIn, removeRepository } from "./fixtures/repo.ts";
import { testTool, toolArchive } from "./fixtures/tool-archive.ts";

let repo: string;
beforeEach(() => {
	repo = createRepository();
});
afterEach(() => {
	vi.restoreAllMocks();
	removeRepository(repo);
});

async function fake(
	exit = 1,
	impactExit = 0,
	requirePolicy = false,
	impactTarget = "Alpha",
	constraintRequired = false,
	resultUri = "src/a.ts",
) {
	const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo 0.0.1; exit 0; fi
for config in "$@"; do :; done
${
	requirePolicy
		? `
[ "$(cat enola/constraints/layer.yaml)" = 'rules: [] # base constraint' ] || exit 9
[ "$(cat enola-intent.yaml)" = 'rules: [] # base intent' ] || exit 9
[ "$(cat .enola/suppressions.yaml)" = 'suppressions: [] # base suppression' ] || exit 9
[ ! -e enola/constraints/head-only.yaml ] || exit 9
[ ! -e mcp-arch.yaml ] || exit 9
`
		: ""
}
case "$1" in
--generate)
  marker=base
  if grep BROKEN src/a.ts > /dev/null; then marker=head; fi
  printf '%s' '{"id":"alpha","kind":"symbol","name":"Alpha","file":"src/a.ts","line":1,"generation":"'"$marker"'"}' > .enola/facts.jsonl
  printf '%s' '[]' > .enola/insights.json
  printf '%s' '{"format_version":1,"snapshot_id":"sha256:${"a".repeat(64)}","enola_version":"0.0.1"}' > .enola/receipt.json
  grep -F 'providers: []' "$config" > /dev/null || exit 9
  [ "$ENOLA_NO_UPDATE_CHECK" = 1 ] || exit 9
  printf '%s' "$HOME" > .enola/home.txt
  exit 0;;
baseline)
  [ "$2" = pin ] || exit 9
  mkdir -p .enola/baseline
  cp .enola/facts.jsonl .enola/insights.json .enola/receipt.json .enola/baseline/
  exit 0;;
check)
  baseline=
  for arg in "$@"; do
    case "$arg" in --baseline=*) baseline="\${arg#--baseline=}";; esac
  done
  [ -n "$baseline" ] || exit 9
  grep -F '"generation":"base"' "$baseline/facts.jsonl" > /dev/null || exit 9
  if [ ${exit} -ge 2 ]; then echo declined >&2; exit ${exit}; fi
  if grep BROKEN src/a.ts > /dev/null && ${constraintRequired ? "[ -f enola/constraints/layer.yaml ]" : "true"}; then
    printf '%s' '{"version":"2.1.0","runs":[{"results":[{"ruleId":"constraints/core-layer","level":"error","message":{"text":"Core reaches pipeline"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"${resultUri}"},"region":{"startLine":1}}}]}]}]}'
  else printf '%s' '{"version":"2.1.0","runs":[{"results":[]}]}' ; fi
  exit ${exit};;
impact)
  [ "$7" = 'file:src/a.ts Alpha' ] || exit 9
  printf '%s' '{"target":"${impactTarget}","by_depth":{"1":[{"name":"Caller","kind":"symbol","file":"src/caller.ts","line":1}]},"edges":[],"stats":{"truncated":false}}'
  exit ${impactExit};;
esac
exit 9
`;
	const bytes = toolArchive([{ name: "enola", text: script }]);
	const pin = testTool(bytes);
	const { name, ...fields } = pin;
	const manifest = ToolManifest.parse(JSON.stringify({ format_version: 1, tools: { [name]: fields }, misses: [] }));
	return ToolProvisioning.open(repo, {
		manifest,
		root: join(repo, ".git", "melian"),
		platform: "darwin-arm64",
		fetch: async () => new Response(bytes),
	});
}

describe("static.enola", { timeout: 60_000 }, () => {
	it.each([new Error("query refused"), "query refused"])("retains a caller query rejection: %s", async (failure) => {
		const base = commit(repo, { "src/a.ts": "export function Alpha() { return 1; }\n" });
		const head = commit(repo, { "src/a.ts": "export function Alpha() { return 2; }\n" });
		const tools = await fake(0);
		const input = {
			repoRoot: repo,
			base,
			commit: head,
			tool: "enola" as const,
			settings: defaultConfig.static.enola,
			tools,
			env: createNodeExecutionEnv(repo),
		};
		expect((await runStaticTool(input, context)).status).toBe("ran");
		vi.spyOn(EnolaImpact, "parse").mockImplementation(() => {
			throw failure;
		});
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		const callers = await CallerContext.open(input, changeset.revision.files, context);
		expect(callers.notes(["src/a.ts"])).toEqual(["Callers unavailable for src/a.ts: line 1: query refused"]);
		expect(callers.callers(["src/a.ts"])).toEqual([]);
	});
	it.each([
		[0, "careful", "Alpha"],
		[2, "careful", "Alpha"],
		[0, "quick", "Alpha"],
		[0, "careful", "Beta"],
	] as const)(
		"offers scoped callers or records exit %s as no answer, and attaches %s transcript coverage for target %s",
		async (exit, level, target) => {
			const base = commit(repo, {
				"src/a.ts": "export function Alpha() {\n return 1;\n}\n",
				"src/caller.ts": "export const Caller = Alpha();\n",
			});
			const head = commit(repo, { "src/a.ts": "export function Alpha() {\n return 2;\n}\n" });
			const tools = await fake(0, exit, false, target);
			const input = {
				env: createNodeExecutionEnv(repo),
				repoRoot: repo,
				base,
				commit: head,
				tool: "enola" as const,
				settings: defaultConfig.static.enola,
				tools,
			};
			const changeset = await Changeset.resolve(repo, `${base}..${head}`);
			const absent = await CallerContext.open(input, changeset.revision.files, context);
			expect(absent.notes(["src/a.ts"])).toContain("Callers unavailable: Enola executable not-fetched");
			await tools.binary("enola");
			const missing = await CallerContext.open(input, changeset.revision.files, context);
			expect(missing.notes(["src/a.ts"]).join(" ")).toContain("No verified Enola snapshot");
			const check = await runStaticTool(input, context);
			expect(check.status).toBe("ran");
			const callers = await CallerContext.open(input, changeset.revision.files, context);
			if (exit === 0 && target === "Alpha") {
				expect(callers.callers(["src/a.ts"])[0]?.callers).toEqual([
					{ name: "Caller", kind: "symbol", file: "src/caller.ts", line: 1 },
				]);
				expect(callers.render(["src/a.ts"], "NONCE")).toContain("src/caller.ts:1 Caller");
			} else {
				expect(callers.notes(["src/a.ts"]).join(" ")).toContain(
					target === "Beta" ? "impact selected another full target name" : "Enola impact exited 2",
				);
				expect(callers.callers(["src/a.ts"])).toEqual([]);
				expect(callers.render(["src/a.ts"], "NONCE")).toBe("");
			}
			expect(callers.render([], "NONCE")).toBe("");
			const models = createFakeModels({ models: [{ id: "heavy" }] });
			const model = models.ref("heavy");
			const decider: Decider = {
				name: "fixture",
				calibrated: false,
				decide: async (request) => ({
					answers: request.questions.map((question) => ({ question: question.id, distribution: { [level]: 1 } })),
				}),
			};
			const registry = createReviewRegistry();
			registry.install(decisionExtension(decider));
			const harness = await openHarness(createMemoryStorage(), {
				models: models.models,
				registry,
				settings: { retry: { enabled: false } },
			});
			try {
				await harness.root(context, { agent: { model } });
				const lenses = (await Lens.load(repo, { kind: "revision", commit: base }, ["src/a.ts"])).filter(
					(lens) => lens.name === "correctness",
				);
				await expect(
					callers.recordCoverage({
						harness,
						children: {},
						lenses: [{ key: "correctness@1@careful", name: "correctness" }],
						files: changeset.revision.files,
						nonce: "legacy",
						context,
					}),
				).rejects.toThrow("conversation unavailable");
				scriptConversations(models, [
					{
						match: "correctness",
						replies: [
							fauxAssistantMessage(fauxToolCall("read_file", { path: "src/a.ts", startLine: 1 }), {
								stopReason: "toolUse",
							}),
							fauxAssistantMessage("Done."),
						],
					},
				]);
				const options = {
					harness,
					changeset,
					config: {
						...defaultConfig,
						tiers: { full: ["lens.correctness"] },
						models: {
							heavy: { model: `${model.provider}/${model.modelId}` },
							medium: { model: `${model.provider}/${model.modelId}` },
						},
					},
					lenses,
					standards: [],
					models: models.review,
					decider,
					callers,
					checks: [],
				};
				const reviewed = await reviewChangeset(options);
				const attached = await reviewChangeset(options);
				expect(attached.verdict.ran?.find((record) => record.name === "lens.correctness")?.coverage?.review).toBe(
					reviewed.verdict.ran?.find((record) => record.name === "lens.correctness")?.coverage?.review,
				);
				const record = reviewed.verdict.ran?.find((record) => record.name === "lens.correctness");
				expect(record?.level).toBe(level);
				expect(record?.coverage?.review).toMatch(/^[a-f0-9]{64}$/);
				if (check.status !== "ran") throw new Error("No Enola check");
				const cache = await CoverageCache.open(tools.cache.root);
				const coverage = await cache.read(
					{
						tree: gitIn(repo, "rev-parse", `${head}^{tree}`),
						version: "0.0.1",
						binary: await tools.cache.digest(tools.tool("enola"), tools.platform),
						config: (await EnolaPolicy.load(repo, base)).hash,
					},
					"review",
					{ id: record?.coverage?.review },
				);
				expect(coverage).toBeInstanceOf(ReviewCoverage);
				if (!(coverage instanceof ReviewCoverage)) throw new Error("No review coverage");
				expect(coverage.id).toBe(record?.coverage?.review);
				expect(
					coverage.toJSON().lenses[0]?.files.find((file) => file.path === "src/a.ts" && file.revision === "head")
						?.hunks,
				).toEqual([0]);
				expect(coverage.toJSON().lenses[0]?.files.find((file) => file.path === "src/caller.ts")?.status).toBe(
					"not read",
				);
			} finally {
				await harness.close(context);
			}
			expect(gitIn(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		},
	);
	it("stores quick and escalated careful reads together on repeat attachment", async () => {
		const before = [
			"export function Alpha() {",
			...Array.from({ length: 18 }, (_, index) => `  // padding ${index}`),
			"  return 1;",
			"}",
			"",
		].join("\n");
		const base = commit(repo, { "src/a.ts": before, "src/caller.ts": "export const Caller = Alpha();\n" });
		const head = commit(repo, { "src/a.ts": before.replace("return 1;", "return 2; // BROKEN") });
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		const tools = await fake(0);
		const input = {
			env: createNodeExecutionEnv(repo),
			repoRoot: repo,
			base,
			commit: head,
			tool: "enola" as const,
			settings: defaultConfig.static.enola,
			tools,
		};
		expect((await runStaticTool(input, context)).status).toBe("ran");
		const callers = await CallerContext.open(input, changeset.revision.files, context);
		expect(callers.callers(["src/a.ts"])).toHaveLength(1);
		const models = createFakeModels({ models: [{ id: "heavy" }] });
		const model = models.ref("heavy");
		const decider: Decider = {
			name: "fixture",
			calibrated: false,
			decide: async (request) => ({
				answers: request.questions.map((question) => ({ question: question.id, distribution: { quick: 1 } })),
			}),
		};
		const registry = createReviewRegistry();
		registry.install(decisionExtension(decider));
		const harness = await openHarness(createMemoryStorage(), {
			models: models.models,
			registry,
			settings: { retry: { enabled: false } },
		});
		try {
			await harness.root(context, { agent: { model } });
			const lenses = (await Lens.load(repo, { kind: "revision", commit: base }, ["src/a.ts"])).filter(
				(lens) => lens.name === "correctness",
			);
			const read = (startLine: number) =>
				fauxAssistantMessage(fauxToolCall("read_file", { path: "src/a.ts", startLine, maxLines: 1 }), {
					stopReason: "toolUse",
				});
			const requests = scriptConversations(models, [
				{
					match: "You are the correctness reviewer",
					replies: [
						read(1),
						fauxAssistantMessage(
							fauxToolCall("report_finding", {
								file: "src/a.ts",
								line: 20,
								rule: "wrong-result",
								severity: "P1",
								explanation: {
									what: "Alpha returns two instead of one.",
									why: "The changed return breaks its callers.",
									fix: "Return one.",
								},
								failureScenario: "Calling Alpha() returns 2 where the caller expects 1.",
								evidence: [{ file: "src/a.ts", line: 20, role: "cause" }],
							}),
							{ stopReason: "toolUse" },
						),
						fauxAssistantMessage("Done."),
						read(20),
						fauxAssistantMessage("Done."),
					],
				},
			]);
			const options = {
				harness,
				changeset,
				config: {
					...defaultConfig,
					tiers: { full: ["lens.correctness"] },
					models: {
						heavy: { model: `${model.provider}/${model.modelId}` },
						medium: { model: `${model.provider}/${model.modelId}` },
					},
				},
				lenses,
				standards: [],
				models: models.review,
				decider,
				callers,
				checks: [],
			};
			const reviewed = await reviewChangeset(options);
			const attached = await reviewChangeset(options);
			expect(requests["You are the correctness reviewer"]).toHaveLength(5);
			expect(reviewed.findings).toHaveLength(1);
			const record = reviewed.verdict.ran?.find((record) => record.name === "lens.correctness");
			expect(record?.level).toBe("careful");
			expect(record?.reason).toContain("escalated from quick to careful");
			expect(record?.coverage?.review).toMatch(/^[a-f0-9]{64}$/);
			const repeated = attached.verdict.ran?.find((record) => record.name === "lens.correctness");
			expect(repeated?.coverage?.review).toBe(record?.coverage?.review);
			const cache = await CoverageCache.open(tools.cache.root);
			const parts = {
				tree: gitIn(repo, "rev-parse", `${head}^{tree}`),
				version: "0.0.1",
				binary: await tools.cache.digest(tools.tool("enola"), tools.platform),
				config: (await EnolaPolicy.load(repo, base)).hash,
			};
			for (const id of [record?.coverage?.review, repeated?.coverage?.review]) {
				const coverage = await cache.read(parts, "review", { id });
				expect(coverage).toBeInstanceOf(ReviewCoverage);
				if (!(coverage instanceof ReviewCoverage)) throw new Error("No review coverage");
				expect(
					coverage.toJSON().lenses[0]?.files.find((file) => file.path === "src/a.ts" && file.revision === "head"),
				).toMatchObject({
					lines: [
						{ start: 1, end: 1 },
						{ start: 20, end: 20 },
					],
					hunks: [0],
					status: "read",
				});
			}
		} finally {
			await harness.close(context);
		}
	});
	it("judges a diverged PR with target-tip policy and reuses that policy for callers", async () => {
		const base = commit(repo, { "src/a.ts": "export function Alpha() { return 1; }\n" });
		const policy = commit(repo, {
			"melian.yaml": "tiers:\n  fast: [static.enola]\nstatic:\n  enola: { enabled: true }\n",
			"enola/constraints/layer.yaml": "rules: [] # target constraint\n",
		});
		gitIn(repo, "checkout", "-b", "feature", base);
		const head = commit(repo, { "src/a.ts": "export function Alpha() { return 2; } // BROKEN\n" });
		const changeset = await Changeset.resolve(repo, `${policy}...${head}`);
		expect(changeset.revision.base).toBe(base);
		const source = { kind: "revision" as const, commit: policy };
		const { config } = await loadConfig(repo, source, "");
		const tools = await fake(1, 0, false, "Alpha", true);
		vi.spyOn(ToolProvisioning, "open").mockResolvedValue(tools);
		const models = createFakeModels();
		const registry = createReviewRegistry();
		registry.install(checksExtension);
		const harness = await openHarness(createMemoryStorage(), {
			models: models.models,
			registry,
			env: () => createNodeExecutionEnv(repo),
		});
		try {
			const root = await harness.root(context, { agent: { model: models.ref() } });
			const result = await runChecks(harness, { rootConversationId: root.id, changeset, config, source }, context);
			expect(result.records).toEqual([
				expect.objectContaining({ name: "static.enola", status: "ran", findings: 1 }),
			]);
			const record = result.records[0];
			if (record?.status !== "ran") throw new Error("Enola did not run");
			expect(record.snapshots?.map((snapshot) => snapshot.commit)).toEqual([base, head]);
			const findings = await readFindings(harness, root.id, revisionKey({ base, head }), context);
			expect(findings).toEqual([
				expect.objectContaining({
					ruleId: "enola/constraints/core-layer",
					properties: expect.objectContaining({ cause: "introduced" }),
				}),
			]);
			const policyHash = (await EnolaPolicy.load(repo, policy)).hash;
			const binary = await tools.cache.digest(tools.tool("enola"), tools.platform);
			expect(record.snapshots?.map((snapshot) => snapshot.cacheKey)).toEqual(
				[base, head].map((commit) =>
					GraphSnapshot.key({
						tree: gitIn(repo, "rev-parse", `${commit}^{tree}`),
						version: "0.0.1",
						binary,
						config: policyHash,
					}),
				),
			);
			const callers = await CallerContext.open(
				{
					env: createNodeExecutionEnv(repo),
					repoRoot: repo,
					base,
					commit: head,
					policyCommit: policy,
					tool: "enola",
					settings: config.static.enola,
					tools,
				},
				changeset.revision.files,
				context,
			);
			expect(callers.callers(["src/a.ts"])[0]?.callers).toEqual([
				{ name: "Caller", kind: "symbol", file: "src/caller.ts", line: 1 },
			]);
			expect(callers.notes(["src/a.ts"]).join(" ")).not.toContain("unavailable");
		} finally {
			await harness.close(context);
		}
	});
	it("compares head against a generated base, applies base policy, and leaves no worktree", async () => {
		const base = commit(repo, {
			"src/a.ts": "export const a = 1;\n",
			"enola.yaml": "providers: []\n",
			"enola/constraints/layer.yaml": "rules: [] # base constraint\n",
			"enola-intent.yaml": "rules: [] # base intent\n",
			".enola/suppressions.yaml": "suppressions: [] # base suppression\n",
			".enola/baseline/facts.jsonl": "do not reuse\n",
		});
		const head = commit(repo, {
			"src/a.ts": "export const BROKEN = 1;\n",
			"enola.yaml": "providers: [{ command: [evil] }]\n",
			"enola/constraints/layer.yaml": "rules: [] # head constraint\n",
			"enola-intent.yaml": "rules: [] # head intent\n",
			".enola/suppressions.yaml": "suppressions: [] # head suppression\n",
			"enola/constraints/head-only.yaml": "rules: []\n",
			"mcp-arch.yaml": "providers: [{ command: [evil] }]\n",
		});
		const result = await runStaticTool(
			{
				env: createNodeExecutionEnv(repo),
				repoRoot: repo,
				base,
				commit: head,
				tool: "enola",
				settings: defaultConfig.static.enola,
				tools: await fake(1, 0, true),
			},
			context,
		);
		if (result.status !== "ran" || !result.baseLog) throw new Error("Enola did not run");
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		const report = await staticFindings({
			repoRoot: repo,
			revision: changeset.revision,
			tool: "enola",
			settings: defaultConfig.static.enola,
			base: result.baseLog,
			head: result.log,
		});
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]?.ruleId).toBe("enola/constraints/core-layer");
		expect(report.findings[0]?.properties.cause).toBe("introduced");
		expect(result.notes).toContain("Enola configuration differs at head; the base's copies judged both revisions.");
		expect(result.snapshots?.map((s) => s.commit)).toEqual([base, head]);
		expect(result.snapshots?.every((s) => /^[a-f0-9]{64}$/.test(s.coverage?.test ?? ""))).toBe(true);
		const repeated = await runStaticTool(
			{
				env: createNodeExecutionEnv(repo),
				repoRoot: repo,
				base,
				commit: head,
				tool: "enola",
				settings: defaultConfig.static.enola,
				tools: await fake(1, 0, true),
			},
			context,
		);
		if (repeated.status !== "ran") throw new Error("Enola did not repeat");
		// A note that named the cache's state made a rerun's check record, and so the verdict's fingerprint, differ.
		expect(repeated.notes).toEqual(result.notes);
		expect(repeated.snapshots).toEqual(result.snapshots);
		expect(readFileSync(join(repo, "enola.yaml"), "utf8")).toContain("evil");
		expect(gitIn(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
	});
	it("records exit one with empty SARIF as clean with an explicit note", async () => {
		const base = commit(repo, { "src/a.ts": "export const a = 1;\n" });
		const result = await runStaticTool(
			{
				env: createNodeExecutionEnv(repo),
				repoRoot: repo,
				base,
				commit: base,
				tool: "enola",
				settings: defaultConfig.static.enola,
				tools: await fake(1),
			},
			context,
		);
		expect(result.status).toBe("ran");
		if (result.status !== "ran") throw new Error("Enola failed");
		expect(result.log.runs[0].results).toEqual([]);
		expect(result.notes).toContain("Enola check exited 1 with no unsuppressed SARIF results; treated as clean.");
	});
	it("fails closed when every result Enola reported lies where Melian does not read", async () => {
		const base = commit(repo, { "src/a.ts": "export const a = 1;\n" });
		const head = commit(repo, { "src/a.ts": "export const BROKEN = 1;\n" });
		await expect(
			runStaticTool(
				{
					env: createNodeExecutionEnv(repo),
					repoRoot: repo,
					base,
					commit: head,
					tool: "enola",
					settings: defaultConfig.static.enola,
					tools: await fake(1, 0, false, "Alpha", false, "node_modules/leak/index.ts"),
				},
				context,
			),
		).rejects.toMatchObject({ code: "invalidOutput" });
	});
	it.each([2, 3])("fails exit %s closed with Enola's message", async (exit) => {
		const base = commit(repo, { "src/a.ts": "export const a = 1;\n" });
		await expect(
			runStaticTool(
				{
					env: createNodeExecutionEnv(repo),
					repoRoot: repo,
					base,
					commit: base,
					tool: "enola",
					settings: defaultConfig.static.enola,
					tools: await fake(exit),
				},
				context,
			),
		).rejects.toMatchObject({
			code: "toolFailed",
			message: expect.stringContaining(`Enola check exited ${exit}: declined`),
		});
	});
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	Changeset,
	defaultConfig,
	EnolaPolicy,
	Lens,
	ReviewCoverage,
	staticFindings,
	ToolManifest,
} from "@melian-agent/core";
import {
	CallerContext,
	CoverageCache,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	openHarness,
	reviewChangeset,
	runStaticTool,
	ToolProvisioning,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commit, createRepository, gitIn, removeRepository } from "./fixtures/repo.ts";
import { testTool, toolArchive } from "./fixtures/tool-archive.ts";

let repo: string;
beforeEach(() => {
	repo = createRepository();
});
afterEach(() => {
	removeRepository(repo);
});

async function fake(exit = 1, impactExit = 0) {
	const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo 0.0.1; exit 0; fi
for config in "$@"; do :; done
case "$1" in
--generate)
  printf '%s' '{"id":"alpha","kind":"symbol","name":"Alpha","file":"src/a.ts","line":1}' > .enola/facts.jsonl
  printf '%s' '[]' > .enola/insights.json
  printf '%s' '{"format_version":1,"snapshot_id":"sha256:${"a".repeat(64)}","enola_version":"0.0.1"}' > .enola/receipt.json
  grep -F 'providers: []' "$config" > /dev/null || exit 9
  [ "$ENOLA_NO_UPDATE_CHECK" = 1 ] || exit 9
  printf '%s' "$HOME" > .enola/home.txt
  exit 0;;
baseline)
  mkdir -p .enola/baseline
  cp .enola/facts.jsonl .enola/insights.json .enola/receipt.json .enola/baseline/
  exit 0;;
check)
  if [ ${exit} -ge 2 ]; then echo declined >&2; exit ${exit}; fi
  if grep BROKEN src/a.ts > /dev/null; then
    printf '%s' '{"version":"2.1.0","runs":[{"results":[{"ruleId":"constraints/core-layer","level":"error","message":{"text":"Core reaches pipeline"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/a.ts"},"region":{"startLine":1}}}]}]}]}'
  else printf '%s' '{"version":"2.1.0","runs":[{"results":[]}]}' ; fi
  exit ${exit};;
impact)
  [ "$7" = 'file:src/a.ts Alpha' ] || exit 9
  printf '%s' '{"target":"Alpha","by_depth":{"1":[{"name":"Caller","kind":"symbol","file":"src/caller.ts","line":1}]},"edges":[],"stats":{"truncated":false}}'
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
	it.each([0, 2])(
		"offers scoped callers or records exit %s as no answer, and attaches transcript coverage",
		async (exit) => {
			const base = commit(repo, {
				"src/a.ts": "export function Alpha() {\n return 1;\n}\n",
				"src/caller.ts": "export const Caller = Alpha();\n",
			});
			const head = commit(repo, { "src/a.ts": "export function Alpha() {\n return 2;\n}\n" });
			const tools = await fake(0, exit);
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
			if (exit === 0) {
				expect(callers.callers(["src/a.ts"])[0]?.callers).toEqual([
					{ name: "Caller", kind: "symbol", file: "src/caller.ts", line: 1 },
				]);
				expect(callers.render(["src/a.ts"], "NONCE")).toContain("src/caller.ts:1 Caller");
			} else {
				expect(callers.notes(["src/a.ts"]).join(" ")).toContain("Enola impact exited 2");
				expect(callers.render(["src/a.ts"], "NONCE")).toBe("");
			}
			expect(callers.render([], "NONCE")).toBe("");
			const models = createFakeModels({ models: [{ id: "heavy" }] });
			const model = models.ref("heavy");
			const harness = await openHarness(createMemoryStorage(), {
				models: models.models,
				registry: createReviewRegistry(),
				settings: { retry: { enabled: false } },
			});
			try {
				await harness.root(context, { agent: { model } });
				const lenses = (await Lens.load(repo, { kind: "revision", commit: base }, ["src/a.ts"])).filter(
					(lens) => lens.name === "correctness",
				);
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
						models: { heavy: { model: `${model.provider}/${model.modelId}` } },
					},
					lenses,
					standards: [],
					models: models.review,
					callers,
				};
				const reviewed = await reviewChangeset(options);
				const attached = await reviewChangeset(options);
				expect(attached.verdict.ran?.find((record) => record.name === "lens.correctness")?.coverage?.review).toBe(
					reviewed.verdict.ran?.find((record) => record.name === "lens.correctness")?.coverage?.review,
				);
				const record = reviewed.verdict.ran?.find((record) => record.name === "lens.correctness");
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
	it("compares head against a generated base, applies base policy, and leaves no worktree", async () => {
		const base = commit(repo, {
			"src/a.ts": "export const a = 1;\n",
			"enola.yaml": "providers: []\n",
			"enola/constraints/layer.yaml": "rules: []\n",
			".enola/baseline/facts.jsonl": "do not reuse\n",
		});
		const head = commit(repo, {
			"src/a.ts": "export const BROKEN = 1;\n",
			"enola.yaml": "providers: [{ command: [evil] }]\n",
		});
		const result = await runStaticTool(
			{
				env: createNodeExecutionEnv(repo),
				repoRoot: repo,
				base,
				commit: head,
				tool: "enola",
				settings: defaultConfig.static.enola,
				tools: await fake(),
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
				tools: await fake(),
			},
			context,
		);
		if (repeated.status !== "ran") throw new Error("Enola did not repeat");
		expect(repeated.notes.filter((note) => note.includes("cache hit"))).toHaveLength(2);
		expect(repeated.snapshots).toEqual(result.snapshots);
		expect(readFileSync(join(repo, "enola.yaml"), "utf8")).toContain("evil");
		expect(gitIn(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
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

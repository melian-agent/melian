import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset, defaultConfig, staticFindings, ToolManifest } from "@melian-agent/core";
import {
	backgroundContext as context,
	createNodeExecutionEnv,
	runStaticTool,
	ToolProvisioning,
} from "@melian-agent/pipeline";
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

async function fake(exit = 1) {
	const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo 0.0.1; exit 0; fi
for config in "$@"; do :; done
case "$1" in
--generate)
  printf '%s' '{"format_version":1,"kind":"symbol","name":"Alpha"}' > .enola/facts.jsonl
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

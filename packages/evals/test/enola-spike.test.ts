import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolManifest } from "@melian-agent/core";
import { ToolProvisioning } from "@melian-agent/pipeline";
import { afterEach, expect, it, vi } from "vitest";
import { commit, createRepository, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import { testTool, toolArchive } from "../../pipeline/test/fixtures/tool-archive.ts";
import { CompilerGraph } from "../src/compiler-graph.ts";
import { EnolaSpike } from "../src/enola-spike.ts";

let repo: string;
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (repo) removeRepository(repo);
});

it("measures a local analyser and reuses only queries for the same snapshot", async () => {
	repo = createRepository();
	vi.stubEnv("TMPDIR", repo);
	vi.stubEnv("LANG", "C");
	const closed = vi.spyOn(CompilerGraph.prototype, "close");
	const facts = [
		{ id: "a", name: "src.a", kind: "symbol", file: "src/a.ts", line: 1 },
		{ id: "b", name: "src.b", kind: "symbol", file: "src/a.ts", line: 2 },
	]
		.map((fact) => JSON.stringify(fact))
		.join("\n");
	const impact = JSON.stringify({
		target: "src.b",
		by_depth: { "1": [{ name: "src.a", kind: "symbol", file: "src/a.ts", line: 1 }] },
		edges: [{ source: "src.a", target: "src.b", kind: "calls" }],
		stats: { truncated: false },
	});
	commit(repo, {
		"src/a.ts": "export function a() { b(); }\nexport function b() {}\n",
		"tsconfig.json": '{"compilerOptions":{"noEmit":true},"include":["src/**/*.ts"]}',
		"fixture-facts": facts,
		"fixture-impact": impact,
	});
	const script = `#!/bin/sh
printf '%s|%s\n' "$TMPDIR" "$LANG" > fixture-env
if [ "$1" = "--generate" ]; then
  cp fixture-facts .enola/facts.jsonl
  printf '[]' > .enola/insights.json
  printf '%s' '{"format_version":1,"enola_version":"0.0.1","snapshot_id":"sha256:${"d".repeat(64)}"}' > .enola/receipt.json
  printf '{}' > .enola/snapshot.meta.json
  printf '{}' > .enola/run.json
else
  [ "$4" = 1 ] && [ "$6" = 500 ] || exit 9
  cat fixture-impact
fi
`;
	const bytes = toolArchive([{ name: "enola", text: script }]);
	const { name, ...pin } = testTool(bytes);
	const tools = await ToolProvisioning.open(repo, {
		manifest: ToolManifest.parse(JSON.stringify({ format_version: 1, tools: { [name]: pin }, misses: [] })),
		root: join(repo, "cache"),
		platform: "darwin-arm64",
		fetch: async () => new Response(bytes),
	});
	vi.spyOn(ToolProvisioning, "open").mockResolvedValue(tools);
	vi.spyOn(console, "log").mockImplementation(() => {});
	const output = join(repo, "measurement");
	const spike = await EnolaSpike.open(repo, output);
	await spike.run();
	expect(await readFile(join(repo, "fixture-env"), "utf8")).toBe(`${repo}|C\n`);
	expect(closed).toHaveBeenCalledOnce();
	const summary = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
	expect(summary).toMatchObject({
		files: 1,
		queries: 1,
		noAnswer: 0,
		factsStable: true,
		totals: { calls: 1, matchedCalls: 1 },
		impactTotals: { matchedCalls: 1 },
		factsTotals: { matchedCalls: 0 },
	});
	expect(summary.timings.map((timing: { phase: string }) => timing.phase)).toEqual([
		"generate-cold",
		"generate-warm",
		"impact-cold",
		"impact-warm",
	]);
	expect(summary.cacheBytes).toBeGreaterThan(0);
	for (const timing of summary.timings) {
		const raw = await readFile(join(output, `${timing.phase}.time`), "utf8");
		const peak =
			process.platform === "darwin"
				? Number(raw.match(/(\d+)\s+maximum resident set size/)?.[1])
				: Number(raw.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)?.[1]) * 1024;
		expect(timing.peakBytes).toBe(peak);
		expect(timing.peakBytes).toBeGreaterThan(0);
	}
	await writeFile(join(repo, "fixture-impact"), impact.padEnd(32 * 1024 * 1024, " "));
	await spike.run();
	expect(JSON.parse(await readFile(join(output, "summary.json"), "utf8"))).toMatchObject({ noAnswer: 1 });
	await writeFile(join(repo, "fixture-impact"), impact);
	await spike.run();
	await writeFile(join(repo, "fixture-impact"), "invalid report");
	await spike.run({ reuseQueries: true });
	expect(JSON.parse(await readFile(join(output, "summary.json"), "utf8"))).toMatchObject({
		noAnswer: 0,
		totals: { matchedCalls: 1 },
	});
	await writeFile(join(output, "summary.json"), '{"cacheKey":"wrong"}');
	await spike.run({ reuseQueries: true });
	expect(JSON.parse(await readFile(join(output, "summary.json"), "utf8"))).toMatchObject({
		noAnswer: 1,
		totals: { matchedCalls: 0 },
	});
	await writeFile(join(repo, "fixture-impact"), impact);
	await rm(join(output, "summary.json"));
	await spike.run({ reuseQueries: true });
	expect(JSON.parse(await readFile(join(output, "summary.json"), "utf8"))).toMatchObject({ noAnswer: 0 });
	await writeFile(join(output, "answers", "b.json"), "unreadable cached report");
	await spike.run({ reuseQueries: true });
	expect(JSON.parse(await readFile(join(output, "summary.json"), "utf8"))).toMatchObject({ noAnswer: 1 });
	await rm(join(output, "answers", "b.status.json"));
	await spike.run({ reuseQueries: true });
	expect(JSON.parse(await readFile(join(output, "summary.json"), "utf8"))).toMatchObject({ noAnswer: 0 });
	const binary = await tools.binary("enola");
	await writeFile(binary, `#!/bin/sh\nprintf '%s' '${"x".repeat(3000)}' >&2\nexit 1\n`);
	vi.spyOn(tools, "binary").mockResolvedValue(binary);
	await expect(spike.run()).rejects.toEqual(new Error(`generate-cold exited 1: ${"x".repeat(2048)}`));
}, 60_000);

it("refuses missing spike arguments before opening a repository or fetching a tool", () => {
	const script = fileURLToPath(new URL("../src/enola-spike.ts", import.meta.url));
	const child = spawnSync(process.execPath, ["--conditions=@melian-agent/source", script], { encoding: "utf8" });
	expect(child.status).toBe(1);
	expect(child.stderr).toContain("Usage: enola-spike.ts <disposable-tree> <output>");
});

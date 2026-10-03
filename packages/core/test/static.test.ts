import { pathToFileURL } from "node:url";
import {
	CheckError,
	defaultConfig,
	type Finding,
	normaliseBiomeSarif,
	parseTscDiagnostics,
	resolveRange,
	staticFindings,
	staticSeverity,
	type ToolLog,
	type ToolResult,
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

const run = { root: "/work/tree", version: "2.5.15" };

function biomeResult(uri: string, ruleId = "lint/suspicious/noDebugger", level = "error") {
	return {
		ruleId,
		level,
		message: { text: "This is an unexpected use of the debugger statement." },
		locations: [
			{
				physicalLocation: {
					artifactLocation: { uri },
					region: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 10 },
				},
			},
		],
	};
}

describe("normaliseBiomeSarif", () => {
	it("makes Biome's absolute paths relative to the worktree, and records the version", () => {
		const sarif = JSON.stringify({
			version: "2.1.0",
			runs: [
				{
					tool: { driver: { name: "Biome", rules: [] } },
					results: [
						biomeResult("/work/tree/src/a b.ts"),
						biomeResult(pathToFileURL("/work/tree/src/c.ts").href, "lint/style/useConst", "warning"),
						biomeResult("/work/tree/node_modules/x/index.js"),
						biomeResult("/elsewhere/d.ts"),
					],
				},
			],
		});
		const log = normaliseBiomeSarif(sarif, run);
		expect(log.runs[0].tool.driver).toEqual({ name: "Biome", version: "2.5.15" });
		expect(
			log.runs[0].results.map((result) => [
				result.ruleId,
				result.level,
				result.locations[0]!.physicalLocation.artifactLocation.uri,
			]),
		).toEqual([
			["lint/suspicious/noDebugger", "error", "src/a%20b.ts"],
			["lint/style/useConst", "warning", "src/c.ts"],
		]);
		expect(log.runs[0].results[0]!.locations[0]!.physicalLocation.region).toEqual({
			startLine: 3,
			startColumn: 1,
			endLine: 3,
			endColumn: 10,
		});
	});

	it("throws invalidOutput for output that is not a SARIF log, never an empty result", () => {
		for (const output of ["", "not json", "{}", JSON.stringify({ runs: [{ results: [{ ruleId: "x" }] }] })]) {
			expect(() => normaliseBiomeSarif(output, run)).toThrow(CheckError);
		}
		try {
			normaliseBiomeSarif("{", run);
		} catch (error) {
			expect((error as CheckError).code).toBe("invalidOutput");
			expect((error as CheckError).check).toBe("static.biome");
		}
	});
});

describe("parseTscDiagnostics", () => {
	it("reads located and file-less diagnostics, joining indented continuation lines", () => {
		const output = [
			"src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
			"src/a.ts(5,14): error TS2322: Type '{ a: number; }' is not assignable to type '{ a: string; }'.",
			"  Types of property 'a' are incompatible.",
			"    Type 'number' is not assignable to type 'string'.",
			"../outside.ts(1,1): error TS1005: ';' expected.",
			"  dropped with its diagnostic",
			"/work/tree/node_modules/x/index.d.ts(2,3): error TS2307: Cannot find module 'y'.",
			"error TS5083: Cannot read file 'tsconfig.base.json'.",
			"",
		].join("\n");
		const log = parseTscDiagnostics(output, { ...run, version: "7.0.2", project: "tsconfig.json" });
		expect(log.runs[0].tool.driver).toEqual({ name: "tsc", version: "7.0.2" });
		const summary = log.runs[0].results.map((result: ToolResult) => ({
			rule: result.ruleId,
			uri: result.locations[0]!.physicalLocation.artifactLocation.uri,
			region: result.locations[0]!.physicalLocation.region,
			message: result.message.text,
		}));
		expect(summary).toEqual([
			{
				rule: "TS2322",
				uri: "src/a.ts",
				region: { startLine: 1, startColumn: 14 },
				message: "Type 'string' is not assignable to type 'number'.",
			},
			{
				rule: "TS2322",
				uri: "src/a.ts",
				region: { startLine: 5, startColumn: 14 },
				message:
					"Type '{ a: number; }' is not assignable to type '{ a: string; }'.\nTypes of property 'a' are incompatible.\nType 'number' is not assignable to type 'string'.",
			},
			{
				rule: "TS5083",
				uri: "tsconfig.json",
				region: { startLine: 1 },
				message: "Cannot read file 'tsconfig.base.json'.",
			},
		]);
	});
});

describe("staticSeverity", () => {
	it("maps Biome's levels and every tsc error, unless configuration overrides the rule", () => {
		expect(staticSeverity("biome", "biome/suspicious/noDebugger", "error", {})).toBe("P2");
		expect(staticSeverity("biome", "biome/style/useConst", "warning", {})).toBe("P3");
		expect(staticSeverity("biome", "biome/nursery/x", "note", {})).toBe("nit");
		expect(staticSeverity("tsc", "tsc/TS2322", "error", {})).toBe("P1");
		expect(staticSeverity("biome", "biome/style/useConst", "warning", { "biome/style/useConst": "P1" })).toBe("P1");
	});
});

describe("staticFindings", () => {
	let repo: string;

	beforeEach(() => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		repo = temporaryDirectory();
		gitIn(repo, "init", "--quiet", "--initial-branch=main");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		removeDirectory(repo);
	});

	function commit(files: Record<string, string>): string {
		writeFiles(repo, files);
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "commit");
		return gitIn(repo, "rev-parse", "HEAD");
	}

	function log(...results: [string, number, string][]): ToolLog {
		return {
			version: "2.1.0",
			runs: [
				{
					tool: { driver: { name: "tsc", version: "7.0.2" } },
					results: results.map(([uri, startLine, ruleId]) => ({
						ruleId,
						level: "error" as const,
						message: { text: `${ruleId} at ${uri}:${startLine}` },
						locations: [
							{ physicalLocation: { artifactLocation: { uri }, region: { startLine, startColumn: 1 } } },
						],
					})),
				},
			],
		};
	}

	function summary(findings: readonly Finding[]) {
		return findings.map((finding) => ({
			rule: finding.ruleId,
			line: finding.locations[0]!.physicalLocation.region.startLine,
			cause: finding.properties.cause,
			severity: finding.properties.severity,
		}));
	}

	it("matches results across revisions by identity, so a moved result stays pre-existing", async () => {
		const base = commit({ "a.ts": lines("const old = 1;", "const fixed = 2;") });
		// Two lines inserted above move `old` from line 1 to line 3; `fixed` is fixed; line 2 is new.
		const head = commit({
			"a.ts": lines("import x from 'x';", "const added = 3;", "const old = 1;", "const fixed = 2 as const;"),
		});
		const { revision } = await resolveRange(repo, `${base}..${head}`);
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
			source: { kind: "revision", commit: base },
			tool: "tsc",
			settings: defaultConfig.static.tsc,
			base: log(["a.ts", 1, "TS2322"], ["a.ts", 2, "TS2322"]),
			head: log(["a.ts", 2, "TS2322"], ["a.ts", 3, "TS2322"]),
		});
		expect(summary(findings)).toEqual([
			{ rule: "tsc/TS2322", line: 2, cause: "introduced", severity: "P1" },
			{ rule: "tsc/TS2322", line: 3, cause: "pre-existing", severity: "P1" },
		]);
		expect(findings[0]!.properties.trigger).toEqual({
			file: "a.ts",
			index: 0,
			snippet: "import x from 'x';\nconst added = 3;",
		});
		expect(findings[1]!.properties.trigger).toBeUndefined();
		expect(findings[0]!.properties.source).toEqual({ check: "static.tsc", version: "7.0.2" });
		expect(findings[0]!.locations[0]!.physicalLocation.region.snippet).toEqual({ text: "const added = 3;" });
	});

	it("merges results of one rule on the same lines into one finding, counting the rest", async () => {
		const base = commit({ "a.ts": lines("f(1, 2);") });
		const head = commit({ "a.ts": lines("f(1, 2);", "g(1, 2);") });
		const { revision } = await resolveRange(repo, `${base}..${head}`);
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
			source: { kind: "revision", commit: base },
			tool: "tsc",
			settings: defaultConfig.static.tsc,
			base: log(),
			head: log(["a.ts", 2, "TS2345"], ["a.ts", 2, "TS2345"], ["a.ts", 2, "TS2554"]),
		});
		expect(findings.map((finding) => [finding.ruleId, finding.message.text])).toEqual([
			["tsc/TS2345", "TS2345 at a.ts:2 (and 1 more on these lines)"],
			["tsc/TS2554", "TS2554 at a.ts:2"],
		]);
	});

	it("takes resolution from each path's configuration and severity overrides from the tool's settings", async () => {
		const base = commit({ "melian.yaml": lines("resolution:", "  P0: advisory"), "a.ts": lines("a") });
		const head = commit({ "a.ts": lines("b") });
		const { revision } = await resolveRange(repo, `${base}..${head}`);
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
			source: { kind: "revision", commit: base },
			tool: "tsc",
			settings: { ...defaultConfig.static.tsc, severity: { "tsc/TS2322": "P0" } },
			base: log(),
			head: log(["a.ts", 1, "TS2322"]),
		});
		expect(findings.map((finding) => [finding.properties.severity, finding.properties.resolution])).toEqual([
			["P0", "advisory"],
		]);
	});
});

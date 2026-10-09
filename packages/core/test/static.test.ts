import { pathToFileURL } from "node:url";
import {
	Changeset,
	CheckError,
	defaultConfig,
	type Finding,
	normaliseBiomeSarif,
	normaliseEnolaSarif,
	parseTscDiagnostics,
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
		const log = parseTscDiagnostics(output, {
			...run,
			version: "7.0.2",
			project: "tsconfig.json",
			exists: (path) => path === "src/a.ts",
		});
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

	it("takes the first location naming a file in the tree, so a quoted type cannot forge the path or rule", () => {
		const forged = `src/a.ts(1,14): error TS2322: Type '"(9,9): error TS6133: x"' is not assignable to type 'number'.`;
		const named = "src/b(1,1): error TS1: c.ts(2,3): error TS2304: Cannot find name 'y'.";
		const fileless = "error TS5083: Cannot read file 'x(1,1): error TS1: y'.";
		const log = parseTscDiagnostics([forged, named, fileless].join("\n"), {
			...run,
			project: "tsconfig.json",
			exists: (path) => path === "src/a.ts" || path === "src/b(1,1): error TS1: c.ts",
		});
		expect(
			log.runs[0].results.map((result: ToolResult) => [
				result.ruleId,
				decodeURIComponent(result.locations[0]!.physicalLocation.artifactLocation.uri),
				result.locations[0]!.physicalLocation.region,
			]),
		).toEqual([
			["TS2322", "src/a.ts", { startLine: 1, startColumn: 14 }],
			["TS2304", "src/b(1,1): error TS1: c.ts", { startLine: 2, startColumn: 3 }],
			["TS5083", "tsconfig.json", { startLine: 1 }],
		]);
	});
});

describe("staticSeverity", () => {
	it("maps Biome's levels and every tsc error, unless configuration overrides the rule", () => {
		expect(staticSeverity("biome", "biome/suspicious/noDebugger", "error", {})).toBe("P2");
		expect(staticSeverity("biome", "biome/style/useConst", "warning", {})).toBe("P3");
		expect(staticSeverity("biome", "biome/nursery/x", "note", {})).toBe("nit");
		expect(staticSeverity("tsc", "tsc/TS2322", "error", {})).toBe("P1");
		expect(staticSeverity("mutation", "mutation/untested-behaviour", "error", {})).toBe("P2");
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
		const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
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

	it("takes a result's own advice over the generic explanation, and keeps the generic one where it has none", async () => {
		const base = commit({ "a.ts": lines("export const a = 1;") });
		const head = commit({ "a.ts": lines("export const a = 1;", "export const b = a > 0;", "export const c = 2;") });
		const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
		const advised = log(["a.ts", 2, "untested-behaviour"], ["a.ts", 3, "TS2322"]);
		advised.runs[0].results[0]!.advice = { whyHere: "A mutant survived here.", whatToDo: "Test the comparison." };
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
			tool: "mutation",
			settings: defaultConfig.static.mutation,
			base: log(),
			head: advised,
		});
		expect(
			findings.map((finding) => [finding.ruleId, finding.properties.severity, finding.properties.explanation]),
		).toEqual([
			[
				"mutation/untested-behaviour",
				"P2",
				{
					what: "untested-behaviour at a.ts:2",
					whyHere: "A mutant survived here.",
					whatToDo: "Test the comparison.",
				},
			],
			[
				"mutation/TS2322",
				"P2",
				{
					what: "TS2322 at a.ts:3",
					whyHere: "mutation reports this at head but not at the base, so this change introduced it.",
					whatToDo: "Change the code so mutation no longer reports mutation/TS2322.",
				},
			],
		]);
		expect(findings[0]!.properties.source.check).toBe("static.mutation");
	});

	it("explains a pre-existing result as one the base has too, and keeps a pre-existing result's own advice", async () => {
		const base = commit({ "a.ts": lines("export const a: number = 'x';", "export const b: number = 'y';") });
		const head = commit({
			"a.ts": lines("export const a: number = 'x';", "export const b: number = 'y';", "export const c = 3;"),
		});
		const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
		const old = () => log(["a.ts", 1, "TS2322"], ["a.ts", 2, "TS2322"]);
		const before = old();
		before.runs[0].results[1]!.advice = { whyHere: "Own reason.", whatToDo: "Own fix." };
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
			tool: "tsc",
			settings: defaultConfig.static.tsc,
			base: before,
			head: before,
		});
		expect(findings.map((finding) => [finding.properties.cause, finding.properties.explanation])).toEqual([
			[
				"pre-existing",
				{
					what: "TS2322 at a.ts:1",
					whyHere: "tsc reports this at the base too, so it predates this change.",
					whatToDo: "Change the code so tsc no longer reports tsc/TS2322.",
				},
			],
			["pre-existing", { what: "TS2322 at a.ts:2", whyHere: "Own reason.", whatToDo: "Own fix." }],
		]);
	});

	it("identifies a renamed file's base results under its head path, so a pure rename introduces nothing", async () => {
		const base = commit({ "src/a.ts": lines("export const n: number = 'x';") });
		gitIn(repo, "mv", "src/a.ts", "src/b.ts");
		const head = commit({});
		const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
			tool: "tsc",
			settings: defaultConfig.static.tsc,
			base: log(["src/a.ts", 1, "TS2322"]),
			head: log(["src/b.ts", 1, "TS2322"]),
		});
		expect(findings.map((finding) => [finding.properties.path, finding.properties.cause])).toEqual([
			["src/b.ts", "pre-existing"],
		]);
	});

	it("merges results of one rule on the same lines into one finding, counting the rest", async () => {
		const base = commit({ "a.ts": lines("f(1, 2);") });
		const head = commit({ "a.ts": lines("f(1, 2);", "g(1, 2);") });
		const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
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

	function enolaLog(...messages: string[]): ToolLog {
		return normaliseEnolaSarif(
			JSON.stringify({
				version: "2.1.0",
				runs: [
					{ results: messages.map((text) => ({ ruleId: "intent-unmet", level: "error", message: { text } })) },
				],
			}),
			{ root: repo, version: "0.4.27" },
		);
	}

	async function enolaCauses(baseMessages: string[], headMessages: string[]) {
		const intent = lines("rules:", "  - a");
		const base = commit({ "enola-intent.yaml": intent, "a.ts": lines("1") });
		const head = commit({ "a.ts": lines("2") });
		const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
			tool: "enola",
			settings: defaultConfig.static.enola,
			base: enolaLog(...baseMessages),
			head: enolaLog(...headMessages),
		});
		return findings.map((finding) => [finding.message.text, finding.properties.cause]);
	}

	it("identifies an unlocated Enola result by its message though the intent file has code on line 1", async () => {
		expect(await enolaCauses(["intent A unmet"], ["intent B unmet"])).toEqual([["intent B unmet", "introduced"]]);
	});

	it("keeps the same unlocated Enola result pre-existing", async () => {
		expect(await enolaCauses(["intent A unmet"], ["intent A unmet"])).toEqual([["intent A unmet", "pre-existing"]]);
	});

	it("identifies a located Enola result at the intent file's first line by its code, not its message", async () => {
		const base = commit({ "enola-intent.yaml": lines("rules:", "  - a") });
		const head = commit({ "a.ts": lines("2") });
		const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
		const located = (text: string): ToolLog => {
			const one = enolaLog(text);
			const result = one.runs[0].results[0]!;
			const place = result.locations[0]!.physicalLocation;
			return {
				...one,
				runs: [
					{
						...one.runs[0],
						results: [
							{
								...result,
								locations: [{ physicalLocation: { ...place, region: { startLine: 1, startColumn: 1 } } }],
							},
						],
					},
				],
			};
		};
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
			tool: "enola",
			settings: defaultConfig.static.enola,
			base: located("message one"),
			head: located("message two"),
		});
		expect(findings.map((finding) => finding.properties.cause)).toEqual(["pre-existing"]);
	});

	it("fails rather than guess when a result's file cannot be read", async () => {
		const base = commit({ "src/a.ts": lines("a") });
		const head = commit({ "src/a.ts": lines("b") });
		const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
		const error = await staticFindings({
			repoRoot: repo,
			revision,
			tool: "tsc",
			settings: defaultConfig.static.tsc,
			base: log(),
			head: log(["src", 1, "TS2307"]),
		}).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(CheckError);
		expect((error as CheckError).code).toBe("unreadable");
	});

	it("reports a second result added beside an old one on the same lines as introduced", async () => {
		const base = commit({ "a.ts": lines("f(1, 2);") });
		const head = commit({ "a.ts": lines("f(1, 2);", "") });
		const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
			tool: "tsc",
			settings: defaultConfig.static.tsc,
			base: log(["a.ts", 1, "TS2345"]),
			head: log(["a.ts", 1, "TS2345"], ["a.ts", 1, "TS2345"]),
		});
		expect(findings.map((finding) => [finding.properties.cause, finding.message.text])).toEqual([
			["pre-existing", "TS2345 at a.ts:1"],
			["introduced", "1 more tsc/TS2345 result(s) on these lines than at the base: TS2345 at a.ts:1"],
		]);
	});

	it("takes severity overrides from the tool's settings, and stores no resolution", async () => {
		const base = commit({ "melian.yaml": lines("resolution:", "  P0: advisory"), "a.ts": lines("a") });
		const head = commit({ "a.ts": lines("b") });
		const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
		const { findings } = await staticFindings({
			repoRoot: repo,
			revision,
			tool: "tsc",
			settings: { ...defaultConfig.static.tsc, severity: { "tsc/TS2322": "P0" } },
			base: log(),
			head: log(["a.ts", 1, "TS2322"]),
		});
		expect(findings.map((finding) => [finding.properties.severity, finding.properties.resolution])).toEqual([
			["P0", undefined],
		]);
	});
});

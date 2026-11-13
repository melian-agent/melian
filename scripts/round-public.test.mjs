import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RoundComment } from "./round.mjs";

const script = fileURLToPath(new URL("./round-comment.mjs", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/round-probe-verdict.json", import.meta.url));
const token = "sk-probe-SECRET-123";
// What Biome printed on the probe's run, where a head biome.json extended a file outside the checkout.
const printed = readFileSync(probe, "utf8").match(/biome exited[^"]*/)[0];
const base = "b".repeat(40);
const head = "0123456789abcdef0123456789abcdef01234567";
const mergeBase = "e".repeat(40);
const scratch = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(name, text) {
	const dir = mkdtempSync(join(tmpdir(), "round-public-"));
	scratch.push(dir);
	writeFileSync(join(dir, name), text);
	return join(dir, name);
}

const staticFinding = {
	ruleId: "parse",
	message: { text: `biome.json does not parse: ${printed}` },
	locations: [
		{
			physicalLocation: {
				artifactLocation: { uri: "biome.json" },
				region: { startLine: 1, snippet: { text: token } },
			},
		},
	],
	properties: {
		id: "aaaaaaaaaaaaaaaa",
		path: "biome.json",
		severity: "P1",
		resolution: "block",
		explanation: { what: token },
		source: { check: "static.biome", version: "2.5.15" },
	},
};
const verdict = {
	status: "findings",
	blocking: true,
	findings: { block: [staticFinding], acknowledge: [], advisory: [staticFinding], silent: [] },
	dismissed: [staticFinding],
	notRun: [
		{ name: "static.biome", status: "failed", reason: printed, error: printed },
		{ name: "lens.tests", status: "provisional", level: "deep", reason: printed },
	],
	ran: [{ name: "static.tsc", status: "ran", version: printed }],
	telemetry: { stages: [{ subject: "static.biome", error: printed }] },
};
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("what of a round leaves the job", () => {
	it("keeps the text a static tool printed out of the public verdict", () => {
		const published = run("--public", file("verdict.json", JSON.stringify(verdict)));
		expect([published.status, published.stderr]).toEqual([0, ""]);
		expect(published.stdout).not.toContain(token);
		expect(JSON.parse(published.stdout)).toEqual({
			status: "findings",
			blocking: true,
			findings: {
				block: [
					{
						ruleId: "parse",
						message: { text: "A static check's finding; a local run shows its text." },
						locations: [{ physicalLocation: { region: { startLine: 1 } } }],
						properties: {
							id: "aaaaaaaaaaaaaaaa",
							path: "biome.json",
							severity: "P1",
							resolution: "block",
							source: { check: "static.biome" },
						},
					},
				],
				acknowledge: [],
			},
			notRun: [
				{ name: "static.biome", status: "failed" },
				{ name: "lens.tests", status: "provisional" },
			],
			ran: [{ name: "static.tsc", status: "ran" }],
		});
	});

	it("keeps a check's route, a finding with no place, and nothing that is not a verdict's own field", () => {
		const lineage = {
			model: "anthropic/claude-opus-5-5",
			wanted: "openai-codex/gpt-5.6-sol",
			by: "derived",
			outside: false,
		};
		const lens = {
			ruleId: "rule-a",
			message: { text: "A defect" },
			locations: [],
			properties: {
				id: "bbbbbbbbbbbbbbbb",
				path: "src/a.ts",
				severity: "P2",
				resolution: "acknowledge",
				source: { check: "lens.tests" },
			},
		};
		const value = {
			status: "clean",
			blocking: "no",
			findings: { block: [], acknowledge: [lens] },
			notRun: [{ name: "lens.a", status: "failed", lineage }],
			ran: [{ name: "lens.design", status: "ran", lineage, reason: token }],
		};
		const published = run("--public", file("verdict.json", JSON.stringify(value)));
		expect(JSON.parse(published.stdout)).toStrictEqual({
			findings: {
				block: [],
				acknowledge: [{ ...lens, properties: { ...lens.properties, source: { check: "lens.tests" } } }],
			},
			notRun: [{ name: "lens.a", status: "failed", lineage }],
			ran: [{ name: "lens.design", status: "ran", lineage }],
		});
	});

	it("keeps a lens finding's explanation, failure scenario and fix, and withholds a static finding's", () => {
		const lens = {
			ruleId: "stale-cache",
			message: { text: "The cache key omits policy" },
			locations: [{ physicalLocation: { region: { startLine: 4 } } }],
			properties: {
				id: "cccccccccccccccc",
				path: "src/cache.ts",
				severity: "P1",
				resolution: "block",
				explanation: {
					what: "The cache key omits policy",
					whyHere: "This change adds policy",
					whatToDo: "Key by policy",
				},
				failureScenario: "A policy change reuses the old verdict",
				source: { check: "lens.correctness" },
			},
		};
		const staticFinding = {
			...lens,
			properties: {
				...lens.properties,
				id: "dddddddddddddddd",
				explanation: { what: token, whyHere: token, whatToDo: token },
				failureScenario: token,
				source: { check: "static.biome" },
			},
		};
		const value = {
			status: "findings",
			blocking: true,
			findings: { block: [lens, staticFinding], acknowledge: [] },
			notRun: [],
		};
		const published = run("--public", file("verdict.json", JSON.stringify(value)));
		expect(published.stdout).not.toContain(token);
		const [kept, withheld] = JSON.parse(published.stdout).findings.block;
		expect(kept.properties).toStrictEqual({
			id: "cccccccccccccccc",
			severity: "P1",
			resolution: "block",
			path: "src/cache.ts",
			source: { check: "lens.correctness" },
			explanation: { whyHere: "This change adds policy", whatToDo: "Key by policy" },
			failureScenario: "A policy change reuses the old verdict",
		});
		expect(withheld.properties).toStrictEqual({
			id: "dddddddddddddddd",
			severity: "P1",
			resolution: "block",
			path: "src/cache.ts",
			source: { check: "static.biome" },
		});
		const body = RoundComment.read({
			verdict: file("verdict.json", JSON.stringify(value)),
			rounds: file("rounds.json", JSON.stringify([{ base: mergeBase, head }])),
			exitCode: "1",
			runUrl: "https://example.test/run",
			runId: "1",
			nonce: "0123456789abcdef0123456789abcdef",
			base,
			head,
			mergeBase,
			current: { base, head },
		}).body();
		expect(body).not.toContain(token);
		expect(body).toContain(
			[
				"  P1 block  src/cache.ts:4  lens.correctness  stale-cache  cccccccccccccccc  The cache key omits policy",
				"    Why here: This change adds policy",
				"    Failure scenario: A policy change reuses the old verdict",
				"    What to do: Key by policy",
				"  P1 block  src/cache.ts:4  static.biome  stale-cache  dddddddddddddddd  A static check's finding; a local run shows its text.",
				"",
			].join("\n"),
		);
	});

	it("keeps the probe's own output out of the public verdict, and reads it as no verdict", () => {
		expect(readFileSync(probe, "utf8")).toContain(token);
		const published = run("--public", probe);
		expect([published.status, published.stdout, published.stderr]).toEqual([0, "null\n", ""]);
		const absent = run("--public", join(tmpdir(), "round-public-absent", "verdict.json"));
		expect([absent.status, absent.stdout, absent.stderr]).toEqual([0, "null\n", ""]);
	});

	it("keeps the text a static tool printed out of the comment, whatever verdict file it reads", () => {
		const body = RoundComment.read({
			verdict: file("verdict.json", JSON.stringify(verdict)),
			rounds: file("rounds.json", JSON.stringify([{ base: mergeBase, head }])),
			exitCode: "1",
			runUrl: "https://example.test/run",
			runId: "1",
			nonce: "0123456789abcdef0123456789abcdef",
			base,
			head,
			mergeBase,
			current: { base, head },
		}).body();
		expect(body).not.toContain(token);
		expect(body).toContain("  static.biome  failed\n");
		expect(body).toContain("A local run of melian review shows why each check did not run.");
	});
});

describe("a round's spend in the public verdict", () => {
	const passed = { status: "passed", blocking: false, findings: { block: [], acknowledge: [] }, notRun: [] };
	// Telemetry as `melian review --json` writes it beside the verdict, with text a model or a tool could have shaped.
	const telemetry = (
		total = { totalTokens: 5644300, cost: { total: 4.44 } },
		prepare = { startedAt: 1_000, endedAt: 573_400 },
	) => ({
		revision: token,
		stages: [{ id: "s1", name: "melian.lens", subject: token, note: printed, durationMs: 5 }],
		total: { total, requests: [{ model: token, reasoning: { sent: token } }] },
		usageUnavailable: [token],
		prepare: { ...prepare, spans: [{ name: token, startedAt: 1, endedAt: 2, durationMs: 1 }] },
		untimed: [],
	});
	const published = (value) => {
		const result = run("--public", file("verdict.json", JSON.stringify(value)));
		expect([result.status, result.stderr]).toEqual([0, ""]);
		return result.stdout;
	};

	it("keeps a round's duration, tokens and cost as three numbers, and nothing else of its telemetry", () => {
		const stdout = published({ ...passed, telemetry: telemetry() });
		expect(stdout).not.toContain(token);
		expect(stdout).not.toContain(printed);
		expect(JSON.parse(stdout)).toStrictEqual({ ...passed, spend: { seconds: 572, tokens: 5644300, cost: 4.44 } });
	});

	it.each([
		[
			"tokens as a string",
			{ totalTokens: "5644300", cost: { total: 4.44 } },
			undefined,
			{ seconds: 572, cost: 4.44 },
		],
		["a negative cost", { totalTokens: 5644300, cost: { total: -1 } }, undefined, { seconds: 572, tokens: 5644300 }],
		[
			"a cost written as null, as JSON writes NaN",
			{ totalTokens: 5644300, cost: { total: null } },
			undefined,
			{ seconds: 572, tokens: 5644300 },
		],
		[
			"tokens past any finite number",
			{ totalTokens: "1e309", cost: { total: 4.44 } },
			undefined,
			{ seconds: 572, cost: 4.44 },
		],
		[
			"a clock that ran backwards",
			undefined,
			{ startedAt: 573_400, endedAt: 1_000 },
			{ tokens: 5644300, cost: 4.44 },
		],
		["no start", undefined, { endedAt: 573_400 }, { tokens: 5644300, cost: 4.44 }],
		["no cost", { totalTokens: 5644300 }, undefined, { seconds: 572, tokens: 5644300 }],
	])("leaves out %s and keeps the rest", (_name, total, prepare, spend) => {
		const value = { ...passed, telemetry: telemetry(total, prepare) };
		const text = JSON.stringify(value).replace('"1e309"', "1e309");
		const result = run("--public", file("verdict.json", text));
		expect(JSON.parse(result.stdout)).toStrictEqual({ ...passed, spend });
	});

	it("keeps a zero, as a round that ran nothing new costs nothing", () => {
		const value = {
			...passed,
			telemetry: telemetry({ totalTokens: 0, cost: { total: 0 } }, { startedAt: 7, endedAt: 7 }),
		};
		expect(JSON.parse(published(value))).toStrictEqual({ ...passed, spend: { seconds: 0, tokens: 0, cost: 0 } });
	});

	it.each([
		["telemetry", null],
		["its total and its preparation", { total: null, prepare: null }],
		["the total inside its total", { total: { total: null } }],
	])("keeps the verdict and leaves out the spend when %s is null", (_name, value) => {
		expect(JSON.parse(published({ ...passed, telemetry: value }))).toStrictEqual(passed);
	});

	it("leaves out the spend whole when the telemetry holds none of the three", () => {
		expect(
			JSON.parse(published({ ...passed, telemetry: { revision: "r", stages: [], usageUnavailable: [] } })),
		).toStrictEqual(passed);
		expect(JSON.parse(published(passed))).toStrictEqual(passed);
	});

	it("keeps the spend through a second pass over the public verdict, and refuses there what it refuses at first", () => {
		const once = published({ ...passed, telemetry: telemetry() });
		expect(JSON.parse(published(JSON.parse(once)))).toStrictEqual(JSON.parse(once));
		expect(
			JSON.parse(published({ ...passed, spend: { seconds: -5, tokens: "12", cost: 1.5, note: token } })),
		).toStrictEqual({ ...passed, spend: { cost: 1.5 } });
	});

	it("prints the spend on one line after the verdict line, and no line when there is none", () => {
		const comment = (value) =>
			RoundComment.read({
				verdict: file("verdict.json", JSON.stringify(value)),
				rounds: file("rounds.json", JSON.stringify([{ base: mergeBase, head }])),
				exitCode: "0",
				runUrl: "https://example.test/run",
				runId: "1",
				nonce: "0123456789abcdef0123456789abcdef",
				base,
				head,
				mergeBase,
				current: { base, head },
			}).body();
		const lines = (body) => body.split("\n").slice(4, 7);
		expect(lines(comment({ ...passed, telemetry: telemetry() }))).toEqual([
			"Verdict: passed",
			"Spend: 572 s, 5644300 tokens, $4.44",
			"",
		]);
		expect(lines(comment({ ...passed, telemetry: telemetry({ totalTokens: 12 }) }))).toEqual([
			"Verdict: passed",
			"Spend: 572 s, 12 tokens",
			"",
		]);
		expect(lines(comment({ ...passed, telemetry: telemetry({ cost: { total: 4.44 } }, { endedAt: 9 }) }))).toEqual([
			"Verdict: passed",
			"Spend: $4.44",
			"",
		]);
		expect(lines(comment(passed))).toEqual(["Verdict: passed", "", "No findings above advisory."]);
	});
});

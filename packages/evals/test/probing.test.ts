import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, Finding, Lens } from "@melian-agent/core";
import {
	buildGoldenRepository,
	foundMiss,
	type Golden,
	loadGoldens,
	loadMisses,
	type Miss,
	measureProbing,
	parseCombinations,
	reviewMiss,
	routedProbing,
	runGolden,
} from "@melian-agent/evals";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	unconfinedSandbox,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let scratch: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "melian-probing-eval-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const golden = (name: string) => loadGoldens().find((each) => each.name === name)!;

describe("MELIAN_EVAL_PROBE_ROUTES", () => {
	it("reads planner and prober pairs, and a model alone as the level without probes", () => {
		expect(parseCombinations("same=a/x>a/x; cross=a/x>b/y ;off=b/y")).toEqual([
			{ label: "same", routes: { planner: "a/x", prober: "a/x" } },
			{ label: "cross", routes: { planner: "a/x", prober: "b/y" } },
			{ label: "off", routes: { planner: "b/y" } },
		]);
	});

	it.each([
		[undefined, "names no combination"],
		[" ; ", "names no combination"],
		["same=ax>a/x", 'entry "same=ax>a/x" is not'],
		["same=a/x>b", 'entry "same=a/x>b" is not'],
		["Same=a/x", 'entry "Same=a/x" is not'],
		["same=a/x;same=b/y", "names same twice"],
	])("refuses %s", (text, problem) => {
		expect(() => parseCombinations(text)).toThrow(problem);
	});
});

describe("routedProbing", () => {
	it("moves each level that probes to a prober on medium, and routes heavy and medium", async () => {
		const lenses = await Lens.builtins();
		const routed = routedProbing(lenses, defaultConfig, { planner: "a/plan", prober: "b/probe" });
		const trust = routed.lenses.find((lens) => lens.name === "trust-boundary")!;
		expect(trust.level("deep").probe).toEqual({ prober: "medium" });
		expect(trust.level("careful")).not.toHaveProperty("probe");
		expect(routed.config.models.heavy).toEqual({ model: "a/plan" });
		expect(routed.config.models.medium).toEqual({ model: "b/probe" });
	});

	it("drops every probe for the level without probes, and leaves medium as it was", async () => {
		const routed = routedProbing(await Lens.builtins(), defaultConfig, { planner: "a/plan" });
		const trust = routed.lenses.find((lens) => lens.name === "trust-boundary")!;
		expect(trust.level("deep")).not.toHaveProperty("probe");
		expect(routed.config.models.heavy).toEqual({ model: "a/plan" });
		expect(routed.config.models.medium).toEqual(defaultConfig.models.medium);
	});
});

describe("misses", () => {
	const miss: Miss = { name: "m", repo: "/r", base: "a", head: "b", file: "src/a.ts", rule: "path-traversal" };

	it("reads a misses file and refuses one missing a field, naming where", () => {
		const good = join(scratch, "good.json");
		writeFileSync(good, JSON.stringify([miss]));
		expect(loadMisses(good)).toEqual([miss]);
		const bad = join(scratch, "bad.json");
		writeFileSync(bad, JSON.stringify([{ ...miss, rule: undefined }]));
		expect(() => loadMisses(bad)).toThrow(`${bad}: /0`);
		writeFileSync(bad, "[]");
		expect(() => loadMisses(bad)).toThrow(`${bad}: (root)`);
	});

	const finding = (overrides: { path?: string; rule?: string; check?: string; verdict?: "refuted" | "confirmed" }) =>
		Finding.create({
			rule: overrides.rule ?? "path-traversal",
			message: "m",
			file: overrides.path ?? "src/a.ts",
			startLine: 1,
			snippet: "x",
			occurrence: 0,
			cause: "introduced",
			severity: "P1",
			explanation: { what: "w", whyHere: "y", whatToDo: "d" },
			source: { check: overrides.check ?? "lens.trust-boundary", version: "v@deep" },
		}).verifiedAs(
			overrides.verdict === undefined
				? { verdict: "confirmed", reason: "r", executor: "llm", model: "a/b", version: "1" }
				: { verdict: overrides.verdict, reason: "r", executor: "llm", model: "a/b", version: "1" },
		);

	it("finds a miss only at its file, under its rule, from trust-boundary, and unrefuted", () => {
		expect(foundMiss(miss, [finding({})])).toBe(true);
		expect(foundMiss(miss, [finding({ path: "src/b.ts" })])).toBe(false);
		expect(foundMiss(miss, [finding({ rule: "fail-open" })])).toBe(false);
		expect(foundMiss(miss, [finding({ check: "lens.correctness" })])).toBe(false);
		expect(foundMiss(miss, [finding({ verdict: "refuted" })])).toBe(false);
		expect(foundMiss(miss, [finding({ path: "src/b.ts" }), finding({})])).toBe(true);
	});
});

describe("measureProbing", { timeout: 60_000 }, () => {
	it("totals each combination's goldens, misses and spend over its passes, and counts a review that throws", async () => {
		const lost = golden("trust-boundary-probe-claim-lost-release");
		const clean = golden("trust-boundary-probe-claim-lost-release-clean");
		const scripted = {
			lost: await runGolden(lost, { kind: "scripted" }),
			clean: await runGolden(clean, { kind: "scripted" }),
		};
		const miss: Miss = { name: "m", repo: "/r", base: "a", head: "b", file: "src/a.ts", rule: "path-traversal" };
		const lines: string[] = [];
		let calls = 0;
		const results = await measureProbing(
			parseCombinations("probing=a/x>b/y;off=a/x"),
			[lost, clean],
			[miss],
			2,
			{
				golden: async (each: Golden, routes) => {
					calls++;
					if (routes.prober === undefined && each === clean) throw new Error("provider down");
					return { ...(each === lost ? scripted.lost : scripted.clean), milliseconds: 10 };
				},
				miss: async () => ({ findings: scripted.lost.findings, tokens: 5, cost: 0.5, milliseconds: 7 }),
			},
			(line) => lines.push(line),
		);
		expect(calls).toBe(8);
		expect(results.map(({ label, goldens, misses, passes }) => ({ label, goldens, misses, passes }))).toEqual([
			{
				label: "probing",
				passes: 2,
				goldens: { precision: 1, recall: 1, failed: 0 },
				misses: { found: 0, total: 2, recall: 0, failed: 0 },
			},
			{
				label: "off",
				passes: 2,
				goldens: { precision: 1, recall: 1, failed: 2 },
				misses: { found: 0, total: 2, recall: 0, failed: 0 },
			},
		]);
		expect(results[0]!.milliseconds).toBe(4 * 10 + 2 * 7);
		const tokens = (run: typeof scripted.lost) => run.telemetry.total?.total.totalTokens ?? 0;
		expect(results[0]!.tokens).toBe(2 * (tokens(scripted.lost) + tokens(scripted.clean)) + 2 * 5);
		expect(lines).toContain(
			"off pass 1 trust-boundary-probe-claim-lost-release-clean: no score (Error: provider down)",
		);
		expect(lines.at(-1)).toMatch(
			/^off \(a\/x planning, no probes probing\): goldens precision 1\.00, recall 1\.00; misses recall 0\.00 \(0 of 2\); .* 2 failed$/,
		);
	});
});

describe("reviewMiss", { timeout: 60_000 }, () => {
	it("reviews a range with trust-boundary alone at its level that probes, on the combination's routes", async () => {
		const { repo, base } = buildGoldenRepository(golden("trust-boundary-probe-claim-lost-release"));
		try {
			const fake = createFakeModels({ models: [{ id: "plan" }, { id: "probe" }] });
			const seen: string[] = [];
			const reply = (text: string) => (_: unknown, model: string) => {
				seen.push(model);
				return fauxAssistantMessage(text);
			};
			const empty = (_: unknown, model: string) => {
				seen.push(model);
				return fauxAssistantMessage([fauxToolCall("record_plan", { attacks: [] })], { stopReason: "toolUse" });
			};
			scriptConversations(fake, [
				{ match: "Your role at this level: the attack planner", replies: [empty, reply("Planned 0.")] },
			]);
			const run = await reviewMiss(
				{ name: "m", repo, base, head: "feature", file: ".github/workflows/claim.yml", rule: "fail-open" },
				fake.review,
				{ planner: `${fake.ref("plan").provider}/plan`, prober: `${fake.ref("probe").provider}/probe` },
				undefined,
				unconfinedSandbox(),
			);
			expect(seen).toEqual(["plan", "plan"]);
			expect(run.findings).toEqual([]);
			expect(run.milliseconds).toBeGreaterThanOrEqual(0);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("probing-live.ts", () => {
	const live = fileURLToPath(new URL("../src/probing-live.ts", import.meta.url));
	const run = (env: Record<string, string>) =>
		spawnSync(process.execPath, ["--conditions=@melian-agent/source", live], {
			env: { PATH: process.env.PATH, HOME: scratch, ...env },
			encoding: "utf8",
		});

	it("exits 2 before any provider without MELIAN_EVAL_LIVE, and for a malformed combination or pass count", () => {
		expect(run({}).status).toBe(2);
		const routes = run({ MELIAN_EVAL_LIVE: "1", MELIAN_EVAL_PROBE_ROUTES: "same" });
		expect(routes.status).toBe(2);
		expect(routes.stderr).toContain('entry "same" is not');
		const passes = run({
			MELIAN_EVAL_LIVE: "1",
			MELIAN_EVAL_PROBE_ROUTES: "same=a/x",
			MELIAN_EVAL_PROBE_PASSES: "0",
		});
		expect(passes.status).toBe(2);
		expect(passes.stderr).toContain("MELIAN_EVAL_PROBE_PASSES must be a whole number of 1 or more");
		const golden = run({
			MELIAN_EVAL_LIVE: "1",
			MELIAN_EVAL_PROBE_ROUTES: "same=a/x",
			MELIAN_EVAL_GOLDEN: "clean-rename",
		});
		expect(golden.status).toBe(2);
		expect(golden.stderr).toContain("No golden is named clean-rename");
	}, 60_000);
});

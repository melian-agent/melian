import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, Finding, Lens, type MelianConfig } from "@melian-agent/core";
import { StageTelemetry, TokenUsage } from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildGoldenRepository,
	type Golden,
	type GoldenRun,
	loadGoldens,
	type RangeRun,
	runGolden,
	runRange,
	scoreGolden,
} from "../src/goldens.ts";
import {
	Miss,
	measureProbing,
	ProbeTrust,
	ProbingCombination,
	type ProbingRunners,
	ProbingSettings,
} from "../src/probing.ts";
import { GoldenRunError } from "../src/run-error.ts";

let scratch: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "melian-probing-eval-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const all = loadGoldens();
const golden = (name: string) => all.find((each) => each.name === name)!;
const lost = golden("trust-boundary-probe-claim-lost-release");
const clean = golden("trust-boundary-probe-claim-lost-release-clean");
const env = {
	MELIAN_EVAL_PROBE_ROUTES: "pair=a/plan>b/probe",
	MELIAN_EVAL_VERIFIER_MODEL: "c/verify",
	MELIAN_EVAL_GOLDEN: "",
} as const;
const sha = "a".repeat(40);

const paid = new StageTelemetry("base..head", [
	{
		id: "lens",
		task: 1,
		name: "melian.lens",
		subject: "lens",
		outcome: "completed",
		timing: "unavailable",
		reused: false,
		resumed: false,
		usage: new TokenUsage({
			model: {
				input: 2,
				output: 3,
				cacheRead: 4,
				cacheWrite: 5,
				totalTokens: 14,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			},
		}).toJSON(),
	},
]);

function ran(findings: readonly Finding[], fields: Partial<RangeRun> = {}): RangeRun {
	return {
		telemetry: paid,
		findings,
		rendered: "rendered review\n",
		toolMismatches: [],
		notes: [],
		tiers: {},
		...fields,
	};
}

function runners(fields: Partial<ProbingRunners> = {}): ProbingRunners {
	return {
		availability: vi.fn(async () => ({ available: true }) as const),
		models: vi.fn(async () => createFakeModels({ models: [{ id: "x" }] }).review),
		goldens: () => [lost, clean, golden("trust-boundary-fail-open")],
		golden: vi.fn(async (each: Golden) => ({ golden: each, ...ran([]) }) as GoldenRun),
		range: vi.fn(async () => ran([])),
		...fields,
	};
}

async function measure(settings: NodeJS.ProcessEnv, using: ProbingRunners = runners()) {
	const lines: string[] = [];
	const errors: string[] = [];
	const status = await measureProbing(
		settings,
		using,
		(line) => lines.push(line),
		(line) => errors.push(line),
	);
	return { status, lines, errors };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	}).trim();
}

function missesFile(misses: readonly Record<string, string>[]): string {
	const path = join(scratch, "misses.json");
	writeFileSync(path, JSON.stringify(misses));
	return path;
}

describe("ProbingCombination", () => {
	it("reads a planner and prober pair, and a model alone as the level without probes, as core reads a model", () => {
		const pair = ProbingCombination.parse(" pair = openrouter/anthropic/claude > openai-codex/gpt ", "medium");
		expect(pair.toJSON()).toEqual({
			label: "pair",
			planner: "openrouter/anthropic/claude",
			prober: "openai-codex/gpt",
			proberTier: "medium",
		});
		expect(pair.probes).toBe(true);
		const off = ProbingCombination.parse("off=openai-codex/gpt", "light");
		expect(off.toJSON()).toEqual({ label: "off", planner: "openai-codex/gpt" });
		expect(off.probes).toBe(false);
	});

	it("refuses a third model, a model ID that holds the separator, a bad label, and a model without a provider", () => {
		expect(() => ProbingCombination.parse("x=a/b>c/d>e/f", "medium")).toThrow(/more than two models/);
		expect(() => ProbingCombination.parse("x=a/b>c", "medium")).toThrow(/provider\/model/);
		expect(() => ProbingCombination.parse("X=a/b", "medium")).toThrow(/invalid entry/);
		expect(() => ProbingCombination.parse("=a/b", "medium")).toThrow(/invalid entry/);
		expect(() => ProbingCombination.parse("x=", "medium")).toThrow(/invalid entry/);
	});

	const config: MelianConfig = {
		...defaultConfig,
		models: {
			heavy: { model: "h/heavy", thinking: "high", fallbacks: ["h/other"] },
			medium: { model: "m/medium", thinking: "low" },
			light: { model: "l/light" },
		},
		lenses: { "trust-boundary": { level: { floor: "deep" } } },
	};
	const lenses = async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			return await Lens.load(repo, { kind: "revision", commit: base }, ["src/a.ts"]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	};

	it("routes the planner as trust-boundary's own route and the prober on its tier, each at its tier's reasoning", async () => {
		const loaded = await lenses();
		const routed = ProbingCombination.parse("pair=a/plan>b/probe", "medium").routed(config, loaded);
		expect(routed.config.lenses["trust-boundary"]).toEqual({
			level: { floor: "deep" },
			route: { model: "a/plan", thinking: "high" },
		});
		expect(routed.config.models).toEqual({ ...config.models, medium: { model: "b/probe", thinking: "low" } });
		const boundary = routed.lenses.find((lens) => lens.name === "trust-boundary")!;
		expect(boundary.level("deep").probe).toEqual({ prober: "medium" });
		expect(boundary.level("careful").probe).toBeUndefined();
		const others = (lensSet: readonly Lens[]) => lensSet.filter((lens) => lens.name !== "trust-boundary");
		expect(others(routed.lenses)).toEqual(others(loaded));
		const light = ProbingCombination.parse("pair=a/plan>b/probe", "light").routed(config, loaded);
		expect(light.config.models.light).toEqual({ model: "b/probe" });
		expect(light.config.models.medium).toEqual(config.models.medium);
	});

	it("probes trust-boundary's deep level when its lens declares no probe there", async () => {
		const loaded = (await lenses()).map((lens) => {
			if (lens.name !== "trust-boundary") return lens;
			const { probe: _, ...deep } = lens.level("deep");
			return Lens.from({ ...lens.toJSON(), levels: { ...lens.levels, deep } });
		});
		const routed = ProbingCombination.parse("pair=a/plan>b/probe", "heavy").routed(config, loaded);
		expect(routed.lenses.find((lens) => lens.name === "trust-boundary")!.level("deep").probe).toEqual({
			prober: "heavy",
		});
	});

	it("drops every probe for the level without probes, and leaves the tiers as they were", async () => {
		const routed = ProbingCombination.parse("off=a/plan", "medium").routed(
			{ ...config, lenses: {}, models: { medium: { model: "m/medium" } } },
			await lenses(),
		);
		expect(routed.config.models).toEqual({ medium: { model: "m/medium" } });
		expect(routed.config.lenses["trust-boundary"]).toEqual({ route: { model: "a/plan" } });
		const boundary = routed.lenses.find((lens) => lens.name === "trust-boundary")!;
		expect(Object.values(boundary.levels).map((level) => level?.probe)).toEqual([undefined, undefined, undefined]);
	});
});

describe("ProbeTrust", () => {
	it("vouches for exactly the full commit IDs it names", () => {
		const long = "b".repeat(64);
		const trust = ProbeTrust.parse(` ${sha} ,${long},`);
		expect(trust.vouches(sha)).toBe(true);
		expect(trust.vouches(long)).toBe(true);
		expect(trust.vouches("c".repeat(40))).toBe(false);
		expect(ProbeTrust.parse().vouches(sha)).toBe(false);
		expect(() => ProbeTrust.parse(sha.slice(0, 39))).toThrow(/full commit IDs; invalid entry "a{39}"/);
		expect(() => ProbeTrust.parse(`${sha}0`)).toThrow(/full commit IDs/);
		expect(() => ProbeTrust.parse("A".repeat(40))).toThrow(/full commit IDs/);
	});
});

describe("Miss", () => {
	const fields = { name: "m", repo: "/r", base: "b", head: "h", file: "f.ts", rule: "fail-open" };

	it("reads a misses file and refuses one missing a field or with an extra one", () => {
		expect(Miss.load(missesFile([fields])).map((miss) => ({ ...miss }))).toEqual([fields]);
		const { rule: _, ...missing } = fields;
		expect(() => Miss.load(missesFile([missing]))).toThrow(/must be a JSON array of misses/);
		expect(() => Miss.load(missesFile([{ ...fields, extra: "x" }]))).toThrow(/must be a JSON array of misses/);
		expect(() => Miss.load(missesFile([]))).toThrow(/must be a JSON array of misses/);
	});

	it("vouches for a head by the commit it resolves to, and keeps trust-boundary alone at its deep level", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const head = git(repo, "rev-parse", "feature");
			const miss = Miss.load(missesFile([{ ...fields, repo, base, head: "feature" }]))[0]!;
			expect(miss.headCommit()).toBe(head);
			const vouched = miss.target(ProbeTrust.parse(head));
			expect(vouched).toMatchObject({
				repo,
				base,
				range: `${base}...${head}`,
				writer: { trusted: true, by: "reviewer" },
			});
			expect(miss.target(ProbeTrust.parse(sha)).writer).toEqual({
				trusted: false,
				detail: `this invocation does not vouch for ${head}`,
			});
			const loaded = await Lens.load(repo, { kind: "revision", commit: base }, ["src/a.ts"]);
			const scoped = vouched.scope!(defaultConfig, loaded);
			expect(scoped.config.tiers.full).toEqual(["lens.trust-boundary"]);
			expect(scoped.config.stages["pull-request"]).toBe("full");
			const boundary = scoped.lenses.find((lens) => lens.name === "trust-boundary")!;
			const deep = loaded.find((lens) => lens.name === "trust-boundary")!.level("deep");
			expect(boundary.levels).toEqual({ quick: deep, careful: deep, deep });
			expect(scoped.lenses.filter((lens) => lens.name !== "trust-boundary")).toEqual(
				loaded.filter((lens) => lens.name !== "trust-boundary"),
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("finds a miss only at its file, under its rule, from trust-boundary, and unrefuted", async () => {
		const found = await runGolden(lost, { kind: "scripted", probes: "unconfined" });
		const finding = found.findings[0]!;
		const miss = Miss.load(missesFile([{ ...fields, file: finding.properties.path!, rule: finding.ruleId }]))[0]!;
		expect(miss.found([finding])).toBe(true);
		expect(miss.found([])).toBe(false);
		const changed = (properties: object) => [
			Finding.from({ ...finding.toJSON(), properties: { ...finding.properties, ...properties } }),
		];
		expect(miss.found(changed({ path: "other.ts" }))).toBe(false);
		expect(miss.found(changed({ source: { ...finding.properties.source, check: "lens.security" } }))).toBe(false);
		expect(miss.found(changed({ verification: { verdict: "refuted", reason: "no" } }))).toBe(false);
		const other = Miss.load(missesFile([{ ...fields, file: finding.properties.path!, rule: "other-rule" }]))[0]!;
		expect(other.found([finding])).toBe(false);
	});
});

describe("ProbingSettings", () => {
	it("reads every setting live.ts reads, and defaults to three passes over the goldens", () => {
		const settings = ProbingSettings.parse({
			...env,
			MELIAN_EVAL_THINKING: "heavy=high",
			MELIAN_EVAL_MODEL: "d/all",
		});
		expect(settings.passes).toBe(3);
		expect(settings.set).toBe("goldens");
		expect(settings.verifierModel).toBe("c/verify");
		expect(settings.thinking.level("heavy")).toBe("high");
		const models = createFakeModels({ models: [{ id: "x" }] }).review;
		const combination = settings.combinations[0]!;
		expect(settings.mode(models, combination)).toEqual({
			kind: "live",
			models,
			thinking: settings.thinking,
			verifierModel: "c/verify",
			probing: combination,
			model: "d/all",
		});
		expect(ProbingSettings.parse(env).mode(models, combination)).not.toHaveProperty("model");
		expect(ProbingSettings.parse({ ...env, MELIAN_EVAL_PROBE_PASSES: "1" }).passes).toBe(1);
		expect(ProbingSettings.parse({ ...env, MELIAN_EVAL_MISSES: "m.json" }).set).toBe("all");
		expect(
			ProbingSettings.parse({ ...env, MELIAN_EVAL_MISSES: "m.json", MELIAN_EVAL_PROBE_SET: "goldens" }).set,
		).toBe("goldens");
		expect(ProbingSettings.parse({ ...env, MELIAN_EVAL_PROBER_TIER: "light" }).combinations[0]!.proberTier).toBe(
			"light",
		);
		expect(ProbingSettings.parse(env).combinations[0]!.proberTier).toBe("medium");
	});

	it.each([
		[{ MELIAN_EVAL_THINKING: "heavy=loud" }, /MELIAN_EVAL_THINKING/],
		[{ MELIAN_EVAL_PROBE_PASSES: "0" }, /MELIAN_EVAL_PROBE_PASSES must be 1 or more/],
		[{ MELIAN_EVAL_PROBE_PASSES: "1.5" }, /MELIAN_EVAL_PROBE_PASSES must be 1 or more/],
		[{ MELIAN_EVAL_PROBE_ROUTES: "" }, /names no combination/],
		[{ MELIAN_EVAL_PROBE_ROUTES: "a=x/y;a=x/z" }, /repeats the label a/],
		[{ MELIAN_EVAL_PROBER_TIER: "verifier" }, /MELIAN_EVAL_PROBER_TIER must be light, medium or heavy/],
		[{ MELIAN_EVAL_VERIFIER_MODEL: "" }, /MELIAN_EVAL_VERIFIER_MODEL/],
		[{ MELIAN_EVAL_MODEL: "nomodel" }, /MELIAN_EVAL_MODEL/],
		[{ MELIAN_EVAL_PROBE_SET: "misses" }, /MELIAN_EVAL_PROBE_SET=misses needs MELIAN_EVAL_MISSES/],
		[{ MELIAN_EVAL_PROBE_SET: "some" }, /MELIAN_EVAL_PROBE_SET must be goldens, misses or all/],
		[{ MELIAN_EVAL_PROBE_TRUST: "abc" }, /MELIAN_EVAL_PROBE_TRUST needs full commit IDs/],
	])("exits 2 before any provider for %j", async (setting, message) => {
		const using = runners();
		const { status, errors, lines } = await measure({ ...env, ...setting }, using);
		expect(status).toBe(2);
		expect(errors).toEqual([expect.stringMatching(message)]);
		expect(lines).toEqual([]);
		expect(using.models).not.toHaveBeenCalled();
		expect(using.availability).not.toHaveBeenCalled();
	});
});

describe("measureProbing", { timeout: 60_000 }, () => {
	let defect: readonly Finding[];
	beforeAll(async () => {
		defect = (await runGolden(lost, { kind: "scripted", probes: "unconfined" })).findings;
	});

	it("scores each combination by its worst and mean pass, prints each review's notes, and spends every review", async () => {
		let call = 0;
		const using = runners({
			golden: vi.fn(async (each: Golden) => {
				call += 1;
				if (call === 7) throw new GoldenRunError(new Error("provider down"), paid);
				return {
					golden: each,
					...ran(each === lost && call !== 3 ? defect : [], {
						notes: [{ reason: "it planned 1 attack and ran 1 probe in 0.3 s", checks: ["lens.trust-boundary"] }],
						tiers:
							each === lost
								? {
										"lens.trust-boundary": "medium",
										"lens.tests": "medium",
										"lens.design": "light",
										"lens.conventions": "medium",
									}
								: { "lens.correctness": "medium" },
					}),
				};
			}),
		});
		const out = join(scratch, "results.json");
		const { status, lines } = await measure(
			{ ...env, MELIAN_EVAL_PROBE_ROUTES: "pair=a/plan>b/probe;off=a/plan", MELIAN_EVAL_PROBE_OUT: out },
			using,
		);
		expect(status).toBe(1);
		expect(using.models).toHaveBeenCalledTimes(1);
		expect(using.availability).toHaveBeenCalledTimes(1);
		expect(using.golden).toHaveBeenCalledTimes(12);
		expect(lines.slice(0, 4)).toEqual([
			"pair: planner a/plan, prober b/probe on the medium tier",
			expect.stringMatching(
				/^pair pass 1 trust-boundary-probe-claim-lost-release: precision 1\.00, recall 1\.00 \(1 reported, 1 expected\), 14 tokens/,
			),
			"    lens.trust-boundary: it planned 1 attack and ran 1 probe in 0.3 s",
			expect.stringMatching(
				/^pair pass 1 trust-boundary-probe-claim-lost-release-clean: precision 1\.00, recall 1\.00 \(0 reported, 0 expected\)/,
			),
		]);
		expect(lines).not.toContain("    rendered review");
		expect(lines).toContain(
			"pair: worst precision 1.00, recall 0.00; mean precision 1.00, recall 0.67; 84 tokens, $6",
		);
		expect(lines).toContain(
			"pair: other lens checks on the prober's medium tier: lens.conventions, lens.correctness, lens.tests",
		);
		expect(lines).toContainEqual(
			expect.stringMatching(
				/^off pass 1 trust-boundary-probe-claim-lost-release: no score \(provider down\), 14 tokens/,
			),
		);
		expect(lines).toContainEqual(expect.stringMatching(/^off: no score, 1 reviews had none, 84 tokens, \$6/));
		expect(lines.filter((line) => line.startsWith("off: other lens"))).toEqual([]);
		const results = JSON.parse(readFileSync(out, "utf8"));
		expect(results.verifier).toBe("c/verify");
		expect(results.passes).toBe(3);
		expect(results.results.map((result: { combination: unknown }) => result.combination)).toEqual([
			{ label: "pair", planner: "a/plan", prober: "b/probe", proberTier: "medium" },
			{ label: "off", planner: "a/plan" },
		]);
		expect(results.results[0]).toMatchObject({
			worst: { precision: 1, recall: 0 },
			sharedProberTier: ["lens.conventions", "lens.correctness", "lens.tests"],
			spend: expect.stringMatching(/^84 tokens/),
		});
		const notes = [{ reason: "it planned 1 attack and ran 1 probe in 0.3 s", checks: ["lens.trust-boundary"] }];
		const spent = { spend: paid.spend(), telemetry: JSON.parse(JSON.stringify(paid.toJSON())) };
		expect(results.results[0].passes[0].reviews).toEqual([
			{
				name: lost.name,
				kind: "golden",
				score: { ...scoreGolden(lost, defect) },
				notes,
				sharedProberTier: ["lens.conventions", "lens.tests"],
				...spent,
			},
			{
				name: clean.name,
				kind: "golden",
				score: { ...scoreGolden(clean, []) },
				notes,
				sharedProberTier: ["lens.correctness"],
				...spent,
			},
		]);
		expect(results.results[0].mean.recall).toBeCloseTo(2 / 3);
		expect(results.results[1]).not.toHaveProperty("worst");
		expect(results.results[1].passes[0]).toEqual({
			failed: [lost.name],
			reviews: [
				{ name: lost.name, kind: "golden", error: "provider down", notes: [], sharedProberTier: [], ...spent },
				{
					name: clean.name,
					kind: "golden",
					score: { ...scoreGolden(clean, []) },
					notes,
					sharedProberTier: [],
					...spent,
				},
			],
		});
		expect(results.results[1].passes[1]).toMatchObject({ goldens: { precision: 1, recall: 1 }, failed: [] });
	});

	it("prints the rendered review under MELIAN_EVAL_SHOW=1, and runs one pass for one golden", async () => {
		const using = runners();
		const { status, lines } = await measure(
			{ ...env, MELIAN_EVAL_SHOW: "1", MELIAN_EVAL_PROBE_PASSES: "1", MELIAN_EVAL_GOLDEN: clean.name },
			using,
		);
		expect(status).toBe(0);
		expect(using.golden).toHaveBeenCalledTimes(1);
		expect(lines).toContain("    rendered review");
		expect(lines).toContain("pair: other lens checks on the prober's medium tier: none");
	});

	it("runs the misses alone, scoring their share found, and refuses a head the invocation does not vouch for", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const head = git(repo, "rev-parse", "feature");
			const misses = missesFile([
				{ name: "hit", repo, base, head, file: defect[0]!.properties.path!, rule: defect[0]!.ruleId },
				{ name: "miss", repo, base, head: "feature", file: "other.ts", rule: "fail-open" },
			]);
			const settings = { ...env, MELIAN_EVAL_MISSES: misses, MELIAN_EVAL_PROBE_SET: "misses" };
			const refused = runners();
			expect(await measure(settings, refused)).toMatchObject({
				status: 2,
				errors: ["MELIAN_EVAL_PROBE_TRUST does not vouch for the heads of hit, miss, so their probes cannot run"],
			});
			expect(refused.models).not.toHaveBeenCalled();
			const unprobed = runners({ range: vi.fn(async () => ran(defect)) });
			expect((await measure({ ...settings, MELIAN_EVAL_PROBE_ROUTES: "off=a/plan" }, unprobed)).status).toBe(0);
			expect(vi.mocked(unprobed.range).mock.calls.map(([target]) => target.writer.trusted)).toEqual(
				Array(6).fill(false),
			);
			const using = runners({ range: vi.fn(async () => ran(defect)) });
			const out = join(scratch, "misses-results.json");
			const { status, lines } = await measure(
				{ ...settings, MELIAN_EVAL_PROBE_TRUST: head, MELIAN_EVAL_PROBE_OUT: out },
				using,
			);
			expect(status).toBe(0);
			expect(using.golden).not.toHaveBeenCalled();
			expect(using.range).toHaveBeenCalledTimes(6);
			expect(vi.mocked(using.range).mock.calls.map(([target]) => target.writer.trusted)).toEqual(
				Array(6).fill(true),
			);
			expect(lines).toContainEqual(expect.stringMatching(/^pair pass 1 hit: found, 14 tokens/));
			expect(lines).toContainEqual(expect.stringMatching(/^pair pass 1 miss: missed, 14 tokens/));
			expect(lines).toContain("pair: worst miss recall 0.50; mean miss recall 0.50; 84 tokens, $6");
			const spent = { spend: paid.spend(), telemetry: JSON.parse(JSON.stringify(paid.toJSON())) };
			const review = { kind: "miss", notes: [], sharedProberTier: [], ...spent };
			expect(JSON.parse(readFileSync(out, "utf8")).results[0].passes[0]).toEqual({
				misses: { found: 1, total: 2 },
				failed: [],
				reviews: [
					{ name: "hit", found: true, ...review },
					{ name: "miss", found: false, ...review },
				],
			});
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("records what it measured: the checkout's commit, and each miss's names and the commits they resolve to", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const head = git(repo, "rev-parse", "feature");
			git(repo, "branch", "moving-base", base);
			const fields = { file: "other.ts", rule: "fail-open" };
			const misses = missesFile([{ name: "named", repo, base: "moving-base", head: "feature", ...fields }]);
			const using = runners();
			const out = join(scratch, "provenance.json");
			const settings = {
				...env,
				MELIAN_EVAL_MISSES: misses,
				MELIAN_EVAL_PROBE_SET: "misses",
				MELIAN_EVAL_PROBE_PASSES: "1",
				MELIAN_EVAL_PROBE_TRUST: head,
				MELIAN_EVAL_PROBE_OUT: out,
			};
			expect((await measure(settings, using)).status).toBe(0);
			expect(vi.mocked(using.range).mock.calls[0]![0]).toMatchObject({ base, range: `${base}...${head}` });
			const checkout = import.meta.dirname;
			const { results: _, ...provenance } = JSON.parse(readFileSync(out, "utf8"));
			expect(provenance).toEqual({
				version: 1,
				commit: git(checkout, "rev-parse", "HEAD"),
				clean: git(checkout, "status", "--porcelain") === "",
				complete: true,
				verifier: "c/verify",
				passes: 1,
				misses: [
					{
						name: "named",
						repo,
						base: "moving-base",
						head: "feature",
						...fields,
						baseCommit: base,
						headCommit: head,
					},
				],
			});
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses a results file it cannot write before any provider", async () => {
		const using = runners();
		const out = join(scratch, "missing", "results.json");
		const { status, errors } = await measure({ ...env, MELIAN_EVAL_PROBE_OUT: out }, using);
		expect(status).toBe(2);
		expect(errors).toEqual([
			expect.stringMatching(/^ENOENT: no such file or directory, open '.*results\.json\.[0-9]+\.tmp'$/),
		]);
		expect(using.models).not.toHaveBeenCalled();
		expect(using.golden).not.toHaveBeenCalled();
	});

	it("replaces the results file whole after each pass, so a cut run keeps the passes it finished", async () => {
		const out = join(scratch, "results.json");
		writeFileSync(out, "an earlier run's record\n");
		const seen: unknown[] = [];
		const using = runners({
			golden: vi.fn(async (each: Golden) => {
				seen.push(JSON.parse(readFileSync(out, "utf8")));
				return { golden: each, ...ran([]) } as GoldenRun;
			}),
		});
		expect((await measure({ ...env, MELIAN_EVAL_PROBE_PASSES: "2", MELIAN_EVAL_PROBE_OUT: out }, using)).status).toBe(
			0,
		);
		expect(seen.map((file) => (file as { complete: boolean }).complete)).toEqual([false, false, false, false]);
		expect((seen[0] as { results: unknown[] }).results).toEqual([]);
		const cut = seen[2] as { results: { passes: unknown[] }[] };
		expect(cut.results).toHaveLength(1);
		expect(cut.results[0]!.passes).toHaveLength(1);
		expect(cut.results[0]).not.toHaveProperty("worst");
		const last = JSON.parse(readFileSync(out, "utf8"));
		expect(last.complete).toBe(true);
		expect(last.results[0].passes).toHaveLength(2);
		expect(last.results[0].worst).toEqual({ precision: 1, recall: 0 });
		expect(readdirSync(scratch)).toEqual(["results.json"]);
	});

	it("fails before any provider when probes cannot run on the host, and asks nothing of a run without probes", async () => {
		const refusing = runners({
			availability: vi.fn(async () => ({ available: false, reason: "no sandbox" }) as const),
		});
		expect(await measure(env, refusing)).toMatchObject({
			status: 2,
			errors: ["Probes cannot run on this host: no sandbox"],
		});
		expect(refusing.models).not.toHaveBeenCalled();
		const off = runners({ availability: refusing.availability });
		expect((await measure({ ...env, MELIAN_EVAL_PROBE_ROUTES: "off=a/plan" }, off)).status).toBe(0);
		expect(refusing.availability).toHaveBeenCalledTimes(1);
	});
});

describe("runRange", { timeout: 60_000 }, () => {
	const fake = createFakeModels({ models: [{ id: "plan" }, { id: "probe" }] });
	const provider = fake.ref("plan").provider;

	it("plans on the combination's planner, and records what tier each lens ran on", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const seen: string[] = [];
			const plan = (_: unknown, model: string) => {
				seen.push(model);
				return seen.length === 1
					? fauxAssistantMessage([fauxToolCall("record_plan", { attacks: [] })], { stopReason: "toolUse" })
					: fauxAssistantMessage("Planned 0.");
			};
			scriptConversations(fake, [{ match: "Your role at this level: the attack planner", replies: [plan, plan] }]);
			const head = git(repo, "rev-parse", "feature");
			const miss = Miss.load(missesFile([{ name: "m", repo, base, head, file: "x", rule: "fail-open" }]))[0]!;
			const run = await runRange(miss.target(ProbeTrust.parse(head)), {
				kind: "live",
				models: fake.review,
				verifierModel: `${provider}/plan`,
				probing: ProbingCombination.parse(`pair=${provider}/plan>${provider}/probe`, "medium"),
			});
			expect(seen).toEqual(["plan", "plan"]);
			expect(run.findings).toEqual([]);
			expect(run.tiers).toEqual({});
			expect(run.notes).toEqual([
				{ reason: expect.stringMatching(/planner found no attack/), checks: ["lens.trust-boundary"] },
			]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("gives no score to a range whose head the invocation does not vouch for, since its probes cannot run", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			scriptConversations(fake, [
				{ match: "trust-boundary", replies: [fauxAssistantMessage("Nothing to report.")] },
			]);
			const miss = Miss.load(
				missesFile([{ name: "m", repo, base, head: "feature", file: "x", rule: "fail-open" }]),
			)[0]!;
			await expect(
				runRange(miss.target(ProbeTrust.parse(sha)), {
					kind: "live",
					models: fake.review,
					verifierModel: `${provider}/plan`,
					probing: ProbingCombination.parse(`pair=${provider}/plan>${provider}/probe`, "medium"),
				}),
			).rejects.toThrow(/lens\.trust-boundary: .*ran without probes/);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

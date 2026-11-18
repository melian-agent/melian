import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	Changeset,
	checksOfTier,
	defaultConfig,
	Finding,
	type FindingInput,
	Lens,
	loadConfig,
	type MelianConfig,
	type ResolvedFinding,
	Revision,
	revisionLimits,
	Verdict,
} from "@melian-agent/core";
import {
	backgroundContext,
	createMemoryStorage,
	createRegistry,
	openHarness,
	openSqliteStorage,
	StageTelemetry,
	TelemetryReader,
	TokenUsage,
	upsertFinding,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptLenses,
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
	sightingsAt,
} from "../src/goldens.ts";
import {
	Miss,
	measureProbing,
	ProbeTrust,
	ProbingCombination,
	type ProbingRunners,
	ProbingSettings,
	probingGoldenPrefix,
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
		subject: "trust-boundary@1@deep",
		outcome: "completed",
		coverage: { scope: "", paths: ["**"], nearer: [] },
		shown: [".github/workflows/claim.yml", "moved/claim.yml", ".github/root.txt"],
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
		sightings: findings,
		verdict: held({ findings }),
		rendered: "rendered review\n",
		toolMismatches: [],
		probers: {},
		notes: [],
		tiers: {},
		...fields,
	};
}

// A verdict holding each finding in the group it names, as adjudication would leave it.
function held(groups: {
	findings?: readonly Finding[];
	dismissed?: readonly Finding[];
	refuted?: readonly Finding[];
}): Verdict {
	const resolved = (findings: readonly Finding[] = []) => findings as ResolvedFinding[];
	return new Verdict({
		status: "findings",
		blocking: false,
		findings: { block: [], acknowledge: [], advisory: resolved(groups.findings), silent: [] },
		dismissed: resolved(groups.dismissed),
		notRun: [],
		...(groups.refuted === undefined ? {} : { refuted: resolved(groups.refuted) }),
	});
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
		(line) => {
			// A pass loop that never ends awaits only microtasks, so no test timeout would fire.
			if (lines.push(line) > 1_000) throw new Error("the run printed without end");
		},
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

function missesFile(misses: readonly Record<string, unknown>[]): string {
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
		expect(() => ProbingCombination.parse("!x=a/b", "medium")).toThrow(/invalid entry/);
		expect(() => ProbingCombination.parse("x=a/b\ny=c/d", "medium")).toThrow(/invalid entry/);
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
		expect(light.config.models.light).toStrictEqual({ model: "b/probe" });
		expect(light.config.models.medium).toEqual(config.models.medium);
	});

	it("makes every level probe only in the lenses a miss's mode probes: trust-boundary in lens mode, the named lenses in whole mode", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const loaded = await Lens.load(repo, { kind: "revision", commit: base }, ["src/a.ts"]);
			const miss = Miss.load(
				missesFile([{ name: "m", repo, base, head: "feature", file: "src/a.ts", rule: "fail-open" }]),
			)[0]!;
			const trust = ProbeTrust.parse(sha);
			const probing = (review: "lens" | "whole", probeLenses?: readonly string[]) =>
				miss.target(trust, review, probeLenses).scope!(config, loaded)
					.lenses.filter((lens) => lens.level("careful").probe !== undefined)
					.map(({ name }) => name);
			expect(probing("lens", ["correctness"])).toEqual(["trust-boundary"]);
			expect(probing("whole", ["correctness"])).toEqual(["correctness"]);
			expect(probing("whole")).toEqual(["trust-boundary"]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
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

	it("probes each lens the run names, on the same routes, and leaves the rest as they loaded", async () => {
		const loaded = await lenses();
		const both = ProbingCombination.parse("pair=a/plan>b/probe", "medium", ["trust-boundary", "correctness"]);
		const routed = both.routed(config, loaded);
		expect(routed.config.lenses.correctness).toEqual({ route: { model: "a/plan", thinking: "high" } });
		expect(routed.config.lenses["trust-boundary"]).toEqual({
			level: { floor: "deep" },
			route: { model: "a/plan", thinking: "high" },
		});
		const correctness = routed.lenses.find((lens) => lens.name === "correctness")!;
		expect(correctness.level("deep").probe).toEqual({ prober: "medium" });
		expect(correctness.level("careful").probe).toBeUndefined();
		const others = (lensSet: readonly Lens[]) =>
			lensSet.filter((lens) => lens.name !== "trust-boundary" && lens.name !== "correctness");
		expect(others(routed.lenses)).toEqual(others(loaded));
	});

	it("holds every lens whose level probes to the combination, named or not, and gives only a named lens a probe", async () => {
		const loaded = (await lenses()).map((lens) => {
			if (lens.name !== "conventions") return lens;
			return Lens.from({
				...lens.toJSON(),
				levels: { ...lens.levels, careful: { ...lens.level("careful"), probe: { prober: "light" } } },
			});
		});
		const probes = (routed: { lenses: readonly Lens[] }, name: string) => {
			const lens = routed.lenses.find((each) => each.name === name)!;
			return (["quick", "careful", "deep"] as const).map((level) => lens.level(level).probe);
		};
		const pair = ProbingCombination.parse("pair=a/plan>b/probe", "medium", ["correctness"]).routed(config, loaded);
		expect(pair.config.lenses["trust-boundary"]).toEqual({
			level: { floor: "deep" },
			route: { model: "a/plan", thinking: "high" },
		});
		expect(probes(pair, "trust-boundary")).toEqual([undefined, undefined, { prober: "medium" }]);
		expect(pair.config.lenses.conventions).toEqual({ route: { model: "a/plan", thinking: "high" } });
		expect(probes(pair, "conventions")).toEqual([undefined, { prober: "medium" }, undefined]);
		expect(probes(pair, "correctness")).toEqual([undefined, undefined, { prober: "medium" }]);
		const off = ProbingCombination.parse("off=a/plan", "medium", ["correctness"]).routed(config, loaded);
		for (const name of ["trust-boundary", "conventions", "correctness"])
			expect(probes(off, name), name).toEqual([undefined, undefined, undefined]);
		expect(off.config.lenses.conventions).toEqual({ route: { model: "a/plan", thinking: "high" } });
		expect(off.config.lenses.design).toBeUndefined();
		expect(off.lenses.find((lens) => lens.name === "design")).toBe(loaded.find((lens) => lens.name === "design"));
	});

	it("refuses a lens core would not let probe, and one the policy does not load, naming each", async () => {
		const loaded = await lenses();
		expect(() =>
			ProbingCombination.parse("pair=a/plan>b/probe", "medium", ["trust-boundary", "tests"]).routed(config, loaded),
		).toThrow(
			'MELIAN_EVAL_PROBE_LENSES names tests, which cannot probe: "probe" is refused in the tests lens, and in any lens that extends it, until https://github.com/melian-agent/melian/issues/493 decides what an attack counts as when its probes showed nothing',
		);
		expect(() => ProbingCombination.parse("off=a/plan", "medium", ["contracts"]).routed(config, loaded)).toThrow(
			/^MELIAN_EVAL_PROBE_LENSES names contracts, which cannot probe: "probe" needs the probing wording/,
		);
		expect(() => ProbingCombination.parse("off=a/plan", "medium", ["nowhere"]).routed(config, loaded)).toThrow(
			"MELIAN_EVAL_PROBE_LENSES names nowhere, which the base's policy does not load",
		);
	});

	it("refuses a lens the tier of the review's pull-request stage does not run, which is full when no stage names one", async () => {
		const loaded = await lenses();
		const pair = ProbingCombination.parse("pair=a/plan>b/probe", "medium", ["correctness"]);
		const tiers = { full: ["lens.trust-boundary"], careful: ["lens.correctness"] };
		expect(() => pair.routed({ ...config, tiers, stages: {} }, loaded)).toThrow(
			"MELIAN_EVAL_PROBE_LENSES names correctness, which the review's full tier does not run",
		);
		expect(() => pair.routed({ ...config, tiers, stages: { "pull-request": "full" } }, loaded)).toThrow(
			"MELIAN_EVAL_PROBE_LENSES names correctness, which the review's full tier does not run",
		);
		const careful = pair.routed({ ...config, tiers, stages: { "pull-request": "careful" } }, loaded);
		expect(careful.config.lenses.correctness).toStrictEqual({ route: { model: "a/plan", thinking: "high" } });
	});

	it("drops every probe for the level without probes, and leaves the tiers as they were", async () => {
		const routed = ProbingCombination.parse("off=a/plan", "medium").routed(
			{ ...config, lenses: {}, models: { medium: { model: "m/medium" } } },
			await lenses(),
		);
		expect(routed.config.models).toEqual({ medium: { model: "m/medium" } });
		expect(routed.config.lenses["trust-boundary"]).toStrictEqual({ route: { model: "a/plan" } });
		const boundary = routed.lenses.find((lens) => lens.name === "trust-boundary")!;
		expect(Object.values(boundary.levels).map((level) => level?.probe)).toEqual([undefined, undefined, undefined]);
	});
});

// A probing golden measures one prober, trust-boundary's, so no other lens of its tier may probe in any arm.
describe("a probing golden", { timeout: 120_000 }, () => {
	const probingGoldens = all.filter((each) => each.name.startsWith(probingGoldenPrefix));

	it("leaves trust-boundary the only lens of its tier with a level that probes, in the arm without probes and a pair", async () => {
		expect(probingGoldens).toHaveLength(6);
		for (const each of probingGoldens) {
			const { repo, base } = buildGoldenRepository(each);
			try {
				const source = { kind: "revision", commit: base } as const;
				const { revision } = await Changeset.resolve(repo, "main...feature");
				const config = (await loadConfig(repo, source, ".")).config;
				const loaded = await Lens.load(repo, source, revision.paths());
				const tier = checksOfTier(config, "full");
				for (const [entry, probing] of [
					["off=a/plan", []],
					["pair=a/plan>b/probe", ["trust-boundary"]],
				] as const) {
					const routed = ProbingCombination.parse(entry, "light").routed(config, loaded);
					const probers = routed.lenses
						.filter((lens) => tier.includes(`lens.${lens.name}`))
						.filter((lens) => Object.values(lens.levels).some((level) => level?.probe !== undefined))
						.map((lens) => lens.name);
					expect(probers, `${each.name} ${entry}`).toEqual(probing);
				}
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		}
	});

	it("runs the lenses it ran before Melian's own rounds probed, with trust-boundary alone planning and probing", async () => {
		const run = await runGolden(golden("trust-boundary-probe-round-environ-leak"), {
			kind: "scripted",
			probes: "unconfined",
		});
		expect(
			(run.verdict.ran ?? [])
				.map(({ name }) => name)
				.filter((name) => name.startsWith("lens."))
				.sort(),
		).toEqual([
			"lens.contracts",
			"lens.conventions",
			"lens.correctness",
			"lens.design",
			"lens.removed-behaviour",
			"lens.tests",
			"lens.trust-boundary",
		]);
		expect(run.notes).toEqual([
			{
				reason: expect.stringMatching(/^it planned 2 attacks and ran 2 probes in /),
				checks: ["lens.trust-boundary"],
			},
		]);
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
		const { rule: _, ...ruleless } = fields;
		const read = { ...ruleless, rules: ["fail-open"] };
		expect(Miss.load(missesFile([fields])).map((miss) => ({ ...miss }))).toEqual([read]);
		const { name: __, ...missing } = fields;
		expect(() => Miss.load(missesFile([missing]))).toThrow(/must be a JSON array of misses/);
		expect(() => Miss.load(missesFile([{ ...fields, extra: "x" }]))).toThrow(/must be a JSON array of misses/);
		expect(() => Miss.load(missesFile([]))).toThrow(/must be a JSON array of misses/);
		for (const field of Object.keys(fields))
			expect(() => Miss.load(missesFile([{ ...fields, [field]: "" }])), field).toThrow(
				/must be a JSON array of misses/,
			);
		const located = { fix: "f", lines: [3, 3] };
		expect(Miss.load(missesFile([{ ...fields, ...located }])).map((miss) => ({ ...miss }))).toEqual([
			{ ...read, ...located },
		]);
		expect(() => Miss.load(missesFile([{ ...fields, fix: "" }]))).toThrow(
			/must be a JSON array of misses, each \{ name, repo, base, head, file, rule\?, alternativeRules\?, fix\?, lines\? \}/,
		);
		for (const lines of [[0, 3], [4, 3], [1.5, 3], [3], [3, 4, 5], ["3", 4]])
			expect(() => Miss.load(missesFile([{ ...fields, lines }])), JSON.stringify(lines)).toThrow(
				/must be a JSON array of misses/,
			);
		expect(Miss.load(missesFile([{ ...fields, lines: [1, 1] }]))[0]!.lines).toEqual([1, 1]);
		expect(() => Miss.load(missesFile([fields, { ...fields, lines: [4, 3] }]))).toThrow(
			/must be a JSON array of misses/,
		);
	});

	it("reads a miss's alternative rules, and a miss with no rule only when it has lines", () => {
		const alternatives = { ...fields, alternativeRules: ["path-traversal", "secret-exposure"] };
		expect(Miss.load(missesFile([alternatives]))[0]!.rules).toEqual([
			"fail-open",
			"path-traversal",
			"secret-exposure",
		]);
		const { rule: _, ...ruleless } = fields;
		expect(Miss.load(missesFile([{ ...ruleless, lines: [3, 4] }]))[0]!.rules).toEqual([]);
		const path = missesFile([fields, { ...ruleless, name: "unruled" }]);
		expect(() => Miss.load(path)).toThrow(`${path}: unruled names no rule, so it needs lines`);
		const loose = missesFile([{ ...ruleless, lines: [3, 4], alternativeRules: ["fail-open"] }]);
		expect(() => Miss.load(loose)).toThrow(`${loose}: m names alternative rules but no rule`);
		for (const alternativeRules of [[], [""]])
			expect(
				() => Miss.load(missesFile([{ ...fields, alternativeRules }])),
				JSON.stringify(alternativeRules),
			).toThrow(/must be a JSON array of misses/);
	});

	it("keeps git's diagnostic on a miss's repository off the terminal, since a misses file's path can carry escapes", () => {
		const misses = missesFile([{ ...fields, repo: join(scratch, "no\u001b[2Jrepo") }]);
		const script = `import { Miss } from ${JSON.stringify(join(import.meta.dirname, "../src/probing.ts"))};
try { Miss.load(${JSON.stringify(misses)})[0].headCommit(); } catch { console.log("refused"); }`;
		const child = spawnSync(
			process.execPath,
			["--conditions=@melian-agent/source", "--input-type=module", "--eval", script],
			{ encoding: "utf8" },
		);
		expect(child.stdout).toBe("refused\n");
		expect(child.stderr).not.toContain("\u001b");
		expect(child.stderr).not.toContain("cannot change to");
	});

	it("vouches for a miss only by both commits its base and head resolve to, and keeps trust-boundary alone at its deep level", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const head = git(repo, "rev-parse", "feature");
			const miss = Miss.load(missesFile([{ ...fields, repo, base, head: "feature" }]))[0]!;
			expect(miss.headCommit()).toBe(head);
			const vouched = miss.target(ProbeTrust.parse(`${base},${head}`));
			expect(vouched).toMatchObject({
				repo,
				base,
				range: `${base}...${head}`,
				writer: { trusted: true, by: "reviewer" },
			});
			expect(miss.target(ProbeTrust.parse(sha)).writer).toEqual({
				trusted: false,
				detail: `this invocation does not vouch for ${base} and ${head}`,
			});
			expect(miss.target(ProbeTrust.parse(head)).writer).toEqual({
				trusted: false,
				detail: `this invocation does not vouch for ${base}`,
			});
			expect(miss.target(ProbeTrust.parse(base)).writer).toEqual({
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

	it("finds a miss only at its file, under its rule, in a trust-boundary sighting the verdict leaves unrefuted", async () => {
		const reviewed = await runGolden(lost, { kind: "scripted", probes: "unconfined" });
		const finding = reviewed.findings[0]!;
		const miss = Miss.load(missesFile([{ ...fields, file: finding.properties.path!, rule: finding.ruleId }]))[0]!;
		const loose = { by: "file and rule" } as const;
		const found = (findings: readonly Finding[], sightings = findings, which = miss) =>
			which.match({ verdict: held({ findings }), sightings }, loose).hits.length > 0;
		expect(found([finding])).toBe(true);
		expect(found([])).toBe(false);
		const changed = (properties: object) =>
			Finding.from({ ...finding.toJSON(), properties: { ...finding.properties, ...properties } });
		expect(found([changed({ path: "other.ts" })])).toBe(false);
		const other = Miss.load(missesFile([{ ...fields, file: finding.properties.path!, rule: "other-rule" }]))[0]!;
		expect(found([finding], [finding], other)).toBe(false);
		const refuted = { verification: { verdict: "refuted", reason: "no" } };
		expect(found([changed(refuted)], [finding])).toBe(false);
		expect(found([changed({ verification: undefined })], [finding])).toBe(true);
		expect(found([finding], [changed(refuted)])).toBe(true);
		const claim = finding.claims()[0]!;
		const security = { check: "lens.security", version: "v" };
		const speaker = { source: security, reportedBy: [security], verification: undefined };
		expect(found([changed({ ...speaker, otherClaims: [claim] })], [finding])).toBe(true);
		expect(
			found([changed({ ...speaker, otherClaims: [{ ...claim, verification: refuted.verification }] })], [finding]),
		).toBe(false);
		const twice = [
			claim,
			{ ...claim, source: { ...claim.source, version: "w" }, verification: refuted.verification },
		];
		const atW = changed({ source: twice[1]!.source });
		expect(found([changed({ ...speaker, otherClaims: twice })], [finding, atW])).toBe(true);
		expect(found([changed({ ...speaker, otherClaims: twice.toReversed() })], [atW, finding])).toBe(true);
	});

	it("pairs each claim with its own level's sighting, so a refuted level's lines score nothing where another level's claim of that ID stands", async () => {
		const reviewed = await runGolden(lost, { kind: "scripted", probes: "unconfined" });
		const finding = reviewed.findings[0]!;
		const [start, end] = finding.lines();
		const miss = Miss.load(missesFile([{ ...fields, file: finding.properties.path!, rule: finding.ruleId }]))[0]!;
		const verification = (verdict: "confirmed" | "refuted") => ({
			verdict,
			reason: `the probe ${verdict} it`,
			executor: "llm" as const,
			model: "fake/judge",
			version: "1",
		});
		// Quick and careful sight one ID, since an ID excludes lines; the verifier refutes quick's and upholds careful's.
		const level = (version: string, first: number, last: number, verdict: "confirmed" | "refuted") => {
			const stored = finding.toJSON();
			const [location] = stored.locations;
			const region = { ...location!.physicalLocation.region, startLine: first, endLine: last };
			return Finding.from({
				...stored,
				locations: [{ ...location!, physicalLocation: { ...location!.physicalLocation, region } }],
				properties: {
					...finding.properties,
					source: { check: "lens.trust-boundary", version },
					reportedBy: undefined,
					otherClaims: undefined,
					verification: verification(verdict),
				},
			});
		};
		const quick = level("quick1", start, start, "refuted");
		const careful = level("careful1", end + 5, end + 6, "confirmed");
		const verdict = Finding.from({
			...careful.toJSON(),
			properties: { ...careful.properties, otherClaims: [...careful.claims(), ...quick.claims()] },
		});
		const shown = (each: Finding) => ({
			id: each.id,
			lines: each.lines(),
			headline: each.headline().headline,
			failureScenario: each.properties.failureScenario,
			sightedBy: each.properties.source,
			evidence: each.properties.evidence,
			verification: each.properties.verification,
		});
		expect(
			miss.match(
				{ verdict: held({ findings: [verdict] }), sightings: [quick, careful] },
				{ by: "lines", ranges: [[start, start]] },
			),
		).toEqual({
			matched: "lines",
			hits: [],
			near: [shown(careful)],
		});
		expect(
			miss.match(
				{ verdict: held({ findings: [verdict] }), sightings: [quick, careful] },
				{ by: "lines", ranges: [[end + 5, end + 5]] },
			),
		).toEqual({ matched: "lines", hits: [shown(careful)], near: [] });
		expect(() =>
			miss.match(
				{ verdict: held({ findings: [verdict] }), sightings: [quick] },
				{ by: "lines", ranges: [[start, start]] },
			),
		).toThrow(
			`m: the verdict holds a lens.trust-boundary claim ${finding.id} from careful1 that the lens never sighted`,
		);
		expect(() =>
			miss.match(
				{ verdict: held({ findings: [quick] }), sightings: [quick, careful] },
				{ by: "lines", ranges: [[start, start]] },
			),
		).toThrow(`m: lens.trust-boundary sighted ${finding.id} at careful1, which the verdict holds no claim for`);
		expect(() =>
			miss.match(
				{ verdict: held({ findings: [careful, verdict] }), sightings: [quick, careful] },
				{ by: "lines", ranges: [[start, start]] },
			),
		).toThrow(`m: the verdict holds the lens.trust-boundary claim ${finding.id} from careful1 twice`);
	});

	it("takes a miss's claims from every group of the verdict: a refuted claim scores as not found, and a dismissed one by its own verification", async () => {
		const reviewed = await runGolden(lost, { kind: "scripted", probes: "unconfined" });
		const finding = reviewed.findings[0]!;
		const miss = Miss.load(missesFile([{ ...fields, file: finding.properties.path!, rule: finding.ruleId }]))[0]!;
		const loose = { by: "file and rule" } as const;
		const judged = (verdict: "confirmed" | "refuted") =>
			Finding.from({
				...finding.toJSON(),
				properties: {
					...finding.properties,
					verification: {
						verdict,
						reason: `the probe ${verdict} it`,
						executor: "llm",
						model: "fake/judge",
						version: "1",
					},
				},
			});
		const hits = (verdict: Verdict) => miss.match({ verdict, sightings: [finding] }, loose).hits;
		expect(hits(held({ refuted: [judged("refuted")] }))).toEqual([]);
		// A dismissal is a person's later call, which a measurement's fresh store cannot hold, so it decides nothing here.
		expect(hits(held({ dismissed: [judged("confirmed")] })).map(({ id }) => id)).toEqual([finding.id]);
		expect(hits(held({ dismissed: [judged("refuted")] }))).toEqual([]);
	});

	it("gives a miss no score when the verdict and the lens's sightings disagree on which claims it made", async () => {
		const reviewed = await runGolden(lost, { kind: "scripted", probes: "unconfined" });
		const finding = reviewed.findings[0]!;
		const miss = Miss.load(missesFile([{ ...fields, file: finding.properties.path!, rule: finding.ruleId }]))[0]!;
		const loose = { by: "file and rule" } as const;
		expect(() => miss.match({ verdict: held({ findings: [] }), sightings: [finding] }, loose)).toThrow(
			`m: lens.trust-boundary sighted ${finding.id} at ${finding.properties.source.version}, which the verdict holds no claim for`,
		);
		expect(() => miss.match({ verdict: held({ findings: [finding] }), sightings: [] }, loose)).toThrow(
			`m: the verdict holds a lens.trust-boundary claim ${finding.id} from ${finding.properties.source.version} that the lens never sighted`,
		);
		const security = { check: "lens.security", version: "v" };
		const elsewhere = Finding.from({
			...finding.toJSON(),
			properties: { ...finding.properties, source: security, reportedBy: [security], otherClaims: undefined },
		});
		expect(miss.match({ verdict: held({ findings: [elsewhere] }), sightings: [] }, loose)).toEqual({
			matched: "file and rule",
			hits: [],
			near: [],
		});
	});

	it("counts a finding only where it overlaps the miss's lines, and records the ones beside them", async () => {
		const found = await runGolden(lost, { kind: "scripted", probes: "unconfined" });
		const finding = found.findings[0]!;
		const [start, end] = finding.lines();
		const miss = Miss.load(missesFile([{ ...fields, file: finding.properties.path!, rule: finding.ruleId }]))[0]!;
		const at = (first: number, last: number, id: string, from = finding) => {
			const stored = from.toJSON();
			const [location] = stored.locations;
			const region = { ...location!.physicalLocation.region, startLine: first, endLine: last };
			return Finding.from({
				...stored,
				locations: [{ ...location!, physicalLocation: { ...location!.physicalLocation, region } }],
				properties: { ...from.properties, id },
			});
		};
		const near = at(end + 5, end + 6, "near");
		const shown = (each: Finding) => ({
			id: each.id,
			lines: each.lines(),
			headline: each.headline().headline,
			failureScenario: each.properties.failureScenario,
			sightedBy: each.properties.source,
			evidence: each.properties.evidence,
			verification: each.properties.verification,
		});
		const both = (sightings: readonly Finding[]) => ({ verdict: held({ findings: sightings }), sightings });
		expect(
			miss.match(both([finding, near]), {
				by: "lines",
				ranges: [
					[end + 1, end + 4],
					[start, start],
				],
			}),
		).toEqual({
			matched: "lines",
			hits: [shown(finding)],
			near: [shown(near)],
		});
		expect(miss.match(both([finding, near]), { by: "lines", ranges: [[end + 1, end + 4]] })).toEqual({
			matched: "lines",
			hits: [],
			near: [shown(finding), shown(near)],
		});
		expect(miss.match(both([near]), { by: "lines", ranges: [[end + 6, end + 9]] }).hits).toEqual([shown(near)]);
		expect(miss.match(both([near]), { by: "lines", ranges: [[end - 9, end + 5]] }).hits).toEqual([shown(near)]);
		expect(miss.match(both([finding, near]), { by: "file and rule" })).toEqual({
			matched: "file and rule",
			hits: [shown(finding), shown(near)],
			near: [],
		});
		const fix = (ranges: [number, number][]) => ({ by: "fix", fixCommit: sha, ranges }) as const;
		expect(miss.match(both([finding, near]), fix([[start, start]]))).toEqual({
			matched: "fix hunks",
			hunks: [[start, start]],
			hits: [{ ...shown(finding), hunks: [[start, start]] }],
			near: [shown(near)],
		});
		expect(
			miss.match(
				both([finding, near]),
				fix([
					[1, 1],
					[start, start],
					[end, end + 1],
				]),
			),
		).toEqual({
			matched: "fix hunks",
			hunks: [
				[1, 1],
				[start, start],
				[end, end + 1],
			],
			hits: [
				{
					...shown(finding),
					hunks: [
						[start, start],
						[end, end + 1],
					],
				},
			],
			near: [shown(near)],
		});
		const elsewhere = Finding.from({ ...near.toJSON(), properties: { ...near.properties, path: "other.ts" } });
		expect(miss.match(both([elsewhere]), { by: "lines", ranges: [[1, 1_000_000]] })).toEqual({
			matched: "lines",
			hits: [],
			near: [],
		});
		// A merged speaker from another lens keeps its own lines and words; the lens's own sighting says where it looked.
		const sighting = at(46, 47, finding.id);
		const security = { check: "lens.security", version: "v" };
		const speaker = (lines: [number, number]) =>
			Finding.from({
				...at(...lines, "speaker").toJSON(),
				properties: {
					...at(...lines, "speaker").properties,
					source: security,
					reportedBy: [security],
					failureScenario: "the security lens's words",
					otherClaims: [finding.claims()[0]!],
				},
			});
		const location = { by: "lines", ranges: [[46, 47]] } as const;
		expect(miss.match({ verdict: held({ findings: [speaker([40, 44])] }), sightings: [sighting] }, location)).toEqual(
			{
				matched: "lines",
				hits: [shown(sighting)],
				near: [],
			},
		);
		const swapped = at(40, 44, finding.id);
		expect(miss.match({ verdict: held({ findings: [speaker([46, 47])] }), sightings: [swapped] }, location)).toEqual({
			matched: "lines",
			hits: [],
			near: [shown(swapped)],
		});
	});

	it("locates a miss against the head its target froze, though its head's ref moves after", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const commit = (message: string) => {
				git(
					repo,
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@example.com",
					"commit",
					"--quiet",
					"--all",
					"-m",
					message,
				);
				return git(repo, "rev-parse", "HEAD");
			};
			const write = (lines: readonly string[]) => writeFileSync(join(repo, "f.ts"), `${lines.join("\n")}\n`);
			const original = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
			git(repo, "checkout", "--quiet", "-b", "tip", "feature");
			write(original);
			git(repo, "add", "f.ts");
			const head = commit("the head");
			git(repo, "branch", "reviewed", head);
			write(original.map((line, index) => (index === 2 ? "fixed 3" : line)));
			const fix = commit("the fix");
			git(repo, "checkout", "--quiet", "-b", "moved", head);
			write([...Array.from({ length: 5 }, (_, index) => `new ${index + 1}`), ...original]);
			const moved = commit("a later head");
			const miss = Miss.load(missesFile([{ ...fields, repo, base, head: "reviewed", fix }]))[0]!;
			const target = miss.target(ProbeTrust.parse(head));
			git(repo, "branch", "--force", "reviewed", moved);
			expect(await miss.locate(target.head)).toEqual({ by: "fix", fixCommit: fix, ranges: [[3, 3]] });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("takes a miss's lines from its fix's diff, as its hunks' old side, unless it names its own", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const commit = (message: string) =>
				git(
					repo,
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@example.com",
					"commit",
					"--quiet",
					"--all",
					"-m",
					message,
				);
			const write = (lines: readonly string[]) => writeFileSync(join(repo, "f.ts"), `${lines.join("\n")}\n`);
			const original = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
			git(repo, "checkout", "--quiet", "feature");
			write(original);
			git(repo, "add", "f.ts");
			commit("the head");
			const changed = [...original];
			changed.splice(2, 3, "fixed 3", "fixed 4", "fixed 5");
			changed.splice(7, 0, "inserted after 7");
			changed.splice(0, 0, "inserted first");
			write(changed);
			commit("the fix");
			writeFileSync(join(repo, "g.ts"), "elsewhere\n");
			git(repo, "add", "g.ts");
			commit("a change to another file");
			const load = (extra: object) =>
				Miss.load(missesFile([{ ...fields, repo, base, head: "feature~2", ...extra }]))[0]!;
			const at = (ref: string) => git(repo, "rev-parse", ref);
			expect(await load({}).locate(at("feature~2"))).toEqual({ by: "file and rule" });
			expect(await load({ fix: "feature~1" }).locate(at("feature~2"))).toEqual({
				by: "fix",
				fixCommit: git(repo, "rev-parse", "feature~1"),
				ranges: [
					[1, 1],
					[3, 5],
					[7, 8],
				],
			});
			expect(await load({ fix: "feature~1", lines: [5, 6] }).locate(at("feature~2"))).toEqual({
				by: "lines",
				ranges: [[5, 6]],
			});
			await expect(load({ head: "feature~1", fix: "feature" }).locate(at("feature~1"))).rejects.toThrow(
				`m: its fix ${git(repo, "rev-parse", "feature")} changes nothing in f.ts`,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
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
		expect(ProbingSettings.parse(env).probeLenses).toEqual(["trust-boundary"]);
		expect(ProbingSettings.parse({ ...env, MELIAN_EVAL_PROBE_LENSES: "" }).probeLenses).toEqual(["trust-boundary"]);
		const named = ProbingSettings.parse({ ...env, MELIAN_EVAL_PROBE_LENSES: " correctness, ,trust-boundary " });
		expect(named.probeLenses).toEqual(["correctness", "trust-boundary"]);
		expect(named.combinations[0]!.lenses).toEqual(["correctness", "trust-boundary"]);
		expect(ProbingSettings.parse(env).missReview).toBe("lens");
		expect(ProbingSettings.parse({ ...env, MELIAN_EVAL_MISS_REVIEW: "" }).missReview).toBe("lens");
		expect(ProbingSettings.parse({ ...env, MELIAN_EVAL_MISS_REVIEW: "whole" }).missReview).toBe("whole");
		expect(
			ProbingSettings.parse({
				...env,
				MELIAN_EVAL_PROBE_ROUTES: "pair=a/plan>b/probe; ;off=a/plan;",
			}).combinations.map(({ label }) => label),
		).toEqual(["pair", "off"]);
	});

	it.each([
		[{ MELIAN_EVAL_THINKING: "heavy=loud" }, /MELIAN_EVAL_THINKING/],
		[{ MELIAN_EVAL_PROBE_PASSES: "0" }, /MELIAN_EVAL_PROBE_PASSES must be 1 or more/],
		[{ MELIAN_EVAL_PROBE_PASSES: "1.5" }, /MELIAN_EVAL_PROBE_PASSES must be 1 or more/],
		[{ MELIAN_EVAL_PROBE_ROUTES: "" }, /names no combination/],
		[{ MELIAN_EVAL_PROBE_ROUTES: "a=x/y;a=x/z" }, /repeats the label a/],
		[{ MELIAN_EVAL_PROBER_TIER: "verifier" }, /MELIAN_EVAL_PROBER_TIER must be light, medium or heavy/],
		[{ MELIAN_EVAL_PROBE_LENSES: "correctness,correctness" }, /MELIAN_EVAL_PROBE_LENSES repeats correctness/],
		[{ MELIAN_EVAL_PROBE_LENSES: " , " }, /MELIAN_EVAL_PROBE_LENSES names no lens/],
		[{ MELIAN_EVAL_MISS_REVIEW: "Whole" }, /^MELIAN_EVAL_MISS_REVIEW must be lens or whole, not "Whole"$/],
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

	it("exits 2 at the first review for a probe lens core refuses, or one the golden's policy does not load or run", async () => {
		for (const [named, refusal] of [
			["tests", /^MELIAN_EVAL_PROBE_LENSES names tests, which cannot probe: "probe" is refused in the tests lens/],
			["nowhere", /^MELIAN_EVAL_PROBE_LENSES names nowhere, which the base's policy does not load$/],
			[
				"trust-boundary-probes",
				/^MELIAN_EVAL_PROBE_LENSES names trust-boundary-probes, which the review's full tier does not run$/,
			],
		] as const) {
			const using = runners({ goldens: () => [lost], golden: vi.fn(runGolden) });
			const { status, lines, errors } = await measure({ ...env, MELIAN_EVAL_PROBE_LENSES: named }, using);
			expect(errors, named).toEqual([expect.stringMatching(refusal)]);
			expect(status, named).toBe(2);
			expect(using.golden, named).toHaveBeenCalledTimes(1);
			expect(lines, named).toEqual(["pair: planner a/plan, prober b/probe on the medium tier"]);
		}
	});

	it("rejects with an error that is not a probe lens's refusal, rather than reading it as one", async () => {
		const using = runners({
			models: vi.fn(async () => {
				throw new Error("no login");
			}),
		});
		await expect(measure(env, using)).rejects.toThrow("no login");
	});

	it("scores each combination by its worst and mean pass, prints each review's notes, and spends every review", async () => {
		let call = 0;
		const record = (output: string) => ({
			"conversation:9": {
				plan: [{ target: "t", reason: "r", passing: "p", failing: "f" }],
				skips: [{ attack: 2, reason: "it needs another machine" }],
				probes: [{ id: "p1", attack: 1, script: "s", files: [{ path: "n", text: "x" }], output }],
			},
		});
		const using = runners({
			golden: vi.fn(async (each: Golden) => {
				call += 1;
				if (call === 7) throw new GoldenRunError(new Error("provider down"), paid, record("failed"));
				return {
					golden: each,
					...ran(each === lost && call !== 3 ? defect : [], {
						probers: record(`call ${call}`),
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
		const routed = (label: string) => expect.objectContaining({ probing: expect.objectContaining({ label }) });
		expect(vi.mocked(using.golden).mock.calls.map(([, mode]) => mode)).toEqual([
			...Array(6).fill(routed("pair")),
			...Array(6).fill(routed("off")),
		]);
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
		expect(lines).toContain("off: a/plan, without probes");
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
				score: { ...scoreGolden(lost, defect, defect) },
				notes,
				sharedProberTier: ["lens.conventions", "lens.tests"],
				...spent,
				probers: record("call 1"),
			},
			{
				name: clean.name,
				kind: "golden",
				score: { ...scoreGolden(clean, []) },
				notes,
				sharedProberTier: ["lens.correctness"],
				...spent,
				probers: record("call 2"),
			},
		]);
		expect(results.results[0].mean.recall).toBeCloseTo(2 / 3);
		expect(results.results[1]).not.toHaveProperty("worst");
		expect(results.results[1].passes[0]).toEqual({
			failed: [lost.name],
			reviews: [
				{
					name: lost.name,
					kind: "golden",
					error: "provider down",
					notes: [],
					sharedProberTier: [],
					...spent,
					probers: record("failed"),
				},
				{
					name: clean.name,
					kind: "golden",
					score: { ...scoreGolden(clean, []) },
					notes,
					sharedProberTier: [],
					...spent,
					probers: record("call 8"),
				},
			],
		});
		expect(results.results[1].passes[1]).toMatchObject({ goldens: { precision: 1, recall: 1 }, failed: [] });
	});

	it("pools a pass's precision over its goldens, so a false positive on a clean golden lowers the pass, its worst and its mean", async () => {
		let call = 0;
		const using = runners({
			golden: vi.fn(async (each: Golden) => {
				call += 1;
				const reported = each === lost || (each === clean && call <= 3) ? defect : [];
				return { golden: each, ...ran(reported) };
			}),
		});
		const out = join(scratch, "results.json");
		await measure({ ...env, MELIAN_EVAL_PROBE_OUT: out }, using);
		const [result] = JSON.parse(readFileSync(out, "utf8")).results;
		const precisions = result.passes.map((pass: { goldens: { precision: number } }) => pass.goldens.precision);
		// Pooled, the first pass is 1 of 2; a mean of each golden's precision would make it 2 of 3.
		expect(precisions).toEqual([0.5, 1, 1]);
		expect(result.worst.precision).toBe(0.5);
		expect(result.mean.precision).toBeCloseTo(5 / 6);
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

	it("counts no lens the combination probes as sharing the prober's tier, though it names several", async () => {
		const tiers = { "lens.trust-boundary": "medium", "lens.correctness": "medium", "lens.tests": "medium" } as const;
		const using = runners({ golden: vi.fn(async (each: Golden) => ({ golden: each, ...ran([], { tiers }) })) });
		const { lines } = await measure(
			{
				...env,
				MELIAN_EVAL_PROBE_LENSES: "trust-boundary,correctness",
				MELIAN_EVAL_PROBE_PASSES: "1",
				MELIAN_EVAL_GOLDEN: clean.name,
			},
			using,
		);
		expect(lines).toContain("pair: other lens checks on the prober's medium tier: lens.tests");
	});

	it("runs the misses alone, scoring their share found, leaving an unadjudicated hit unscored, and refuses a base or head the invocation does not vouch for", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const head = git(repo, "rev-parse", "feature");
			const at = { file: defect[0]!.properties.path!, rule: defect[0]!.ruleId };
			const [start, end] = defect[0]!.lines();
			git(repo, "checkout", "--quiet", "-b", "fixed", "feature");
			const path = join(repo, at.file);
			const text = readFileSync(path, "utf8").split("\n");
			const last = text.length - 1;
			text[start - 1] = "// fixed";
			writeFileSync(path, `${text.join("\n")}// appended\n`);
			git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--all", "-m", "fix");
			const misses = missesFile([
				{ name: "hit", repo, base, head, ...at, lines: [start, end] },
				{ name: "two hunks", repo, base, head, ...at, fix: "fixed" },
				{ name: "beside", repo, base, head, ...at, lines: [end + 1, end + 2] },
				{ name: "miss", repo, base, head: "feature", file: ".github/workflows/claim.yml", rule: "secret-exposure" },
				{ name: "loose", repo, base, head, ...at },
			]);
			const settings = { ...env, MELIAN_EVAL_MISSES: misses, MELIAN_EVAL_PROBE_SET: "misses" };
			const refused = runners();
			expect(await measure(settings, refused)).toMatchObject({
				status: 2,
				errors: [
					"MELIAN_EVAL_PROBE_TRUST does not vouch for the base and head of hit, two hunks, beside, miss, loose, so their probes cannot run",
				],
			});
			expect(refused.models).not.toHaveBeenCalled();
			expect(await measure({ ...settings, MELIAN_EVAL_PROBE_TRUST: head }, refused)).toMatchObject({
				status: 2,
				errors: [
					"MELIAN_EVAL_PROBE_TRUST does not vouch for the base and head of hit, two hunks, beside, miss, loose, so their probes cannot run",
				],
			});
			expect(refused.models).not.toHaveBeenCalled();
			const unprobed = runners({ range: vi.fn(async () => ran(defect)) });
			expect((await measure({ ...settings, MELIAN_EVAL_PROBE_ROUTES: "off=a/plan" }, unprobed)).status).toBe(1);
			expect(vi.mocked(unprobed.range).mock.calls.map(([target]) => target.writer.trusted)).toEqual(
				Array(15).fill(false),
			);
			const using = runners({ range: vi.fn(async () => ran(defect)) });
			const out = join(scratch, "misses-results.json");
			const { status, lines } = await measure(
				{ ...settings, MELIAN_EVAL_PROBE_TRUST: `${base},${head}`, MELIAN_EVAL_PROBE_OUT: out },
				using,
			);
			expect(status).toBe(1);
			expect(using.golden).not.toHaveBeenCalled();
			expect(using.range).toHaveBeenCalledTimes(15);
			expect(vi.mocked(using.range).mock.calls.map(([target]) => target.writer.trusted)).toEqual(
				Array(15).fill(true),
			);
			expect(lines).toContainEqual(expect.stringMatching(/^pair pass 1 hit: found, 14 tokens/));
			expect(lines).toContainEqual(
				`pair pass 1 two hunks: unadjudicated, no score: the fix changed 2 hunks in ${at.file} (${start}-${start}, ${last}-${last + 1}), and the sightings overlap ${start}-${start}, ${paid.spend()}`,
			);
			expect(lines).toContainEqual(expect.stringMatching(/^pair pass 1 beside: missed, 14 tokens/));
			expect(lines).toContainEqual(expect.stringMatching(/^pair pass 1 miss: missed, 14 tokens/));
			expect(lines).toContainEqual(
				expect.stringMatching(
					/^pair pass 1 loose: unadjudicated, no score: matched by file and rule alone, 14 tokens/,
				),
			);
			expect(lines).toContain("pair: no score, 6 reviews had none, 210 tokens, $15");
			const spent = { spend: paid.spend(), telemetry: JSON.parse(JSON.stringify(paid.toJSON())), probers: {} };
			const review = { kind: "miss", notes: [], sharedProberTier: [], probedBy: [], ...spent };
			const shown = {
				id: defect[0]!.id,
				lines: [start, end],
				headline: defect[0]!.headline().headline,
				failureScenario: defect[0]!.properties.failureScenario,
				sightedBy: defect[0]!.properties.source,
				evidence: defect[0]!.properties.evidence,
				verification: defect[0]!.properties.verification,
			};
			expect(JSON.parse(readFileSync(out, "utf8")).results[0].passes[0]).toEqual({
				failed: ["two hunks", "loose"],
				reviews: [
					{
						name: "hit",
						found: true,
						matched: "lines",
						hits: [shown],
						near: [],
						foundBy: [defect[0]!.properties.source],
						...review,
					},
					{
						name: "two hunks",
						matched: "fix hunks",
						hunks: [
							[start, start],
							[last, last + 1],
						],
						hits: [{ ...shown, hunks: [[start, start]] }],
						near: [],
						...review,
					},
					{ name: "beside", found: false, matched: "lines", hits: [], near: [shown], ...review },
					{ name: "miss", found: false, matched: "file and rule", hits: [], near: [], ...review },
					{ name: "loose", matched: "file and rule", hits: [shown], near: [], ...review },
				],
			});
			const adjudicated = runners({ range: vi.fn(async () => ran(defect)) });
			const scored = await measure(
				{
					...settings,
					MELIAN_EVAL_MISSES: missesFile([
						{ name: "hit", repo, base, head, ...at, lines: [start, end] },
						{ name: "beside", repo, base, head, ...at, lines: [end + 1, end + 2] },
						{
							name: "miss",
							repo,
							base,
							head: "feature",
							file: ".github/workflows/claim.yml",
							rule: "secret-exposure",
						},
					]),
					MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
				},
				adjudicated,
			);
			expect(scored.status).toBe(0);
			expect(scored.lines).toContain("pair: worst miss recall 0.33; mean miss recall 0.33; 126 tokens, $9");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("scores a miss located by its fix only when no sighting sits at its file under its rule, however many hunks the fix has", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const head = git(repo, "rev-parse", "feature");
			const at = { file: defect[0]!.properties.path!, rule: defect[0]!.ruleId };
			const [start] = defect[0]!.lines();
			const path = join(repo, at.file);
			const original = readFileSync(path, "utf8").split("\n");
			const last = original.length - 1;
			const fixed = (branch: string, edit: (text: string[]) => string) => {
				git(repo, "checkout", "--quiet", "-b", branch, "feature");
				writeFileSync(path, edit([...original]));
				git(
					repo,
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@example.com",
					"commit",
					"--quiet",
					"--all",
					"-m",
					branch,
				);
			};
			const line = (index: number) => (text: string[]) => {
				text[index - 1] = "// fixed";
				return text.join("\n");
			};
			fixed("at-defect", line(start));
			fixed("far-off", line(10));
			fixed("both-ends", (text) => `${line(start)(text)}// appended\n`);
			const stored = defect[0]!.toJSON();
			const [location] = stored.locations;
			const second = Finding.from({
				...stored,
				locations: [
					{
						...location!,
						physicalLocation: {
							...location!.physicalLocation,
							region: { ...location!.physicalLocation.region, startLine: last, endLine: last },
						},
					},
				],
				properties: { ...defect[0]!.properties, id: "second" },
			});
			const using = runners({ range: vi.fn(async () => ran([defect[0]!, second])) });
			const { status, lines } = await measure(
				{
					...env,
					MELIAN_EVAL_MISSES: missesFile([
						{ name: "one hunk", repo, base, head, ...at, fix: "at-defect" },
						{ name: "off every hunk", repo, base, head, ...at, fix: "far-off" },
						{ name: "two hits", repo, base, head, ...at, fix: "both-ends" },
						{ name: "nothing there", repo, base, head, file: at.file, rule: "secret-exposure", fix: "at-defect" },
					]),
					MELIAN_EVAL_PROBE_SET: "misses",
					MELIAN_EVAL_PROBE_PASSES: "1",
					MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
				},
				using,
			);
			const spent = paid.spend();
			expect(lines).toContain(
				`pair pass 1 one hunk: unadjudicated, no score: the fix changed 1 hunk in ${at.file} (${start}-${start}), and the sightings overlap ${start}-${start}, ${spent}`,
			);
			expect(lines).toContain(
				`pair pass 1 off every hunk: unadjudicated, no score: the fix changed 1 hunk in ${at.file} (10-10), and the sightings overlap none of them, ${spent}`,
			);
			expect(lines).toContain(
				`pair pass 1 two hits: unadjudicated, no score: the fix changed 2 hunks in ${at.file} (${start}-${start}, ${last}-${last + 1}), and the sightings overlap ${start}-${start}, ${last}-${last + 1}, ${spent}`,
			);
			expect(lines).toContain(`pair pass 1 nothing there: missed, ${spent}`);
			expect(lines).toContainEqual(expect.stringMatching(/^pair: no score, 3 reviews had none/));
			expect(status).toBe(1);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("scores a miss only when its review shows a completed trust-boundary run whose scope holds its file", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const head = git(repo, "rev-parse", "feature");
			const at = { file: defect[0]!.properties.path!, rule: defect[0]!.ruleId };
			const [start, end] = defect[0]!.lines();
			const [stage] = paid.stages;
			const lensRun = (...stages: Partial<(typeof paid.stages)[number]>[]) =>
				ran(defect, {
					telemetry: new StageTelemetry(
						"base..head",
						stages.map((fields) => ({ ...stage!, ...fields })),
					),
				});
			const runs = [
				lensRun({ outcome: "ended" }),
				lensRun({ subject: "contracts@1@careful" }),
				lensRun({ coverage: { scope: "", paths: ["docs/**"], nearer: [] } }),
				lensRun({ coverage: { scope: "", paths: ["**"], nearer: [dirname(at.file)] } }),
				lensRun({ role: "prober" }),
				lensRun({ coverage: undefined }),
				lensRun({}),
				lensRun({ outcome: "ended" }, {}),
			];
			const range = vi.fn(async () => runs.shift()!);
			const names = ["cut", "skipped", "elsewhere", "nearer", "prober only", "uncovered", "covered", "one of two"];
			const { status, lines } = await measure(
				{
					...env,
					MELIAN_EVAL_MISSES: missesFile(
						names.map((name) => ({ name, repo, base, head, ...at, lines: [start, end] })),
					),
					MELIAN_EVAL_PROBE_SET: "misses",
					MELIAN_EVAL_PROBE_PASSES: "1",
					MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
				},
				runners({ range }),
			);
			const spent = paid.spend();
			for (const name of names.slice(0, 6))
				expect(lines).toContain(
					`pair pass 1 ${name}: unadjudicated, no score: the review shows no completed trust-boundary run whose scope holds ${at.file}, ${spent}`,
				);
			expect(lines).toContain(`pair pass 1 covered: found, ${spent}`);
			expect(lines).toContainEqual(expect.stringMatching(/^pair pass 1 one of two: found, /));
			expect(lines).toContainEqual(expect.stringMatching(/^pair: no score, 6 reviews had none/));
			expect(status).toBe(1);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("scores a miss only where a trust-boundary run was shown its file or read its lines", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const head = git(repo, "rev-parse", "feature");
			const at = { file: defect[0]!.properties.path!, rule: defect[0]!.ruleId };
			// Lines wider than the defect's one, so each end of the overlap decides a case of its own.
			const [start, line] = defect[0]!.lines();
			const end = line + 3;
			expect(start).toBeGreaterThan(1);
			const [stage] = paid.stages;
			const { shown: _, ...unseen } = stage!;
			const telemetry = (...stages: Partial<(typeof paid.stages)[number]>[]) =>
				new StageTelemetry(
					"base..head",
					stages.map((fields) => ({ ...unseen, ...fields })),
				);
			const lensRun = (...stages: Partial<(typeof paid.stages)[number]>[]) =>
				ran(defect, { telemetry: telemetry(...stages) });
			const read = (path: string, first: number, last: number) => ({
				read: [{ path, ranges: [[first, last] as [number, number]] }],
			});
			const cases: [string, RangeRun, boolean, string][] = [
				["older", lensRun({}), true, "unadjudicated"],
				["unshown", lensRun({ shown: [] }), true, "unadjudicated"],
				["shown another", lensRun({ shown: ["elsewhere.ts"] }), true, "unadjudicated"],
				["read another", lensRun({ shown: [], ...read("elsewhere.ts", start, end) }), true, "unadjudicated"],
				["read before", lensRun({ shown: [], ...read(at.file, 1, start - 1) }), true, "unadjudicated"],
				["read after", lensRun({ shown: [], ...read(at.file, end + 1, end + 9) }), true, "unadjudicated"],
				[
					"prober shown",
					lensRun({ shown: [] }, { role: "prober", shown: [at.file], usage: undefined }),
					true,
					"unadjudicated",
				],
				[
					"ended shown",
					lensRun({ shown: [] }, { outcome: "ended", shown: [at.file], usage: undefined }),
					true,
					"unadjudicated",
				],
				["shown", lensRun({ shown: [at.file] }), true, "found"],
				["second run shown", lensRun({ shown: [] }, { shown: [at.file], usage: undefined }), true, "found"],
				[
					"read another first",
					lensRun({
						shown: [],
						read: [
							{ path: "elsewhere.ts", ranges: [[start, end]] },
							{ path: at.file, ranges: [[start, start]] },
						],
					}),
					true,
					"found",
				],
				[
					"one range inside",
					lensRun({
						shown: [],
						read: [
							{
								path: at.file,
								ranges: [
									[1, 1],
									[start, start],
								],
							},
						],
					}),
					true,
					"found",
				],
				["read to start", lensRun({ shown: [], ...read(at.file, 1, start) }), true, "found"],
				["read from end", lensRun({ shown: [], ...read(at.file, end, end + 9) }), true, "found"],
				[
					"read, missed",
					ran([], { telemetry: telemetry({ shown: [], ...read(at.file, start, start) }) }),
					true,
					"missed",
				],
				["unread, no lines", ran([], { telemetry: telemetry({ shown: [] }) }), false, "unadjudicated"],
				[
					"read, no lines",
					ran([], { telemetry: telemetry({ shown: [], ...read(at.file, end + 1, end + 1) }) }),
					false,
					"missed",
				],
			];
			const runs = cases.map(([, run]) => run);
			const range = vi.fn(async () => runs.shift()!);
			const { lines } = await measure(
				{
					...env,
					MELIAN_EVAL_MISSES: missesFile(
						cases.map(([name, , lined]) => ({
							name,
							repo,
							base,
							head,
							...at,
							...(lined ? { lines: [start, end] } : {}),
						})),
					),
					MELIAN_EVAL_PROBE_SET: "misses",
					MELIAN_EVAL_PROBE_PASSES: "1",
					MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
				},
				runners({ range }),
			);
			for (const [name, run, lined, said] of cases)
				expect(lines).toContain(
					`pair pass 1 ${name}: ${
						said === "unadjudicated"
							? `unadjudicated, no score: never shown to trust-boundary: no completed run of it was shown ${at.file} or ${lined ? `read lines ${start}-${end} of it` : "read it"}`
							: said
					}, ${run.telemetry.spend()}`,
				);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("counts a shown file for a miss's lines only where one of its head-side hunks holds them, and never a deletion", async () => {
		const { repo } = buildGoldenRepository(lost);
		try {
			const at = { file: defect[0]!.properties.path!, rule: defect[0]!.ruleId };
			const base = git(repo, "rev-parse", "feature");
			git(repo, "checkout", "--quiet", "-b", "hunks", "feature");
			const path = join(repo, at.file);
			const text = readFileSync(path, "utf8").split("\n");
			// Head-side hunks at 30, 50-52, and a deletion of line 70, which the head holds as no lines after line 69.
			text[29] = "# changed 30";
			for (const line of [49, 50, 51]) text[line] = `# changed ${line + 1}`;
			text.splice(69, 1);
			writeFileSync(path, text.join("\n"));
			// Another file the range adds, whose one hunk holds every line the misses name.
			writeFileSync(
				join(repo, "other.txt"),
				`${Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
			);
			git(repo, "add", "other.txt");
			git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--all", "-m", "hunks");
			const head = git(repo, "rev-parse", "hunks");
			const shown = ran([], {
				telemetry: new StageTelemetry("base..head", [{ ...paid.stages[0]!, shown: [at.file] }]),
			});
			const cases: [string, [number, number], string][] = [
				["one-line hunk", [30, 30], "missed"],
				["before one-line hunk", [29, 29], "unadjudicated"],
				["after one-line hunk", [31, 31], "unadjudicated"],
				["hunk's first line", [50, 50], "missed"],
				["hunk's last line", [52, 52], "missed"],
				["before hunk", [49, 49], "unadjudicated"],
				["after hunk", [53, 53], "unadjudicated"],
				// The deletion's hunk holds no head line, though one counted as a line would end at 68 and start at 69.
				["deletion", [68, 70], "unadjudicated"],
			];
			const range = vi.fn(async () => shown);
			const { lines } = await measure(
				{
					...env,
					MELIAN_EVAL_MISSES: missesFile(
						cases.map(([name, missed]) => ({ name, repo, base, head, ...at, lines: missed })),
					),
					MELIAN_EVAL_PROBE_SET: "misses",
					MELIAN_EVAL_PROBE_PASSES: "1",
					MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
				},
				runners({ range }),
			);
			for (const [name, [first, last], said] of cases)
				expect(lines).toContain(
					`pair pass 1 ${name}: ${
						said === "unadjudicated"
							? `unadjudicated, no score: never shown to trust-boundary: no completed run of it was shown ${at.file} or read lines ${first}-${last} of it`
							: said
					}, ${shown.telemetry.spend()}`,
				);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("counts a fix-located miss as seen only where the lens was shown or read a line its fix changes", async () => {
		const { repo } = buildGoldenRepository(lost);
		try {
			const at = { file: defect[0]!.properties.path!, rule: defect[0]!.ruleId };
			const base = git(repo, "rev-parse", "feature");
			const commit = (branch: string, from: string, lines: number[]) => {
				git(repo, "checkout", "--quiet", "-b", branch, from);
				const path = join(repo, at.file);
				const text = readFileSync(path, "utf8").split("\n");
				for (const line of lines) text[line - 1] = `# ${branch} ${line}`;
				writeFileSync(path, text.join("\n"));
				git(
					repo,
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@example.com",
					"commit",
					"--quiet",
					"--all",
					"-m",
					branch,
				);
				return git(repo, "rev-parse", branch);
			};
			// The range changes line 30 alone; one fix changes 40-42 and 80, one changes 30, and one changes 30 and 80.
			const head = commit("ranged", base, [30]);
			commit("apart", head, [40, 41, 42, 80]);
			commit("inside", head, [30]);
			commit("both", head, [30, 80]);
			const [stage] = paid.stages;
			const lensRun = (fields: Partial<typeof stage>) =>
				ran([], { telemetry: new StageTelemetry("base..head", [{ ...stage!, shown: [], ...fields }]) });
			const reading = (first: number, last: number) =>
				lensRun({ read: [{ path: at.file, ranges: [[first, last]] }] });
			const cases: [string, string, RangeRun, string][] = [
				["fix's first line", "apart", reading(40, 40), "missed"],
				["fix's last line", "apart", reading(42, 42), "missed"],
				["before fix", "apart", reading(39, 39), "unadjudicated"],
				["after fix", "apart", reading(43, 43), "unadjudicated"],
				["fix's other hunk", "apart", reading(80, 80), "missed"],
				["shown off the fix", "apart", lensRun({ shown: [at.file] }), "unadjudicated"],
				["shown on the fix", "inside", lensRun({ shown: [at.file] }), "missed"],
				["shown on one of the fix's hunks", "both", lensRun({ shown: [at.file] }), "missed"],
			];
			const range = vi.fn();
			for (const [, , run] of cases) range.mockResolvedValueOnce(run);
			const { lines } = await measure(
				{
					...env,
					MELIAN_EVAL_MISSES: missesFile(cases.map(([name, fix]) => ({ name, repo, base, head, ...at, fix }))),
					MELIAN_EVAL_PROBE_SET: "misses",
					MELIAN_EVAL_PROBE_PASSES: "1",
					MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
				},
				runners({ range }),
			);
			for (const [name, fix, run, said] of cases)
				expect(lines).toContain(
					`pair pass 1 ${name}: ${
						said === "unadjudicated"
							? `unadjudicated, no score: never shown to trust-boundary: no completed run of it was shown ${at.file} or read lines ${fix === "apart" ? "40-42, 80-80" : "30-30"} of it`
							: said
					}, ${run.telemetry.spend()}`,
				);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("keeps one corpus's score when only the other's review failed, and records a failure that never reached a review or one it could not score", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const head = git(repo, "rev-parse", "feature");
			const misses = missesFile([
				{ name: "hit", repo, base, head, file: ".github/workflows/claim.yml", rule: "secret-exposure" },
				{ name: "next", repo, base, head, file: ".github/workflows/claim.yml", rule: "secret-exposure" },
			]);
			let goldenCall = 0;
			let missCall = 0;
			const using = runners({
				golden: vi.fn(async (each: Golden) => {
					goldenCall += 1;
					if (goldenCall === 1) throw new Error("no review");
					return { golden: each, ...ran([]) } as GoldenRun;
				}),
				range: vi.fn(async () => {
					missCall += 1;
					if (missCall === 4) throw new Error("clone gone");
					return missCall === 3 ? ran(defect, { sightings: [] }) : ran([]);
				}),
			});
			const out = join(scratch, "failures.json");
			const settings = {
				...env,
				MELIAN_EVAL_MISSES: misses,
				MELIAN_EVAL_PROBE_PASSES: "2",
				MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
				MELIAN_EVAL_PROBE_OUT: out,
			};
			expect((await measure(settings, using)).status).toBe(1);
			const spent = { spend: paid.spend(), telemetry: JSON.parse(JSON.stringify(paid.toJSON())), probers: {} };
			const scored = { notes: [], sharedProberTier: [], ...spent };
			const unmatched = { found: false, matched: "file and rule", hits: [], near: [] };
			const [first, second] = JSON.parse(readFileSync(out, "utf8")).results[0].passes;
			expect(first).toStrictEqual({
				misses: { found: 0, total: 2 },
				failed: [lost.name],
				reviews: [
					{ name: lost.name, kind: "golden", error: "no review", notes: [], sharedProberTier: [] },
					{ name: clean.name, kind: "golden", score: { ...scoreGolden(clean, []) }, ...scored },
					{ name: "hit", kind: "miss", ...unmatched, probedBy: [], ...scored },
					{ name: "next", kind: "miss", ...unmatched, probedBy: [], ...scored },
				],
			});
			expect(second).toStrictEqual({
				goldens: { precision: 1, recall: 0 },
				failed: ["hit", "next"],
				reviews: [
					{ name: lost.name, kind: "golden", score: { ...scoreGolden(lost, []) }, ...scored },
					{ name: clean.name, kind: "golden", score: { ...scoreGolden(clean, []) }, ...scored },
					{
						name: "hit",
						kind: "miss",
						error: `hit: the verdict holds a lens.trust-boundary claim ${defect[0]!.id} from ${defect[0]!.properties.source.version} that the lens never sighted`,
						...scored,
					},
					{ name: "next", kind: "miss", error: "clone gone", notes: [], sharedProberTier: [] },
				],
			});
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses, before any provider, a miss whose file the range leaves alone, whose rule the lens does not declare, or whose lines run past its file", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const head = git(repo, "rev-parse", "feature");
			const at = { file: defect[0]!.properties.path!, rule: defect[0]!.ruleId };
			const length = git(repo, "show", `${head}:${at.file}`).split("\n").length;
			const entry = (name: string, fields: Record<string, unknown>) => ({
				name,
				repo,
				base,
				head,
				...at,
				...fields,
			});
			const valid = entry("valid", { lines: [length, length] });
			const settings = {
				...env,
				MELIAN_EVAL_PROBE_SET: "misses",
				MELIAN_EVAL_PROBE_PASSES: "1",
				MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
			};
			const refused = runners();
			const misses = missesFile([
				entry("unchanged", { file: "README.md" }),
				valid,
				entry("misspelt", { rule: "fail_open" }),
				entry("past", { lines: [length, length + 1] }),
			]);
			expect(await measure({ ...settings, MELIAN_EVAL_MISSES: misses }, refused)).toMatchObject({
				status: 2,
				errors: [
					`The misses file cannot be scored: unchanged: README.md is not among the files ${base}...${head} changes; misspelt: fail_open is not a rule any lens in the base's full tier that reviews ${at.file} declares; past: lines ${length}-${length + 1} run past ${at.file}, which has ${length} lines at ${head}`,
				],
			});
			expect(refused.models).not.toHaveBeenCalled();
			expect(refused.range).not.toHaveBeenCalled();
			const using = runners();
			expect((await measure({ ...settings, MELIAN_EVAL_MISSES: missesFile([valid]) }, using)).status).toBe(0);
			expect(using.range).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("scores a miss in whole mode only on its lines, and records each responsible lens that never saw them and each prober that completed", async () => {
		const failOpen = golden("trust-boundary-fail-open");
		const { repo, base, head } = buildGoldenRepository(failOpen);
		try {
			const at = { repo, base, head, file: "src/scan.ts", rule: "fail-open", alternativeRules: ["wrong-result"] };
			const settings = {
				...env,
				MELIAN_EVAL_MISS_REVIEW: "whole",
				MELIAN_EVAL_PROBE_SET: "misses",
				MELIAN_EVAL_PROBE_PASSES: "1",
				MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
			};
			const lined = { name: "lined", ...at, lines: [16, 16] };
			for (const [names, said] of [
				[["unlined"], "unlined has"],
				[["one", "two"], "one, two have"],
			] as const) {
				const refused = runners();
				expect(
					await measure(
						{ ...settings, MELIAN_EVAL_MISSES: missesFile([lined, ...names.map((name) => ({ name, ...at }))]) },
						refused,
					),
				).toMatchObject({
					status: 2,
					errors: [
						`MELIAN_EVAL_MISS_REVIEW=whole scores a miss only on its hand-entered lines, which ${said} none of`,
					],
				});
				expect(refused.models).not.toHaveBeenCalled();
			}
			const foreign = { ...lined, name: "foreign", rule: "wrong-result", alternativeRules: ["null-dereference"] };
			const misspelt = { ...lined, name: "misspelt", alternativeRules: ["wrong_result"] };
			for (const review of ["lens", "whole"]) {
				const refused = runners();
				expect(
					await measure(
						{ ...settings, MELIAN_EVAL_MISS_REVIEW: review, MELIAN_EVAL_MISSES: missesFile([foreign, misspelt]) },
						refused,
					),
					review,
				).toMatchObject({
					status: 2,
					errors: [
						`The misses file cannot be scored: ${
							review === "lens"
								? "foreign: wrong-result or null-dereference is not a rule the base's trust-boundary lens declares; "
								: ""
						}misspelt: wrong_result is not a rule any lens in the base's full tier that reviews src/scan.ts declares`,
					],
				});
				expect(refused.models).not.toHaveBeenCalled();
			}
			const stage = paid.stages[0]!;
			const telemetry = new StageTelemetry("base..head", [
				{ ...stage, id: "c", subject: "correctness@1@careful", shown: [] },
				{ ...stage, id: "p", subject: "trust-boundary@1@deep", role: "prober", shown: [failOpen.name] },
				{ ...stage, id: "q", subject: "trust-boundary@1@deep", role: "prober", shown: [] },
				{ ...stage, id: "r", subject: "contracts@1@deep", role: "prober", outcome: "failed", shown: [] },
				{ ...stage, id: "s", subject: "design@1@deep", role: "prober", shown: [] },
			]);
			const out = join(scratch, "whole-results.json");
			const using = runners({ range: vi.fn(async () => ran([], { telemetry })) });
			const { lines } = await measure(
				{ ...settings, MELIAN_EVAL_MISSES: missesFile([lined]), MELIAN_EVAL_PROBE_OUT: out },
				using,
			);
			expect(lines).toContain(
				`pair pass 1 lined: unadjudicated, no score: never shown to correctness: no completed run of it was shown src/scan.ts or read lines 16-16 of it; the review shows no completed trust-boundary run whose scope holds src/scan.ts, ${telemetry.spend()}`,
			);
			const [target] = vi.mocked(using.range).mock.calls[0]!;
			const config = (await loadConfig(repo, { kind: "revision", commit: base }, ".")).config;
			expect(target.scope!(config, []).config.tiers.full).toEqual(config.tiers.full);
			const results = JSON.parse(readFileSync(out, "utf8"));
			expect(results).toMatchObject({ version: 2, missReview: "whole", probeLenses: ["trust-boundary"] });
			expect(results.misses).toEqual([
				expect.objectContaining({
					name: "lined",
					rules: ["fail-open", "wrong-result"],
					lenses: ["correctness", "trust-boundary"],
				}),
			]);
			expect(results.results[0].passes[0].reviews[0]).toMatchObject({
				probedBy: ["design", "trust-boundary"],
				unseen: [
					{ lens: "correctness", why: "never shown" },
					{ lens: "trust-boundary", why: "not run" },
				],
			});
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("accepts a miss whose rule only its own folder's lens declares, in a range that changes other files too", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const file = defect[0]!.properties.path!;
			const commit = (message: string) =>
				git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message);
			git(repo, "checkout", "--quiet", "-b", "nested", base);
			const lens = join(repo, ".github/.melian/lenses/trust-boundary/LENS.md");
			mkdirSync(dirname(lens), { recursive: true });
			writeFileSync(
				lens,
				"---\nname: trust-boundary\nextends: trust-boundary\nrules:\n  - id: nested-only\n    description: A rule only this folder declares.\n---\n",
			);
			git(repo, "add", "--all");
			commit("nested lens");
			const nested = git(repo, "rev-parse", "HEAD");
			git(repo, "checkout", "--quiet", "feature", "--", file);
			writeFileSync(join(repo, "other.txt"), "another changed file\n");
			git(repo, "add", "--all");
			commit("wider head");
			const wider = git(repo, "rev-parse", "HEAD");
			const using = runners();
			const { status, errors } = await measure(
				{
					...env,
					MELIAN_EVAL_MISSES: missesFile([
						{ name: "nested", repo, base: nested, head: wider, file, rule: "nested-only" },
					]),
					MELIAN_EVAL_PROBE_SET: "misses",
					MELIAN_EVAL_PROBE_PASSES: "1",
					MELIAN_EVAL_PROBE_TRUST: `${nested},${wider}`,
				},
				using,
			);
			expect(errors).toEqual([]);
			expect(status).toBe(0);
			expect(using.range).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("reviews a miss with the base's full tier in whole mode, and with trust-boundary alone in lens mode, in the tier or not", async () => {
		const { repo, head } = buildGoldenRepository(golden("trust-boundary-fail-open"));
		try {
			const commit = (message: string) =>
				git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message);
			// A base with its own policy, and a head on it that changes the miss's file.
			const tiered = (branch: string, policy: string) => {
				git(repo, "checkout", "--quiet", "-b", branch, head);
				writeFileSync(join(repo, "melian.yaml"), policy);
				git(repo, "add", "--all");
				commit(branch);
				const base = git(repo, "rev-parse", "HEAD");
				writeFileSync(
					join(repo, "src/scan.ts"),
					`${readFileSync(join(repo, "src/scan.ts"), "utf8")}// ${branch}\n`,
				);
				git(repo, "add", "--all");
				commit(`${branch} head`);
				return { base, head: git(repo, "rev-parse", "HEAD") };
			};
			const measured = async (range: { base: string; head: string }, review: string, rule: string) => {
				const using = runners();
				const { status, errors } = await measure(
					{
						...env,
						MELIAN_EVAL_MISS_REVIEW: review,
						MELIAN_EVAL_MISSES: missesFile([
							{ name: "m", repo, ...range, file: "src/scan.ts", rule, lines: [16, 16] },
						]),
						MELIAN_EVAL_PROBE_SET: "misses",
						MELIAN_EVAL_PROBE_PASSES: "1",
						MELIAN_EVAL_PROBE_TRUST: `${range.base},${range.head}`,
					},
					using,
				);
				return { status, errors, reviews: vi.mocked(using.range).mock.calls.length };
			};
			// Reviewed and unscored, since the fake review shows no lens the file.
			const accepted = { status: 1, errors: [], reviews: 1 };
			const refused = (reason: string) => ({
				status: 2,
				errors: [`The misses file cannot be scored: m: ${reason}`],
				reviews: 0,
			});
			const undeclared = (rule: string) =>
				refused(`${rule} is not a rule any lens in the base's full tier that reviews src/scan.ts declares`);
			const correctness = tiered("correctness", "tiers:\n  full: [lens.correctness]\n");
			expect(await measured(correctness, "lens", "fail-open")).toEqual(accepted);
			expect(await measured(correctness, "whole", "fail-open")).toEqual(undeclared("fail-open"));
			expect(await measured(correctness, "whole", "wrong-result")).toEqual(accepted);
			const boundary = tiered("boundary", "tiers:\n  full: [lens.trust-boundary]\n");
			expect(await measured(boundary, "lens", "wrong-result")).toEqual(undeclared("wrong-result"));
			const uncovered = tiered(
				"uncovered",
				'tiers:\n  full: [lens.trust-boundary]\nlenses:\n  trust-boundary:\n    paths: ["**", "!src/scan.ts"]\n',
			);
			expect(await measured(uncovered, "whole", "fail-open")).toEqual(
				refused("the base's policy does not let a lens in the base's full tier review src/scan.ts"),
			);
			expect(await measured(uncovered, "lens", "fail-open")).toEqual(
				refused("the base's policy does not let the trust-boundary lens review src/scan.ts"),
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("accepts a miss on a file the head renamed only when the base's policy lets trust-boundary review its old path, as the review does", async () => {
		const { repo } = buildGoldenRepository(lost);
		try {
			const file = defect[0]!.properties.path!;
			const rule = defect[0]!.ruleId;
			const renamed = `moved/${basename(file)}`;
			const commit = (message: string) =>
				git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message);
			const floor = "    level: { floor: deep }\n";
			const policy = `${git(repo, "show", "feature:melian.yaml")}\n`;
			// A base whose trust-boundary paths are `paths`, and a head on it that renames the file into `moved/` and changes
			// a file the lens still reviews, so the lens is selected either way.
			const renaming = (branch: string, paths: string) => {
				git(repo, "checkout", "--quiet", "-b", branch, "feature");
				expect(policy).toContain(floor);
				writeFileSync(join(repo, "melian.yaml"), policy.replace(floor, `${floor}    paths: ${paths}\n`));
				git(repo, "add", "--all");
				commit(branch);
				const base = git(repo, "rev-parse", "HEAD");
				mkdirSync(join(repo, "moved"), { recursive: true });
				git(repo, "mv", file, renamed);
				writeFileSync(join(repo, renamed), `${readFileSync(join(repo, renamed), "utf8")}# moved\n`);
				writeFileSync(join(repo, "other.txt"), `${branch}\n`);
				git(repo, "add", "--all");
				commit(`${branch} rename`);
				return { base, head: git(repo, "rev-parse", "HEAD") };
			};
			const covered = renaming("covered", `["**", "!moved/**"]`);
			const excluded = renaming("excluded", `["**", "!moved/**", "!${file}"]`);
			const run = (name: string, { base, head }: { base: string; head: string }) => {
				const using = runners();
				const result = measure(
					{
						...env,
						MELIAN_EVAL_MISSES: missesFile([{ name, repo, base, head, file: renamed, rule }]),
						MELIAN_EVAL_PROBE_SET: "misses",
						MELIAN_EVAL_PROBE_PASSES: "1",
						MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
					},
					using,
				);
				return { using, result };
			};
			const accepted = run("covered", covered);
			const { status, errors } = await accepted.result;
			expect({ status, errors }).toEqual({ status: 0, errors: [] });
			expect(accepted.using.range).toHaveBeenCalledTimes(1);
			const refused = run("excluded", excluded);
			expect(await refused.result).toMatchObject({
				status: 2,
				errors: [
					`The misses file cannot be scored: excluded: the base's policy does not let the trust-boundary lens review ${renamed}`,
				],
			});
			expect(refused.using.range).not.toHaveBeenCalled();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("accepts a miss on a file at the size a lens can read, and refuses, before any provider, one the lens's reader cuts a byte past it, and a symlink it does not follow", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const file = defect[0]!.properties.path!;
			const rule = defect[0]!.ruleId;
			const sized = (branch: string, bytes: number, first = "") => {
				git(repo, "checkout", "--quiet", "-b", branch, "feature");
				writeFileSync(join(repo, file), `${first}${"x".repeat(bytes - first.length - 1)}\n`);
				git(
					repo,
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@example.com",
					"commit",
					"--quiet",
					"--all",
					"-m",
					branch,
				);
				return git(repo, "rev-parse", "HEAD");
			};
			const run = (name: string, head: string, rules: object = { rule }) => {
				const using = runners();
				const result = measure(
					{
						...env,
						MELIAN_EVAL_MISSES: missesFile([{ name, repo, base, head, file, ...rules }]),
						MELIAN_EVAL_PROBE_SET: "misses",
						MELIAN_EVAL_PROBE_PASSES: "1",
						MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
					},
					using,
				);
				return { using, result };
			};
			const atBound = sized("at-bound", revisionLimits.fileBytes);
			const accepted = run("at-bound", atBound);
			expect(await accepted.result).toMatchObject({ status: 0, errors: [] });
			expect(accepted.using.range).toHaveBeenCalledTimes(1);
			const pastBound = sized("past-bound", revisionLimits.fileBytes + 1);
			const refused = run("past-bound", pastBound);
			expect(await refused.result).toMatchObject({
				status: 2,
				errors: [
					`The misses file cannot be scored: past-bound: a lens reads only the first 0 lines of ${file} at ${pastBound}, which it cuts at ${revisionLimits.fileBytes} bytes`,
				],
			});
			expect(refused.using.models).not.toHaveBeenCalled();
			expect(refused.using.range).not.toHaveBeenCalled();
			// A miss with no lines is scored on what a lens reads, here the one whole line before the cut.
			const cutAfterALine = run("cut", sized("cut", revisionLimits.fileBytes + 1, "short\n"));
			expect(await cutAfterALine.result).toMatchObject({ status: 0, errors: [] });
			expect(cutAfterALine.using.range).toHaveBeenCalledTimes(1);
			const ruleless = run("ruleless", atBound, { lines: [1, 1] });
			expect(await ruleless.result).toMatchObject({ status: 0, errors: [] });
			expect(ruleless.using.range).toHaveBeenCalledTimes(1);
			git(repo, "checkout", "--quiet", "-b", "linked", "feature");
			rmSync(join(repo, file));
			symlinkSync("elsewhere", join(repo, file));
			git(repo, "add", "--all");
			git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "linked");
			const linkedHead = git(repo, "rev-parse", "HEAD");
			const linked = run("linked", linkedHead);
			expect(await linked.result).toMatchObject({
				status: 2,
				errors: [`The misses file cannot be scored: linked: ${file} is a symbolic link at ${linkedHead}`],
			});
			expect(linked.using.range).not.toHaveBeenCalled();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses, before any provider, a miss on a file the lens's reader refuses as binary", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const file = defect[0]!.properties.path!;
			const rule = defect[0]!.ruleId;
			git(repo, "checkout", "--quiet", "-b", "binary", "feature");
			writeFileSync(join(repo, file), `${readFileSync(join(repo, file), "utf8")}\0\n`);
			git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--all", "-m", "binary");
			const head = git(repo, "rev-parse", "HEAD");
			const using = runners();
			const result = await measure(
				{
					...env,
					MELIAN_EVAL_MISSES: missesFile([{ name: "binary", repo, base, head, file, rule }]),
					MELIAN_EVAL_PROBE_SET: "misses",
					MELIAN_EVAL_PROBE_PASSES: "1",
					MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
				},
				using,
			);
			expect({ status: result.status, errors: result.errors }).toEqual({
				status: 2,
				errors: [`The misses file cannot be scored: binary: ${file} is binary at ${head}`],
			});
			expect(using.models).not.toHaveBeenCalled();
			expect(using.range).not.toHaveBeenCalled();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("accepts a renamed miss's rule when either trust-boundary lens that reviews the file declares it, and refuses one neither does", async () => {
		const { repo } = buildGoldenRepository(lost);
		try {
			const commit = (message: string) =>
				git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message);
			git(repo, "checkout", "--quiet", "-b", "two-lenses", "feature");
			const lens = join(repo, ".github/.melian/lenses/trust-boundary/LENS.md");
			mkdirSync(dirname(lens), { recursive: true });
			writeFileSync(
				lens,
				"---\nname: trust-boundary\nextends: trust-boundary\nrules:\n  - id: nested-only\n    description: A rule only this folder declares.\n---\n",
			);
			writeFileSync(join(repo, "root.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
			git(repo, "add", "--all");
			commit("nested lens and a root file");
			const base = git(repo, "rev-parse", "HEAD");
			git(repo, "mv", "root.txt", ".github/root.txt");
			writeFileSync(join(repo, ".github/root.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
			git(repo, "add", "--all");
			commit("rename into the nested folder");
			const head = git(repo, "rev-parse", "HEAD");
			const run = (rule: string) => {
				const using = runners();
				const result = measure(
					{
						...env,
						MELIAN_EVAL_MISSES: missesFile([{ name: rule, repo, base, head, file: ".github/root.txt", rule }]),
						MELIAN_EVAL_PROBE_SET: "misses",
						MELIAN_EVAL_PROBE_PASSES: "1",
						MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
					},
					using,
				);
				return { using, result };
			};
			for (const rule of ["nested-only", "fail-open"]) {
				const accepted = run(rule);
				const { status, errors } = await accepted.result;
				expect({ rule, status, errors }).toEqual({ rule, status: 0, errors: [] });
				expect(accepted.using.range).toHaveBeenCalledTimes(1);
			}
			const refused = run("neither");
			expect(await refused.result).toMatchObject({
				status: 2,
				errors: [
					"The misses file cannot be scored: neither: neither is not a rule any lens in the base's full tier that reviews .github/root.txt declares",
				],
			});
			expect(refused.using.range).not.toHaveBeenCalled();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses, before any provider, a miss on a file the base's policy keeps from trust-boundary, and one empty or gone at the head", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const file = defect[0]!.properties.path!;
			const rule = defect[0]!.ruleId;
			const commit = (message: string) =>
				git(
					repo,
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@example.com",
					"commit",
					"--quiet",
					"--all",
					"-m",
					message,
				);
			const policy = readFileSync(join(repo, "melian.yaml"), "utf8");
			const floor = "    level: { floor: deep }\n";
			const based = (branch: string, setting: string) => {
				git(repo, "checkout", "--quiet", "-b", branch, base);
				writeFileSync(join(repo, "melian.yaml"), policy.replace(floor, `${floor}    ${setting}\n`));
				commit(branch);
				return git(repo, "rev-parse", "HEAD");
			};
			const narrowed = based("narrowed", `paths: ["**", "!${file}"]`);
			const disabled = based("disabled", "enabled: false");
			const changed = (branch: string, from: string, change: () => void) => {
				git(repo, "checkout", "--quiet", "-b", branch, from);
				git(repo, "checkout", "--quiet", "feature", "--", ".");
				change();
				git(repo, "add", "--all");
				commit(branch);
				return git(repo, "rev-parse", "HEAD");
			};
			const narrowedHead = changed("narrowed-head", narrowed, () => {});
			const disabledHead = changed("disabled-head", disabled, () => {});
			const empty = changed("empty", base, () => writeFileSync(join(repo, file), ""));
			const kept = changed("kept", base, () => {});
			const gone = changed("gone", kept, () => rmSync(join(repo, file)));
			const entry = (name: string, from: string, to: string) => ({ name, repo, base: from, head: to, file, rule });
			const using = runners();
			const { status, errors } = await measure(
				{
					...env,
					MELIAN_EVAL_MISSES: missesFile([
						entry("narrowed", narrowed, narrowedHead),
						entry("disabled", disabled, disabledHead),
						entry("empty", base, empty),
						entry("gone", kept, gone),
					]),
					MELIAN_EVAL_PROBE_SET: "misses",
					MELIAN_EVAL_PROBE_PASSES: "1",
					MELIAN_EVAL_PROBE_TRUST: [narrowed, narrowedHead, disabled, disabledHead, base, empty, kept, gone].join(
						",",
					),
				},
				using,
			);
			expect({ status, errors }).toEqual({
				status: 2,
				errors: [
					`The misses file cannot be scored: narrowed: the base's policy does not let the trust-boundary lens review ${file}; disabled: the base's policy does not let the trust-boundary lens review ${file}; empty: ${file} is empty at ${empty}; gone: ${file} does not exist at ${gone}`,
				],
			});
			expect(using.models).not.toHaveBeenCalled();
			expect(using.range).not.toHaveBeenCalled();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("records what it measured: the checkout's commit, and each miss's names and the commits they resolve to", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const head = git(repo, "rev-parse", "feature");
			git(repo, "branch", "moving-base", base);
			const fields = { file: ".github/workflows/claim.yml", rule: "secret-exposure" };
			const misses = missesFile([
				{ name: "named", repo, base: "moving-base", head: "feature", ...fields, lines: [2, 3] },
			]);
			const using = runners();
			const out = join(scratch, "provenance.json");
			const settings = {
				...env,
				MELIAN_EVAL_MISSES: misses,
				MELIAN_EVAL_PROBE_SET: "misses",
				MELIAN_EVAL_PROBE_PASSES: "1",
				MELIAN_EVAL_PROBE_TRUST: `${base},${head}`,
				MELIAN_EVAL_PROBE_OUT: out,
			};
			expect((await measure(settings, using)).status).toBe(0);
			expect(vi.mocked(using.range).mock.calls[0]![0]).toMatchObject({ base, range: `${base}...${head}` });
			const checkout = import.meta.dirname;
			const { results: _, ...provenance } = JSON.parse(readFileSync(out, "utf8"));
			expect(provenance).toEqual({
				version: 2,
				commit: git(checkout, "rev-parse", "HEAD"),
				clean: git(checkout, "status", "--porcelain") === "",
				complete: true,
				verifier: "c/verify",
				passes: 1,
				missReview: "lens",
				probeLenses: ["trust-boundary"],
				misses: [
					{
						name: "named",
						repo,
						base: "moving-base",
						head: "feature",
						file: fields.file,
						rules: [fields.rule],
						lenses: ["trust-boundary"],
						lines: [2, 3],
						baseCommit: base,
						headCommit: head,
						location: { by: "lines", ranges: [[2, 3]] },
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
			const run = await runRange(miss.target(ProbeTrust.parse(`${base},${head}`)), {
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
			const { paths } = (await Lens.load(repo, { kind: "revision", commit: base }, ["x"])).find(
				(lens) => lens.name === "trust-boundary",
			)!;
			const covered = run.telemetry.stages.filter((stage) => stage.name === "melian.lens");
			expect(covered.length).toBeGreaterThan(0);
			for (const stage of covered) expect(stage.coverage).toEqual({ scope: "", paths: [...paths], nearer: [] });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("returns each lens check's own sightings at the head beside the verdict, for a range and a golden alike", async () => {
		const failOpen = golden("trust-boundary-fail-open");
		const { repo, base } = buildGoldenRepository(failOpen);
		try {
			const head = git(repo, "rev-parse", "feature");
			const paths = ["src/scan.ts", "src/rules.ts"];
			const lenses = await Lens.load(repo, { kind: "revision", commit: base }, paths);
			scriptLenses(fake, lenses, { "trust-boundary": failOpen.script["trust-boundary"]!, verifier: {} });
			const miss = Miss.load(
				missesFile([{ name: "m", repo, base, head, file: "src/scan.ts", rule: "fail-open", lines: [16, 16] }]),
			)[0]!;
			const run = await runRange(miss.target(ProbeTrust.parse(`${base},${head}`)), {
				kind: "live",
				models: fake.review,
				verifierModel: `${provider}/plan`,
				probing: ProbingCombination.parse(`off=${provider}/plan`, "medium"),
			});
			expect(run.findings.map((finding) => finding.id)).toHaveLength(1);
			expect(run.sightings.map((each) => [each.id, each.properties.source.check, each.lines()])).toEqual([
				[run.findings[0]!.id, "lens.trust-boundary", [16, 16]],
			]);
			expect(miss.match(run, await miss.locate(head)).hits).toHaveLength(1);
			const scripted = await runGolden(failOpen, { kind: "scripted" });
			expect(scripted.sightings.map((each) => [each.properties.source.check, each.lines()])).toEqual([
				["lens.trust-boundary", [16, 16]],
			]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("reads each level's own sighting of a check's findings, though two levels share an ID, and no other check's", async () => {
		const fakes = createFakeModels();
		const harness = await openHarness(createMemoryStorage(), { models: fakes.models, registry: createRegistry() });
		try {
			const root = await harness.root(backgroundContext, { agent: { model: fakes.ref() } });
			const reported: FindingInput = {
				rule: "fail-open",
				message: "fails open",
				file: "src/scan.ts",
				startLine: 12,
				snippet: "return true",
				occurrence: 0,
				cause: "introduced",
				severity: "P1",
				resolution: "block",
				explanation: { what: "w", whyHere: "y", whatToDo: "d" },
				source: { check: "lens.trust-boundary", version: "quick1" },
			};
			const quick = Finding.create(reported);
			const careful = Finding.create({
				...reported,
				startLine: 40,
				endLine: 44,
				severity: "P2",
				source: { check: "lens.trust-boundary", version: "careful1" },
			});
			const deep = Finding.create({
				...reported,
				snippet: "return false",
				source: { check: "lens.trust-boundary", version: "deep1" },
			});
			const security = Finding.create({
				...reported,
				snippet: "allow",
				source: { check: "lens.security", version: "s1" },
			});
			expect(careful.id).toBe(quick.id);
			for (const each of [quick, careful, deep, security])
				await root.commit((tx) => upsertFinding(tx, root.id, each, "rev"), backgroundContext);
			const read = await sightingsAt(harness, root.id, "rev", "lens.trust-boundary");
			expect(
				read
					.map((each) => [each.id, each.properties.source.version, each.lines()])
					.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
			).toEqual(
				[
					[quick.id, "quick1", [12, 12]],
					[quick.id, "careful1", [40, 44]],
					[deep.id, "deep1", [12, 12]],
				].toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
			);
		} finally {
			await harness.close(backgroundContext);
		}
	});

	it("probes a miss at whichever level its review picks, when its base policy sets no floor", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			const seen: string[] = [];
			const plan = (_: unknown, model: string) => {
				seen.push(model);
				return seen.length === 1
					? fauxAssistantMessage([fauxToolCall("record_plan", { attacks: [] })], { stopReason: "toolUse" })
					: fauxAssistantMessage("Planned 0.");
			};
			// The lens without probes answers too, so a review that drops the probe finishes and fails for that.
			scriptConversations(fake, [
				{ match: "Your role at this level: the attack planner", replies: [plan, plan] },
				{ match: "trust-boundary", replies: [fauxAssistantMessage("No findings.")] },
			]);
			// A miss reviews a repository on Melian's own lenses, whose committed levels hold no probe.
			git(repo, "checkout", "--quiet", "-b", "floorless", base);
			const policy = readFileSync(join(repo, "melian.yaml"), "utf8");
			writeFileSync(join(repo, "melian.yaml"), policy.slice(0, policy.indexOf("lenses:")));
			const lens = ".melian/lenses/trust-boundary/LENS.md";
			cpSync(join(import.meta.dirname, "../../..", lens), join(repo, lens));
			const commit = (message: string) => {
				git(repo, "add", "--all");
				git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message);
				return git(repo, "rev-parse", "HEAD");
			};
			const floorless = commit("no level floor, no committed probe");
			cpSync(join(lost.directory, "head/.github"), join(repo, ".github"), { recursive: true });
			const head = commit("head");
			const miss = Miss.load(
				missesFile([{ name: "m", repo, base: floorless, head, file: "x", rule: "fail-open" }]),
			)[0]!;
			const run = await runRange(miss.target(ProbeTrust.parse(`${floorless},${head}`)), {
				kind: "live",
				models: fake.review,
				verifierModel: `${provider}/plan`,
				probing: ProbingCombination.parse(`pair=${provider}/plan>${provider}/probe`, "medium"),
			});
			expect(seen).toEqual(["plan", "plan"]);
			expect(run.notes).toEqual([
				{ reason: expect.stringMatching(/planner found no attack/), checks: ["lens.trust-boundary"] },
			]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("scores a miss in whole mode on a lens other than trust-boundary, under its alternative rule, and in lens mode as before", async () => {
		const failOpen = golden("trust-boundary-fail-open");
		const { repo, base } = buildGoldenRepository(failOpen);
		try {
			const head = git(repo, "rev-parse", "feature");
			const paths = ["src/scan.ts", "src/rules.ts"];
			const lenses = await Lens.load(repo, { kind: "revision", commit: base }, paths);
			const [read, report, reported] = failOpen.script["trust-boundary"]!;
			if (report === undefined || !("calls" in report)) throw new Error("the golden's script reports nothing");
			const [call] = report.calls;
			const wrong = { calls: [{ ...call!, arguments: { ...call!.arguments, rule: "wrong-result" } }] };
			const script = () =>
				scriptLenses(fake, lenses, {
					...Object.fromEntries(lenses.map(({ name }) => [name, [{ text: "Reported 0 findings." }]])),
					correctness: [wrong, reported!],
					"trust-boundary": [read!, { text: "Reported 0 findings." }],
					verifier: {},
				});
			const miss = Miss.load(
				missesFile([
					{
						name: "m",
						repo,
						base,
						head,
						file: "src/scan.ts",
						rule: "fail-open",
						alternativeRules: ["wrong-result"],
						lines: [16, 16],
					},
				]),
			)[0]!;
			const trust = ProbeTrust.parse(`${base},${head}`);
			const location = await miss.locate(head);
			const live = {
				kind: "live",
				models: fake.review,
				model: `${provider}/plan`,
				verifierModel: `${provider}/plan`,
				probing: ProbingCombination.parse(`off=${provider}/plan`, "medium"),
			} as const;
			const whole = miss.target(trust, "whole", ["trust-boundary"]);
			expect(await miss.reviewers(whole, "whole")).toEqual({ lenses: ["correctness", "trust-boundary"] });
			script();
			const reviewed = await runRange(whole, live);
			expect(
				miss.match(reviewed, location, "whole").hits.map(({ lines, sightedBy }) => [sightedBy.check, lines]),
			).toEqual([["lens.correctness", [16, 16]]]);
			expect(miss.match(reviewed, location, "lens").hits).toEqual([]);
			const ruled = (rules: Record<string, unknown>) =>
				Miss.load(missesFile([{ name: "r", repo, base, head, file: "src/scan.ts", lines: [16, 16], ...rules }]))[0]!
					.match(reviewed, location, "whole")
					.hits.map(({ sightedBy }) => sightedBy.check);
			expect(ruled({ rule: "wrong-result" })).toEqual(["lens.correctness"]);
			expect(ruled({ rule: "fail-open" })).toEqual([]);
			expect(ruled({ rule: "fail-open", alternativeRules: ["null-dereference"] })).toEqual([]);
			expect(ruled({ rule: "null-dereference", alternativeRules: ["wrong-result"] })).toEqual(["lens.correctness"]);
			expect(ruled({})).toEqual(["lens.correctness"]);
			const lensTarget = miss.target(trust);
			expect(await miss.reviewers(lensTarget, "lens")).toEqual({ lenses: ["trust-boundary"] });
			script();
			const alone = await runRange(lensTarget, live);
			expect(alone.sightings).toEqual([]);
			expect(
				alone.telemetry.stages
					.filter(({ name }) => name === "melian.lens")
					.map(({ subject }) => subject.split("@")[0]),
			).toEqual(["trust-boundary"]);
			expect(miss.match(alone, location, "lens")).toEqual({ matched: "lines", hits: [], near: [] });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("gives no score to a range whose base or head the invocation does not vouch for, since its probes cannot run", async () => {
		const { repo, base } = buildGoldenRepository(lost);
		try {
			scriptConversations(fake, [
				{
					match: "trust-boundary",
					replies: [fauxAssistantMessage("Nothing to report."), fauxAssistantMessage("Nothing to report.")],
				},
			]);
			const miss = Miss.load(
				missesFile([{ name: "m", repo, base, head: "feature", file: "x", rule: "fail-open" }]),
			)[0]!;
			for (const vouched of [sha, git(repo, "rev-parse", "feature")])
				await expect(
					runRange(miss.target(ProbeTrust.parse(vouched)), {
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

describe("an arm that needs the graph", { timeout: 60_000 }, () => {
	it("fails its review when Enola's graph of the head cannot be read", async () => {
		const { repo, base, head } = buildGoldenRepository(golden("trust-boundary-fail-open"));
		try {
			const fake = createFakeModels({ models: [{ id: "x" }] });
			const target = Miss.load(
				missesFile([{ name: "m", repo, base, head, file: "src/scan.ts", rule: "fail-open" }]),
			)[0]!.target(ProbeTrust.parse(`${base},${head}`), "whole", []);
			await expect(
				runRange(target, {
					kind: "live",
					models: fake.review,
					model: `${fake.ref("x").provider}/x`,
					probing: { graph: true, routed: (config, lenses) => ({ config, lenses }) },
				}),
			).rejects.toThrow(/^The arm needs Enola's graph of the head, which could not be read: /);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("a live review that keeps its store", { timeout: 60_000 }, () => {
	it("writes the store to its file, and refuses a file that already holds one", async () => {
		const failOpen = golden("trust-boundary-fail-open");
		const { repo, base } = buildGoldenRepository(failOpen);
		try {
			const fake = createFakeModels({ models: [{ id: "plan" }] });
			const provider = fake.ref("plan").provider;
			const head = git(repo, "rev-parse", "feature");
			const lenses = await Lens.load(repo, { kind: "revision", commit: base }, ["src/scan.ts", "src/rules.ts"]);
			scriptLenses(fake, lenses, { "trust-boundary": failOpen.script["trust-boundary"]!, verifier: {} });
			const miss = Miss.load(
				missesFile([{ name: "m", repo, base, head, file: "src/scan.ts", rule: "fail-open" }]),
			)[0]!;
			const store = join(scratch, "kept.sqlite");
			const mode = {
				kind: "live",
				models: fake.review,
				verifierModel: `${provider}/plan`,
				probing: ProbingCombination.parse(`off=${provider}/plan`, "medium"),
				store,
			} as const;
			const run = await runRange(miss.target(ProbeTrust.parse(`${base},${head}`)), mode);
			const kept = await openSqliteStorage(store);
			try {
				const target = miss.target(ProbeTrust.parse(`${base},${head}`));
				const key = Revision.key((await Changeset.resolve(repo, target.range)).revision);
				const stages = (await TelemetryReader.open(kept).read(key)).stages.map(({ id, subject }) => [id, subject]);
				expect(stages.length).toBeGreaterThan(0);
				expect(stages).toEqual(run.telemetry.stages.map(({ id, subject }) => [id, subject]));
			} finally {
				await kept.close(backgroundContext);
			}
			await expect(runRange(miss.target(ProbeTrust.parse(`${base},${head}`)), mode)).rejects.toThrow(
				`${store} already holds a store, which this review would resume rather than measure afresh`,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

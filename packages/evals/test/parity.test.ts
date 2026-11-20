import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChangedFile,
	Changeset,
	defaultConfig,
	type Hunk,
	Lens,
	lensGraphToolNames,
	type MelianConfig,
	Revision,
	Verdict,
	visibleText,
} from "@melian-agent/core";
import {
	backgroundContext,
	openSqliteStorage,
	StageTelemetry,
	TelemetryReader,
	TokenUsage,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildGoldenRepository,
	commitGoldenTree,
	type LiveGoldenMode,
	loadGoldens,
	type RangeRun,
	type ReviewTarget,
	runRange,
} from "../src/goldens.ts";
import {
	CommittedArm,
	checkoutCommit,
	graphGuidance,
	measureParity,
	ParityArm,
	type ParityResults,
	type ParityRunners,
	parityArmName,
} from "../src/parity.ts";
import { Miss } from "../src/probing.ts";
import { GoldenRunError } from "../src/run-error.ts";

let scratch: string;
beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "melian-parity-eval-")));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const config: MelianConfig = {
	...defaultConfig,
	models: {
		heavy: { model: "h/heavy", thinking: "low", fallbacks: ["h/other"] },
		medium: { model: "m/medium", fallbacks: ["m/other"] },
		light: { model: "l/light" },
		verifier: { model: "v/verify", fallbacks: ["v/other"] },
	},
	tiers: { ...defaultConfig.tiers, full: ["lens.a", "lens.b"] },
	stages: { ...defaultConfig.stages, "pull-request": "full" },
	lenses: { a: { route: { model: "r/route", fallbacks: ["r/other"] } } },
};

function file(path: string, oldLines: number, newLines: number): ChangedFile {
	const hunk: Hunk = { file: path, index: 0, oldStart: 1, oldLines, newStart: 1, newLines, header: "", text: "" };
	return { status: "modified", path, binary: false, hunks: [hunk] };
}

async function named(name: string, paths: readonly string[], from = "correctness"): Promise<Lens> {
	const lens = (await Lens.builtins()).find((each) => each.name === from)!;
	return Lens.from({ ...lens.toJSON(), name, paths: [...paths], probesAs: from });
}

// The design lens as Melian's repository commits it, whose ceiling and findings budget the parity arm gives every lens.
async function designLens(findings = 16, tools = 400, deep?: number): Promise<Lens> {
	const builtin = (await Lens.builtins()).find((each) => each.name === "design")!;
	const careful = builtin.level("careful");
	const level = (ceiling: number) => ({ ...careful, budget: { ...careful.budget, findings, tools: ceiling } });
	return Lens.from({
		...builtin.toJSON(),
		levels: deep === undefined ? { careful: level(tools) } : { careful: level(tools), deep: level(deep) },
	});
}

describe("CommittedArm", () => {
	it("holds every route to its first model and leaves the lenses and the rest of the policy alone", async () => {
		const lenses = [await named("a", ["src/**"])];
		const routed = new CommittedArm().routed(config, lenses);
		expect(routed.lenses).toBe(lenses);
		expect(routed.config).toEqual({
			...config,
			models: {
				heavy: { model: "h/heavy", thinking: "low" },
				medium: { model: "m/medium" },
				light: { model: "l/light" },
				verifier: { model: "v/verify" },
			},
			lenses: { a: { route: { model: "r/route" } } },
		});
		expect(new CommittedArm().graph).toBe(true);
	});
});

describe("ParityArm", () => {
	it("refuses a total that is not a positive whole number", () => {
		for (const total of [0, -1, 1.5, Number.NaN]) expect(() => new ParityArm(total)).toThrow(/positive total/);
		expect(new ParityArm(1).total).toBe(1);
	});

	it("shares the total half equally and half by the changed lines of the files each lens of the tier selects", async () => {
		const lenses = [await named("a", ["src/**"]), await named("b", ["docs/**"]), await named("c", ["**"])];
		const files = [file("src/x.ts", 10, 20), file("docs/y.md", 4, 6)];
		expect(new ParityArm(1000).shares(config, lenses, files)).toEqual(
			new Map([
				["a", 625],
				["b", 375],
			]),
		);
		const binary = [
			{ ...file("src/x.ts", 0, 0), hunks: [] },
			{ ...file("docs/y.md", 0, 0), hunks: [] },
		];
		expect(new ParityArm(1001).shares(config, lenses, binary)).toEqual(
			new Map([
				["a", 500],
				["b", 500],
			]),
		);
		const tierless = { ...config, stages: {}, tiers: { ...config.tiers, full: ["lens.b"] } };
		expect(new ParityArm(1000).shares(tierless, lenses, files)).toEqual(new Map([["b", 1000]]));
		expect(new ParityArm(1000).shares(config, lenses, [file("src/x.ts", 1, 1)])).toEqual(new Map([["a", 1000]]));
	});

	it("shares a renamed file with the lenses its old path selects, as the review does, counting it once", async () => {
		const lenses = [await named("a", ["src/**"]), await named("b", ["docs/**"])];
		const moved = (from: string, to: string): ChangedFile => ({
			...file(to, 10, 20),
			status: "renamed",
			oldPath: from,
		});
		expect(
			new ParityArm(1000).shares(config, lenses, [moved("src/x.ts", "docs/x.ts"), file("docs/y.md", 4, 6)]),
		).toEqual(
			new Map([
				["a", 464],
				["b", 535],
			]),
		);
		expect(
			new ParityArm(1000).shares(config, lenses, [moved("src/x.ts", "src/z.ts"), file("docs/y.md", 4, 6)]),
		).toEqual(
			new Map([
				["a", 625],
				["b", 375],
			]),
		);
	});

	it("gives each scoped variant of a lens its own share, so the variants together spend no more than the total", async () => {
		const root = await named("a", ["**"]);
		const scoped = Lens.from({ ...root.toJSON(), scope: "pkg" });
		const lenses = [root, scoped, await named("b", ["docs/**"]), await designLens()];
		const files = [file("src/x.ts", 10, 20), file("pkg/z.ts", 5, 5), file("docs/y.md", 4, 6)];
		const arm = new ParityArm(1000);
		const shares = arm.shares(config, lenses, files);
		expect(shares).toEqual(
			new Map([
				["a", 500],
				["a in pkg", 250],
				["b", 250],
			]),
		);
		expect(
			arm
				.routed(config, lenses, files)
				.lenses.slice(0, 3)
				.map((lens) => lens.level("deep").budget.tokens),
		).toEqual([250, 125, 125]);
		expect(arm.routed(config, lenses, files).config.lenses).toEqual({
			a: { route: { model: "r/route", thinking: "high" } },
		});
	});

	it("leaves a configured lens with no route on its tier's route, which carries the high thinking", async () => {
		const lenses = [await named("a", ["src/**"]), await named("b", ["**"]), await designLens()];
		const withPaths: MelianConfig = { ...config, lenses: { ...config.lenses, b: { paths: ["**"] } } };
		const routed = new ParityArm(1000).routed(withPaths, lenses, [file("src/x.ts", 0, 3)]);
		expect(routed.config.lenses.b).toEqual({ paths: ["**"] });
		expect(routed.config.models.heavy).toEqual({ model: "h/heavy", thinking: "high" });
	});

	it("gives a route that names no model its first accepted model alone, so no later accepted model answers", async () => {
		const accept = ["h/heavy", "h/second"];
		const accepting: MelianConfig = {
			...config,
			models: { ...config.models, heavy: { accept }, light: { thinking: "low" } },
		};
		const routed = new ParityArm(1000).routed(
			accepting,
			[await named("a", ["src/**"]), await designLens()],
			[file("src/x.ts", 0, 3)],
		);
		expect(routed.config.models.heavy).toStrictEqual({ accept, model: "h/heavy", thinking: "high" });
		expect(routed.config.models.light).toStrictEqual({ thinking: "high" });
		expect(routed.config.models.verifier).toStrictEqual({ model: "v/verify" });
	});

	it("gives a lens holding only some graph tools the rest of them and their guidance", async () => {
		const partial = Lens.from({
			...(await named("a", ["src/**"])).toJSON(),
			tools: ["read_file", "graph_definitions"],
		});
		const [routed] = new ParityArm(1000).routed(
			config,
			[partial, await designLens()],
			[file("src/x.ts", 0, 3)],
		).lenses;
		expect(routed!.tools).toEqual(["read_file", ...lensGraphToolNames]);
		expect(routed!.instructions).toBe(`${partial.instructions}\n\n${graphGuidance}`);
	});

	it("gives every lens of the tier the loaded design lens's tool ceiling and findings budget, and refuses without one", async () => {
		const a = await named("a", ["src/**"]);
		const files = [file("src/x.ts", 0, 3)];
		const [routed] = new ParityArm(1000).routed(config, [a, await designLens(20, 600)], files).lenses;
		expect(routed!.level("deep").budget).toEqual({ ...routed!.level("deep").budget, findings: 20, tools: 600 });
		const [deep] = new ParityArm(1000).routed(config, [a, await designLens(20, 600, 700)], files).lenses;
		expect(deep!.level("deep").budget.tools).toBe(700);
		const scoped = Lens.from({ ...(await designLens()).toJSON(), scope: "pkg" });
		for (const lenses of [[a], [a, scoped]])
			expect(() => new ParityArm(1000).routed(config, lenses, files)).toThrow(
				"The parity arm gives every lens the design lens's tool ceiling and findings budget, and the policy commit loads no design lens at its root",
			);
	});

	it("gives each lens of the tier the graph and its guidance, high thinking, and a deep level its share binds", async () => {
		const builtins = await Lens.builtins();
		const graphed = Lens.from({
			...(await named("b", ["**"], "design")).toJSON(),
			tools: ["read_file", ...lensGraphToolNames],
		});
		const probing = builtins.filter((lens) => lens.probeRefusal() === undefined).map((lens) => lens.name);
		const unprobing = builtins.filter((lens) => lens.probeRefusal() !== undefined).map((lens) => lens.name);
		expect(probing.length).toBeGreaterThan(0);
		expect(unprobing.length).toBeGreaterThan(0);
		const a = await named("a", ["src/**"], probing[0]);
		const off = await named("off", ["**"]);
		const lenses = [a, graphed, off, await designLens()];
		const files = [file("src/x.ts", 0, 3), file("docs/y.md", 0, 1)];
		const arm = new ParityArm(1000);
		const shares = arm.shares(config, lenses, files);
		const routed = arm.routed(config, lenses, files);
		expect(routed.config.models).toEqual({
			heavy: { model: "h/heavy", thinking: "high" },
			medium: { model: "m/medium", thinking: "high" },
			light: { model: "l/light", thinking: "high" },
			verifier: { model: "v/verify" },
		});
		expect(routed.config.lenses).toEqual({ a: { route: { model: "r/route", thinking: "high" } } });
		const [routedA, routedB, routedOff] = routed.lenses;
		expect(routedOff).toBe(off);
		expect(routedA!.tools).toEqual([...new Set([...a.tools, ...lensGraphToolNames])]);
		expect(routedA!.instructions).toBe(`${a.instructions}\n\n${graphGuidance}`);
		expect(routedB!.tools).toEqual(graphed.tools);
		expect(routedB!.instructions).toBe(graphed.instructions);
		const base = a.levels.deep ?? a.levels.careful;
		const parity = {
			...base,
			budget: {
				findings: Math.max(base.budget.findings, 16),
				tokens: Math.floor(shares.get("a")! / 2),
				tools: 400,
				ended: "count",
			},
			probe: base.probe ?? {},
		};
		expect(a.levels.quick).toBeDefined();
		expect(routedA!.levels).toEqual({ careful: parity, deep: parity });
		const unprobed = await named("b", ["**"], unprobing[0]);
		const [, again] = arm.routed(config, [a, unprobed, await designLens()], files).lenses;
		expect(again!.level("deep").probe).toBeUndefined();
		expect(again!.level("deep").budget.tokens).toBe(arm.shares(config, [a, unprobed], files).get("b"));
	});
});

const failOpen = loadGoldens().find((each) => each.name === "trust-boundary-fail-open")!;

function usage(models: Record<string, number>, cacheRead = 4) {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	return new TokenUsage(
		Object.fromEntries(
			Object.entries(models).map(([model, total]) => [
				model,
				{ input: total - cacheRead - 20, output: 10, cacheRead, cacheWrite: 10, totalTokens: total, cost },
			]),
		),
	).toJSON();
}

type StageFields = ConstructorParameters<typeof StageTelemetry>[1][number];
const lensStage = (fields: Partial<StageFields> = {}): StageFields => ({
	id: "lens",
	task: 1,
	name: "melian.lens",
	subject: "correctness@1@deep",
	outcome: "completed",
	timing: "unavailable",
	reused: false,
	resumed: false,
	durationMs: 120_000,
	tools: 7,
	usage: usage({ model: 100 }, 40),
	...fields,
});

function ran(stages: readonly StageFields[]): RangeRun {
	return {
		telemetry: new StageTelemetry("base..head", [...stages]),
		findings: [],
		sightings: [],
		verdict: new Verdict({
			status: "passed",
			blocking: false,
			findings: { block: [], acknowledge: [], advisory: [], silent: [] },
			dismissed: [],
			notRun: [],
		}),
		rendered: "",
		toolMismatches: [],
		probers: {},
		notes: [],
		tiers: {},
	};
}

describe("the arms through a real review", { timeout: 120_000 }, () => {
	const lensNames = [
		"trust-boundary",
		"correctness",
		"contracts",
		"removed-behaviour",
		"tests",
		"conventions",
		"design",
	];

	// Reviews the fail-open golden's range through `arm` on a scripted model, without the graph the arm asks for, and
	// returns what the arm was given and returned, and every lens stage the review recorded.
	async function reviewThrough(arm: ParityArm | CommittedArm, probes: readonly string[] = []) {
		const built = buildGoldenRepository(failOpen);
		try {
			const fake = createFakeModels();
			const planned = [
				fauxAssistantMessage([fauxToolCall("record_plan", { attacks: [] })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Planned no attacks."),
			];
			scriptConversations(
				fake,
				lensNames.map((lens) => ({
					match: `You are the ${lens} reviewer`,
					replies: probes.includes(lens) ? planned : [fauxAssistantMessage("Reported 0 findings.")],
				})),
			);
			const ref = fake.ref();
			let given!: { config: MelianConfig; lenses: readonly Lens[]; files: readonly ChangedFile[] };
			let routed!: { config: MelianConfig; lenses: readonly Lens[] };
			const target = {
				repo: built.repo,
				base: built.base,
				range: `${built.base}...${built.head}`,
				writer: { trusted: true, by: "reviewer" },
			} as const;
			const run = await runRange(target, {
				kind: "live",
				models: fake.review,
				model: `${ref.provider}/${ref.modelId}`,
				probing: {
					routed: (config, lenses, files) => {
						given = { config, lenses, files };
						routed = arm.routed(config, lenses, files);
						return routed;
					},
				},
			});
			const stages = run.telemetry.stages.filter((stage) => stage.name === "melian.lens");
			return { given, routed, stages };
		} finally {
			rmSync(built.repo, { recursive: true, force: true });
		}
	}

	it("stops the parity arm on a route that names no model when only a later accepted model holds credentials", async () => {
		const built = buildGoldenRepository(failOpen);
		try {
			const fake = createFakeModels();
			const bare = fake.withoutCredentials("bare");
			scriptConversations(
				fake,
				lensNames.map((lens) => ({
					match: `You are the ${lens} reviewer`,
					replies: [fauxAssistantMessage("Reported 0 findings.")],
				})),
			);
			const ref = fake.ref();
			const accept = [`${bare.provider}/${bare.modelId}`, `${ref.provider}/${ref.modelId}`];
			const arm = new ParityArm(1_000_000);
			const target = {
				repo: built.repo,
				base: built.base,
				range: `${built.base}...${built.head}`,
				writer: { trusted: true, by: "reviewer" },
			} as const;
			const said = await runRange(target, {
				kind: "live",
				models: fake.review,
				model: accept[1]!,
				probing: {
					routed: (config, lenses, files) =>
						arm.routed(
							{
								...config,
								models: { ...config.models, light: { accept }, medium: { accept }, heavy: { accept } },
							},
							lenses,
							files,
						),
				},
			}).then(
				(run) => [
					...run.telemetry.stages.flatMap(({ error }) => (error === undefined ? [] : [error])),
					...run.verdict.notRun.flatMap(({ reason }) => (reason === undefined ? [] : [reason])),
				],
				(error: unknown) => [error instanceof Error ? error.message : String(error)],
			);
			expect(said.some((text) => /with credentials/.test(text))).toBe(true);
		} finally {
			rmSync(built.repo, { recursive: true, force: true });
		}
	});

	const nameOf = (subject: string) => subject.split("@")[0]!;
	const levelOf = (subject: string) => subject.split("@").at(-1)!;

	it("runs every lens of the parity arm at high thinking, its share, the tool ceiling and probes, and never at quick", async () => {
		const arm = new ParityArm(1_000_000);
		const { given, stages } = await reviewThrough(arm, ["correctness", "trust-boundary"]);
		const shares = arm.shares(given.config, given.lenses, given.files);
		const design = given.lenses.find((lens) => lens.name === "design" && lens.scope === "")!;
		const ceiling = (design.levels.deep ?? design.levels.careful).budget.tools;
		expect(stages.length).toBeGreaterThan(0);
		for (const stage of stages) {
			const lens = given.lenses.find((each) => each.name === nameOf(stage.subject))!;
			const share = shares.get(lens.name)!;
			const probes = lens.probeRefusal() === undefined;
			expect(levelOf(stage.subject)).not.toBe("quick");
			expect(stage.limits).toEqual({ tokens: probes ? Math.floor(share / 2) : share, tools: ceiling });
			expect(new Set(stage.usage!.requests!.map(({ reasoning }) => reasoning.requested))).toEqual(new Set(["high"]));
		}
		// A planner that plans no attacks spawns no prober, so a planner stage is what shows a lens's level probes.
		const probing = given.lenses.filter((lens) => lens.probeRefusal() === undefined).map((lens) => lens.name);
		expect(probing.sort()).toEqual(["correctness", "trust-boundary"]);
		expect(
			stages.map((stage) => [nameOf(stage.subject), stage.role ?? "lens"]).sort(([a], [b]) => a!.localeCompare(b!)),
		).toEqual([...shares.keys()].sort().map((name) => [name, probing.includes(name) ? "planner" : "lens"]));
		expect(stages.reduce((sum, stage) => sum + stage.limits!.tokens!, 0)).toBeLessThanOrEqual(arm.total);
	});

	it("runs the committed arm at the policy commit's own levels and budgets, quick included", async () => {
		const { given, routed, stages } = await reviewThrough(new CommittedArm());
		expect(routed.lenses).toBe(given.lenses);
		expect(given.lenses.some((lens) => lens.levels.quick !== undefined)).toBe(true);
		for (const name of Object.keys(given.config.lenses))
			expect(routed.config.lenses[name]?.level).toEqual(given.config.lenses[name]?.level);
		expect(stages.length).toBeGreaterThan(0);
		for (const stage of stages) {
			const lens = given.lenses.find((each) => each.name === nameOf(stage.subject))!;
			const settings = Object.hasOwn(given.config.lenses, lens.name) ? given.config.lenses[lens.name] : undefined;
			const { budget } = lens.configured(settings).level(levelOf(stage.subject) as "careful");
			expect(stage.limits).toEqual({ tokens: budget.tokens, tools: budget.tools });
		}
	});
});

describe("measureParity", { timeout: 60_000 }, () => {
	let repo: string;
	let env: NodeJS.ProcessEnv;
	let policy: string;
	let head: string;
	beforeEach(() => {
		const built = buildGoldenRepository(failOpen);
		repo = built.repo;
		const misses = join(scratch, "misses.json");
		const at = { repo, base: built.base, head: built.head, file: "src/scan.ts", rule: "fail-open", lines: [16, 16] };
		writeFileSync(
			misses,
			JSON.stringify([
				{ name: "one", ...at },
				{ name: "two", ...at },
			]),
		);
		env = {
			MELIAN_EVAL_MISSES: misses,
			MELIAN_EVAL_PARITY_OUT: join(scratch, "parity.json"),
			MELIAN_EVAL_PARITY_STOP_REVIEW: "1000000",
			MELIAN_EVAL_PARITY_STOP_RUN: "1000000",
			MELIAN_EVAL_PROBE_TRUST: `${built.base},${built.head}`,
			MELIAN_EVAL_POLICY_COMMIT: "main",
		};
		policy = built.base;
		head = built.head;
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	const snapshot = `sha256:${"e".repeat(64)}`;
	const probeHost = {
		platform: "linux",
		sandbox: "runtime",
		sandboxVersion: "0.0.1",
		arch: "x64",
		node: "24.0.0",
	} as const;
	const committedStages = [
		lensStage(),
		lensStage({ id: "v", name: "melian.verification", subject: "verifier", usage: usage({ model: 30 }, 10) }),
		lensStage({ id: "p", role: "prober", usage: usage({ model: 50 }, 20) }),
	];
	// The same Spend as the committed stages, with no prober, so a parity review spends its lenses' total and scores.
	const withinTotal = [
		lensStage(),
		lensStage({ id: "v", name: "melian.verification", subject: "verifier", usage: usage({ model: 80 }, 10) }),
	];

	function runners(
		stages: readonly (readonly StageFields[])[] = [committedStages],
		fields: Partial<ParityRunners> = {},
	) {
		let call = 0;
		return {
			availability: vi.fn(async () => ({ available: true }) as const),
			models: vi.fn(async () => createFakeModels({ models: [{ id: "x" }] }).review),
			range: vi.fn(async () => ran(stages[Math.min(call++, stages.length - 1)]!)),
			graph: vi.fn(async () => snapshot),
			graphCached: vi.fn(async () => false),
			commit: () => "c".repeat(40),
			host: () => probeHost,
			...fields,
		} satisfies ParityRunners;
	}

	async function measure(settings: NodeJS.ProcessEnv, using: ParityRunners) {
		const lines: string[] = [];
		const errors: string[] = [];
		const status = await measureParity(
			settings,
			using,
			(line) => lines.push(line),
			(line) => errors.push(line),
		);
		return { status, lines, errors };
	}

	const results = (): ParityResults => JSON.parse(readFileSync(env.MELIAN_EVAL_PARITY_OUT!, "utf8"));

	it("refuses a run it cannot finish or resume before any model, and writes no results file", async () => {
		const cases: [NodeJS.ProcessEnv, RegExp, Partial<ParityRunners>?][] = [
			[{ MELIAN_EVAL_PARITY_OUT: "" }, /MELIAN_EVAL_PARITY_OUT must name/],
			[{ MELIAN_EVAL_MISSES: "" }, /MELIAN_EVAL_MISSES must name/],
			[{ MELIAN_EVAL_PARITY_STOP_REVIEW: undefined }, /MELIAN_EVAL_PARITY_STOP_REVIEW must be/],
			[{ MELIAN_EVAL_PARITY_STOP_RUN: "0" }, /MELIAN_EVAL_PARITY_STOP_RUN must be/],
			[{ MELIAN_EVAL_PARITY_STOP_RUN: "1.5" }, /MELIAN_EVAL_PARITY_STOP_RUN must be/],
			[{ MELIAN_EVAL_PARITY_MISSES: "one,three" }, /names no miss called three/],
			[
				{ MELIAN_EVAL_POLICY_COMMIT: "" },
				/^MELIAN_EVAL_POLICY_COMMIT must name the commit whose policy reviews every miss/,
			],
			[
				{ MELIAN_EVAL_PROBE_TRUST: "d".repeat(40) },
				/^refused one, unvouched: MELIAN_EVAL_PROBE_TRUST does not vouch for its base, head and policy commit, so its probes cannot run$/,
			],
			[
				{},
				/Probes cannot run on this host: no sandbox/,
				{ availability: async () => ({ available: false, reason: "no sandbox" }) },
			],
		];
		for (const [settings, error, fields] of cases) {
			const using = runners(undefined, fields);
			const { status, errors } = await measure({ ...env, ...settings }, using);
			expect(status, String(error)).toBe(2);
			expect(errors[0], String(error)).toMatch(error);
			expect(errors.length, String(error)).toBe(error.source.startsWith("^refused") ? 3 : 1);
			expect(using.models).not.toHaveBeenCalled();
			expect(existsSync(env.MELIAN_EVAL_PARITY_OUT!)).toBe(false);
		}
		const unlined = join(scratch, "unlined.json");
		const [one] = JSON.parse(readFileSync(env.MELIAN_EVAL_MISSES!, "utf8"));
		writeFileSync(unlined, JSON.stringify([{ ...one, lines: undefined }]));
		expect((await measure({ ...env, MELIAN_EVAL_MISSES: unlined }, runners())).errors).toEqual([
			"A whole review scores a miss only on its hand-entered lines, which one lack",
		]);
	});

	it("runs the committed arm and then the parity arm on each miss, the parity arm sharing what the committed lenses spent", async () => {
		const using = runners();
		const { status, lines } = await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, using);
		expect(status).toBe(1);
		const arms = vi.mocked(using.range).mock.calls.map(([, mode]) => mode.probing);
		expect(arms.map((arm) => arm?.constructor)).toEqual([CommittedArm, ParityArm]);
		expect((arms[1] as ParityArm).total).toBe(60);
		expect(lines[0]).toBe(
			"committed two: unadjudicated, no score: the review shows no completed trust-boundary run whose scope holds src/scan.ts; 180 tokens, 70 of them cache reads, 110 by Melian's budget count; run so far 180 tokens, 110 by Melian's budget count",
		);
		expect(lines[1]).toBe(
			"    by Melian's budget count: lenses 60, probers 30, triage 0, verification 20, walkthrough 0; the lenses' spend is the parity arm's total",
		);
		expect(lines[2]).toMatch(
			/^Parity per total budget two: .*; run so far 360 tokens, 220 by Melian's budget count$/,
		);
		const written = results();
		expect(written).toMatchObject({ version: 2, arm: parityArmName, commit: "c".repeat(40), policyCommit: policy });
		expect(vi.mocked(using.range).mock.calls.map(([target]) => target.policy)).toEqual([policy, policy]);
		expect(written.stopped).toBeUndefined();
		expect(written.attempts.map(({ miss, arm, total, store }) => [miss, arm, total, store])).toEqual([
			["two", "committed", undefined, `${env.MELIAN_EVAL_PARITY_OUT}.stores/two-committed.sqlite`],
			["two", "parity", 60, `${env.MELIAN_EVAL_PARITY_OUT}.stores/two-parity.sqlite`],
		]);
		expect(vi.mocked(using.range).mock.calls.map(([, mode]) => mode.store)).toEqual(
			written.attempts.map(({ store }) => store),
		);
		expect(written.attempts[0]!.stages[0]).toEqual({
			name: "melian.lens",
			subject: "correctness@1@deep",
			level: "deep",
			outcome: "completed",
			models: ["model"],
			effort: { requested: [], reported: [] },
			tokens: 100,
			cacheRead: 40,
			budgetTokens: 60,
			tools: 7,
			minutes: 2,
		});
	});

	it("gives the parity arm only what the committed arm's lenses spent, never triage, verification or the walkthrough", async () => {
		const whole = [
			lensStage(),
			lensStage({ id: "t", name: "melian.triage", subject: "triage", usage: usage({ model: 35 }, 20) }),
			lensStage({
				id: "c",
				name: "melian.verification.candidate",
				subject: "claim",
				usage: usage({ model: 50 }, 30),
			}),
			lensStage({ id: "v", name: "melian.verification", subject: "verifier", usage: usage({ model: 30 }, 10) }),
			lensStage({ id: "w", name: "melian.walkthrough", subject: "walkthrough", usage: usage({ model: 12 }, 7) }),
			lensStage({ id: "p", role: "prober", usage: usage({ model: 50 }, 20) }),
		];
		const using = runners([whole]);
		const { lines } = await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, using);
		expect((vi.mocked(using.range).mock.calls[1]![1].probing as ParityArm).total).toBe(60);
		expect(lines.filter((line) => line.startsWith("    by"))).toEqual([
			"    by Melian's budget count: lenses 60, probers 30, triage 15, verification 40, walkthrough 5; the lenses' spend is the parity arm's total",
			"    by Melian's budget count: lenses 60, probers 30, triage 15, verification 40, walkthrough 5",
		]);
	});

	it("records each stage's model and the effort it asked for and the provider reported", async () => {
		const answered = new TokenUsage();
		const counted = {
			input: 50,
			output: 10,
			cacheRead: 30,
			cacheWrite: 10,
			totalTokens: 100,
			cost: usage({}, 0).total.cost,
		};
		answered.add("openai-codex/gpt-5.6-sol", counted, {
			requested: "high",
			source: "observed",
			sent: [],
			providerReported: "medium",
		});
		answered.add("openai-codex/gpt-5.6-sol", counted, { requested: "high", source: "observed", sent: [] });
		answered.add("openai-codex/gpt-5.6-sol", counted, {
			requested: "high",
			source: "observed",
			sent: [],
			providerReported: "high",
		});
		const using = runners([
			[
				lensStage({ usage: answered.toJSON() }),
				lensStage({ id: "t", name: "melian.triage", usage: usage({ model: 10 }, 0) }),
			],
		]);
		await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, using);
		expect(results().attempts[0]!.stages.map(({ models, effort }) => ({ models, effort }))).toEqual([
			{ models: ["openai-codex/gpt-5.6-sol"], effort: { requested: ["high"], reported: ["medium", "high"] } },
			{ models: ["model"], effort: { requested: [], reported: [] } },
		]);
	});

	it("records the level triage picked for each lens and the token and tool limits that ran, and none for another stage", async () => {
		const using = runners([
			[
				lensStage({ subject: "correctness@1@careful", limits: { tokens: 500, tools: 400 } }),
				lensStage({ id: "t", name: "melian.triage", subject: "triage@1@deep", usage: usage({ model: 10 }, 0) }),
			],
		]);
		await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, using);
		expect(results().attempts[0]!.stages.map(({ level, limit, toolLimit }) => ({ level, limit, toolLimit }))).toEqual(
			[
				{ level: "careful", limit: 500, toolLimit: 400 },
				{ level: undefined, limit: undefined, toolLimit: undefined },
			],
		);
	});

	it("builds Enola's graph of each miss's head once, before its reviews, and records its snapshot in each attempt", async () => {
		const using = runners();
		await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one,two" }, using);
		expect(vi.mocked(using.graph).mock.calls.map(([target]) => target.range)).toEqual([
			`${policy}...${head}`,
			`${policy}...${head}`,
		]);
		expect(vi.mocked(using.graph).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(using.range).mock.invocationCallOrder[0]!,
		);
		expect(results().attempts.map(({ miss, arm, graph }) => [miss, arm, graph])).toEqual([
			["one", "committed", snapshot],
			["one", "parity", snapshot],
			["two", "committed", snapshot],
			["two", "parity", snapshot],
		]);
		expect(using.graphCached).not.toHaveBeenCalled();
	});

	it("leaves a miss unscored, never reviewed without callers, when its graph cannot be built", async () => {
		const using = runners(undefined, {
			graph: vi.fn(async () => {
				throw new Error("Enola generate exited 2");
			}),
		});
		const lines: string[] = [];
		let saved: ParityResults["attempts"] = [];
		const status = await measureParity(
			{ ...env, MELIAN_EVAL_PARITY_MISSES: "two" },
			using,
			(line) => {
				if (lines.length === 0) saved = results().attempts;
				lines.push(line);
			},
			() => {},
		);
		expect(status).toBe(1);
		expect(using.range).not.toHaveBeenCalled();
		const said =
			"no score: Enola's graph of the head could not be built, and a review without its callers is not today's Melian: Enola generate exited 2";
		expect(lines[0]).toBe(`committed two: ${said}`);
		expect(saved.map(({ miss, arm, said }) => [miss, arm, said])).toEqual([["two", "committed", said]]);
		expect(results().attempts).toEqual([
			{
				miss: "two",
				arm: "committed",
				said,
				error: "Enola generate exited 2",
				tokens: 0,
				cacheRead: 0,
				budgetTokens: 0,
				stages: [],
			},
			{
				miss: "two",
				arm: "parity",
				said: "not run: the committed arm had no review",
				tokens: 0,
				cacheRead: 0,
				budgetTokens: 0,
				stages: [],
			},
		]);
		expect(existsSync(`${env.MELIAN_EVAL_PARITY_OUT}.stores`)).toBe(false);
	});

	it("keeps a miss whose graph could not be built unscored on resume, as it keeps a failed review", async () => {
		const failing = runners(undefined, {
			graph: vi.fn(async () => {
				throw new Error("Enola generate exited 2");
			}),
		});
		await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, failing);
		const again = runners();
		expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, again)).status).toBe(1);
		expect(again.graph).not.toHaveBeenCalled();
		expect(again.range).not.toHaveBeenCalled();
	});

	it("says in a dry run whether each scorable miss's graph is cached, and builds none", async () => {
		const using = runners(undefined, { graphCached: vi.fn(async () => true) });
		const { status, lines } = await measure(
			{ ...env, MELIAN_EVAL_PARITY_MISSES: "one", MELIAN_EVAL_PARITY_DRY: "1" },
			using,
		);
		expect(status).toBe(0);
		expect(lines[1]).toBe("    Enola's graph of one's head is cached");
		expect(vi.mocked(using.graphCached).mock.calls.map(([target]) => target.range)).toEqual([`${policy}...${head}`]);
		expect(using.graph).not.toHaveBeenCalled();
	});

	it("records what a lens its share ended had left: covered files it never saw, and attacks its prober never ran", async () => {
		const cut = [
			lensStage({
				ended: "tokens",
				limits: { tokens: 50 },
				coverage: { scope: "", paths: ["src/**"], nearer: [] },
				shown: ["src/rules.ts"],
				read: [],
			}),
			lensStage({
				id: "p",
				role: "prober",
				ended: "tokens",
				probes: { attacks: 3, skipped: [1], runs: [{ attack: 0 }] },
			} as Partial<StageFields>),
		];
		const { lines } = await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, runners([cut]));
		const [stage, prober] = results().attempts[0]!.stages;
		expect(stage).toMatchObject({ ended: "tokens", limit: 50, unread: ["src/scan.ts"] });
		expect(stage).not.toHaveProperty("openAttacks");
		expect(prober).toMatchObject({ role: "prober", ended: "tokens", openAttacks: 1 });
		expect(prober).not.toHaveProperty("unread");
		expect(lines).toContain("    correctness@1@deep ended at its tokens share of 50, 1 covered files unread");
		expect(lines).toContain("    correctness@1@deep prober ended at its tokens share of no limit, 1 attacks open");
	});

	it("counts a covered file a cut lens read as seen, whichever other files it read, and one it read only beside as unread", async () => {
		const cut = (id: string, read: string[]) =>
			lensStage({
				id,
				ended: "tokens",
				limits: { tokens: 50 },
				coverage: { scope: "", paths: ["src/**"], nearer: [] },
				shown: [],
				read: read.map((path) => ({ path, ranges: [[1, 2]] as [number, number][] })),
			});
		await measure(
			{ ...env, MELIAN_EVAL_PARITY_MISSES: "one" },
			runners([[cut("s", ["README.md", "src/scan.ts"]), cut("b", ["README.md"])]]),
		);
		expect(results().attempts[0]!.stages.map(({ unread }) => unread)).toEqual([[], ["src/scan.ts"]]);
	});

	it("resumes from its results file, skipping what it finished, and refuses one another commit measured", async () => {
		await measure({ ...env, MELIAN_EVAL_PARITY_STOP_RUN: "200" }, runners());
		expect(results().stopped).toMatch(/the run's 360 tokens reached MELIAN_EVAL_PARITY_STOP_RUN, 200/);
		expect(results().attempts.map(({ miss, arm }) => [miss, arm])).toEqual([
			["one", "committed"],
			["one", "parity"],
		]);
		// A store the cut review left stays, and the review it resumes takes the next name.
		writeFileSync(`${env.MELIAN_EVAL_PARITY_OUT}.stores/two-committed.sqlite`, "cut\n");
		const resumed = runners();
		expect((await measure(env, resumed)).status).toBe(1);
		expect(readFileSync(`${env.MELIAN_EVAL_PARITY_OUT}.stores/two-committed.sqlite`, "utf8")).toBe("cut\n");
		expect(vi.mocked(resumed.range).mock.calls.map(([, mode]) => mode.store)).toEqual([
			`${env.MELIAN_EVAL_PARITY_OUT}.stores/two-committed.2.sqlite`,
			`${env.MELIAN_EVAL_PARITY_OUT}.stores/two-parity.sqlite`,
		]);
		expect(resumed.range).toHaveBeenCalledTimes(2);
		expect(results().stopped).toBeUndefined();
		expect(results().attempts.map(({ miss, arm }) => [miss, arm])).toEqual([
			["one", "committed"],
			["one", "parity"],
			["two", "committed"],
			["two", "parity"],
		]);
		const moved = runners(undefined, { commit: () => "d".repeat(40) });
		expect(await measure(env, moved)).toMatchObject({
			status: 2,
			errors: [expect.stringMatching(/was measured at c{40}, not this checkout's d{40}/)],
		});
		expect(moved.models).not.toHaveBeenCalled();
		const elsewhere = runners();
		expect(await measure({ ...env, MELIAN_EVAL_POLICY_COMMIT: head }, elsewhere)).toMatchObject({
			status: 2,
			errors: [
				`${env.MELIAN_EVAL_PARITY_OUT} was measured under ${policy}'s policy, not ${head}'s; resume under that policy or name a new file`,
			],
		});
		expect(elsewhere.models).not.toHaveBeenCalled();
	});

	it("leaves unscored a parity review whose lenses and probers spent one request past its total, and scores one at it", async () => {
		const verifier = lensStage({
			id: "v",
			name: "melian.verification",
			subject: "verifier",
			usage: usage({ model: 70 }, 0),
		});
		const planner = lensStage({ role: "planner", usage: usage({ model: 70 }, 40) });
		const prober = (total: number) => lensStage({ id: "p", role: "prober", usage: usage({ model: total }, 40) });
		const using = runners([
			[lensStage(), verifier],
			[planner, prober(70), verifier],
			[lensStage(), verifier],
			[planner, prober(71), verifier],
		]);
		const { status, lines } = await measure(env, using);
		expect(status).toBe(1);
		const parity = results().attempts.filter((attempt) => attempt.arm === "parity");
		expect(parity.map(({ total, budgetTokens }) => [total, budgetTokens])).toEqual([
			[60, 130],
			[60, 131],
		]);
		expect(parity[0]!.said).toMatch(/^unadjudicated/);
		expect(parity[0]).not.toHaveProperty("overrun");
		const over =
			"not scored: its lenses and probers spent 61 tokens by Melian's budget count, 1 past its total of 60, since a share is a soft limit and the request that crosses it finishes";
		expect(parity[1]).toMatchObject({ said: over, overrun: 1 });
		expect(parity[1]).not.toHaveProperty("found");
		expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^Parity per total budget two: ${over};`)));
	});

	it("keeps a parity review that stopped or failed as stopped or failed, though it also spent past its total", async () => {
		const committed = ran([lensStage()]);
		const limited = lensStage({ id: "l", outcome: "failed", error: "You have hit your usage limit." });
		let call = 0;
		const stopping = runners(undefined, {
			range: vi.fn(async () => (call++ === 0 ? committed : ran([lensStage(), limited]))),
		});
		expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, stopping)).status).toBe(3);
		expect(results().attempts.find((attempt) => attempt.arm === "parity")).toMatchObject({
			said: "not scored: the run stopped",
			overrun: 60,
		});
		rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		call = 0;
		const failing = runners(undefined, {
			range: vi.fn(async () => {
				if (call++ === 0) return committed;
				throw new GoldenRunError(
					new Error("the verifier failed"),
					new StageTelemetry("base..head", [lensStage(), lensStage({ id: "l" })]),
				);
			}),
		});
		await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, failing);
		expect(results().attempts.find((attempt) => attempt.arm === "parity")).toMatchObject({
			said: "no score: the verifier failed",
			overrun: 60,
		});
	});

	it("refuses to save through a link, a dangling link, a FIFO or a directory planted at its temporary path, and leaves a link's target alone", async () => {
		const sentinel = join(scratch, "sentinel");
		const planted = `${env.MELIAN_EVAL_PARITY_OUT}.${process.pid}.tmp`;
		writeFileSync(sentinel, "SAFE");
		const plant: Record<string, () => void> = {
			link: () => symlinkSync(sentinel, planted),
			"dangling link": () => symlinkSync(join(scratch, "missing", "new.json"), planted),
			FIFO: () => execFileSync("mkfifo", [planted]),
			directory: () => mkdirSync(planted),
		};
		try {
			for (const plantIt of Object.values(plant)) {
				plantIt();
				await expect(measure(env, runners())).rejects.toThrow(
					`${planted} is not a regular file; a parity run reads, writes and locks only regular files and never follows a link, so remove it or name another results file`,
				);
				expect(readFileSync(sentinel, "utf8")).toBe("SAFE");
				expect(existsSync(join(scratch, "missing"))).toBe(false);
				expect(existsSync(env.MELIAN_EVAL_PARITY_OUT!)).toBe(false);
				rmSync(planted, { recursive: true });
				rmSync(`${env.MELIAN_EVAL_PARITY_OUT}.lock`, { force: true });
			}
		} finally {
			rmSync(planted, { recursive: true, force: true });
			rmSync(sentinel, { force: true });
		}
	});

	it("escapes a results path's control and bidi characters once, in the temporary path's refusal and the lock's", async () => {
		const hostile = join(scratch, "e\u001b[31m\u202e");
		mkdirSync(hostile);
		const out = join(hostile, "parity.json");
		const hostileEnv = { ...env, MELIAN_EVAL_PARITY_OUT: out };
		const refusal = (path: string) =>
			`${visibleText(path)} is not a regular file; a parity run reads, writes and locks only regular files and never follows a link, so remove it or name another results file`;
		const planted = `${out}.${process.pid}.tmp`;
		mkdirSync(planted);
		const saving = measure(hostileEnv, runners());
		await expect(saving).rejects.toThrow(refusal(planted));
		await expect(saving).rejects.not.toThrow(/[\u001b\u202e]/);
		rmSync(planted, { recursive: true });
		rmSync(`${out}.lock`, { force: true });
		mkdirSync(`${out}.lock`);
		expect(await measure({ ...hostileEnv, MELIAN_EVAL_PARITY_MISSES: "two" }, runners())).toMatchObject({
			status: 2,
			errors: [refusal(`${out}.lock`)],
		});
	});

	it("refuses a results path that is a link, a dangling link, a FIFO or a directory, before any model, and changes nothing there", async () => {
		const out = env.MELIAN_EVAL_PARITY_OUT!;
		const target = join(scratch, "target.json");
		const plant: Record<string, () => void> = {
			"link to a file": () => {
				writeFileSync(target, "KEPT");
				symlinkSync(target, out);
			},
			"dangling link": () => symlinkSync(join(scratch, "missing", "new.json"), out),
			FIFO: () => execFileSync("mkfifo", [out]),
			directory: () => mkdirSync(out),
		};
		for (const [kind, planted] of Object.entries(plant)) {
			planted();
			const using = runners();
			expect([kind, await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, using)]).toMatchObject([
				kind,
				{
					status: 2,
					errors: [
						`${out} is not a regular file; a parity run reads, writes and locks only regular files and never follows a link, so remove it or name another results file`,
					],
				},
			]);
			expect(using.range).not.toHaveBeenCalled();
			expect(existsSync(`${out}.lock`)).toBe(false);
			expect(existsSync(join(scratch, "missing"))).toBe(false);
			rmSync(out, { recursive: true });
		}
		expect(readFileSync(target, "utf8")).toBe("KEPT");
	});

	it("runs on a results path whose directory is a link, and saves in the directory it leads to", async () => {
		const real = join(scratch, "real");
		mkdirSync(real);
		symlinkSync(real, join(scratch, "linked"));
		const out = join(scratch, "linked", "parity.json");
		const { status } = await measure(
			{ ...env, MELIAN_EVAL_PARITY_OUT: out, MELIAN_EVAL_PARITY_MISSES: "two" },
			runners(),
		);
		expect(status).toBe(1);
		expect(lstatSync(join(real, "parity.json")).isFile()).toBe(true);
		expect(existsSync(join(real, "parity.json.lock"))).toBe(false);
	});

	it("holds its results file for the life of a run, so a second run on it exits 2 and changes nothing, and releases it when the run ends", async () => {
		const out = env.MELIAN_EVAL_PARITY_OUT!;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const first = runners(undefined, {
			range: vi.fn(async () => {
				entered();
				await held;
				return ran(committedStages);
			}),
		});
		const running = measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, first);
		await started;
		const before = readFileSync(out, "utf8");
		const second = runners();
		const { status, errors } = await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, second);
		expect(status).toBe(2);
		expect(errors).toEqual([
			`${out}.lock says run ${process.pid} holds ${out}; if no run is using it, a run that died left it, and removing it lets this one start`,
		]);
		expect(second.range).not.toHaveBeenCalled();
		expect(readFileSync(out, "utf8")).toBe(before);
		release();
		expect((await running).status).toBe(1);
		expect(existsSync(`${out}.lock`)).toBe(false);
		expect(results().attempts.map(({ miss, arm }) => [miss, arm])).toEqual([
			["two", "committed"],
			["two", "parity"],
		]);
	});

	it("reports a lock it cannot check or create as that error, not as a lock another run holds", async () => {
		for (const [out, error] of [
			[join(scratch, `${"p".repeat(251)}.json`), /^ENAMETOOLONG: name too long, lstat /],
			[join(scratch, "missing", "parity.json"), /^ENOENT: no such file or directory, open /],
		] as const) {
			const using = runners();
			const { status, errors } = await measure(
				{ ...env, MELIAN_EVAL_PARITY_OUT: out, MELIAN_EVAL_PARITY_MISSES: "two" },
				using,
			);
			expect(status).toBe(2);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatch(error);
			expect(using.range).not.toHaveBeenCalled();
		}
	});

	it("refuses a second run that names the held results file through a link, because the path is a link", async () => {
		const out = env.MELIAN_EVAL_PARITY_OUT!;
		const alias = join(scratch, "alias.json");
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const first = runners(undefined, {
			range: vi.fn(async () => {
				entered();
				await held;
				return ran(committedStages);
			}),
		});
		const running = measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, first);
		await started;
		symlinkSync(out, alias);
		const before = readFileSync(out, "utf8");
		const second = runners();
		const { status, errors } = await measure(
			{ ...env, MELIAN_EVAL_PARITY_OUT: alias, MELIAN_EVAL_PARITY_MISSES: "two" },
			second,
		);
		expect(status).toBe(2);
		expect(errors).toEqual([
			`${alias} is not a regular file; a parity run reads, writes and locks only regular files and never follows a link, so remove it or name another results file`,
		]);
		expect(second.range).not.toHaveBeenCalled();
		expect(readFileSync(out, "utf8")).toBe(before);
		release();
		expect((await running).status).toBe(1);
		const third = runners();
		expect(
			(await measure({ ...env, MELIAN_EVAL_PARITY_OUT: alias, MELIAN_EVAL_PARITY_MISSES: "two" }, third)).status,
		).toBe(2);
		expect(third.range).not.toHaveBeenCalled();
		expect(lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(existsSync(`${alias}.lock`)).toBe(false);
	});

	it("refuses a lock path that is a link, a dangling link, a FIFO, a directory or a file of other text, and says nothing the path holds", async () => {
		const out = env.MELIAN_EVAL_PARITY_OUT!;
		const lock = `${out}.lock`;
		const secret = join(scratch, "secret");
		writeFileSync(secret, "PRIVATE_TOKEN_7f30a data\n");
		const notFile = `${lock} is not a regular file; a parity run reads, writes and locks only regular files and never follows a link, so remove it or name another results file`;
		const notLock = `${lock} is not a lock this measurement wrote, so it cannot say which run holds ${out}; if no run is using it, removing it lets this one start`;
		const plant: Record<string, [() => void, string]> = {
			link: [() => symlinkSync(secret, lock), notFile],
			"dangling link": [() => symlinkSync(join(scratch, "missing", "new.json"), lock), notFile],
			FIFO: [() => execFileSync("mkfifo", [lock]), notFile],
			directory: [() => mkdirSync(lock), notFile],
			text: [() => writeFileSync(lock, "PRIVATE_TOKEN_7f30a data\n"), notLock],
			"claim after other text": [
				() => writeFileSync(lock, "PRIVATE 4242 00000000-0000-4000-8000-000000000000\n"),
				notLock,
			],
			"claim before other text": [
				() => writeFileSync(lock, "4242 00000000-0000-4000-8000-000000000000\nPRIVATE\n"),
				notLock,
			],
		};
		for (const [kind, [planted, refusal]] of Object.entries(plant)) {
			planted();
			const using = runners();
			expect([kind, await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, using)]).toMatchObject([
				kind,
				{ status: 2, errors: [refusal] },
			]);
			expect(using.range).not.toHaveBeenCalled();
			expect(existsSync(out)).toBe(false);
			expect(existsSync(join(scratch, "missing"))).toBe(false);
			rmSync(lock, { recursive: true });
		}
		expect(readFileSync(secret, "utf8")).toBe("PRIVATE_TOKEN_7f30a data\n");
	});

	it("stops without saving or releasing when a claim of its own process but another run took its lock", async () => {
		const lock = `${env.MELIAN_EVAL_PARITY_OUT}.lock`;
		const other = `${process.pid} 00000000-0000-4000-8000-000000000000\n`;
		const using = runners(undefined, {
			range: vi.fn(async () => {
				rmSync(lock);
				writeFileSync(lock, other);
				return ran(committedStages);
			}),
		});
		expect(await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, using)).toMatchObject({
			status: 2,
			errors: [
				`${lock} no longer holds this run's claim, so another run may own ${env.MELIAN_EVAL_PARITY_OUT}; this run stopped without saving`,
			],
		});
		expect(readFileSync(lock, "utf8")).toBe(other);
		expect(results().attempts.map(({ miss, arm, pending }) => [miss, arm, pending])).toEqual([
			["two", "committed", true],
		]);
	});

	it("stops without saving or releasing when another run took its lock while it ran", async () => {
		const lock = `${env.MELIAN_EVAL_PARITY_OUT}.lock`;
		const using = runners(undefined, {
			range: vi.fn(async () => {
				rmSync(lock);
				writeFileSync(lock, "999 other\n");
				return ran(committedStages);
			}),
		});
		expect(await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, using)).toMatchObject({
			status: 2,
			errors: [
				`${lock} no longer holds this run's claim, so another run may own ${env.MELIAN_EVAL_PARITY_OUT}; this run stopped without saving`,
			],
		});
		expect(using.range).toHaveBeenCalledTimes(1);
		expect(readFileSync(lock, "utf8")).toBe("999 other\n");
		expect(results().attempts.map(({ miss, arm, pending }) => [miss, arm, pending])).toEqual([
			["two", "committed", true],
		]);
	});

	it("stops without saving when its lock was removed while it ran", async () => {
		const lock = `${env.MELIAN_EVAL_PARITY_OUT}.lock`;
		const using = runners(undefined, {
			range: vi.fn(async () => {
				rmSync(lock);
				return ran(committedStages);
			}),
		});
		expect(await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, using)).toMatchObject({
			status: 2,
			errors: [
				`${lock} no longer holds this run's claim, so another run may own ${env.MELIAN_EVAL_PARITY_OUT}; this run stopped without saving`,
			],
		});
		expect(existsSync(lock)).toBe(false);
		expect(results().attempts.map(({ miss, arm, pending }) => [miss, arm, pending])).toEqual([
			["two", "committed", true],
		]);
	});

	it("stops and resumes with its results and misses files beside the checkout, and refuses either inside it before any model", async () => {
		const { repo: checkout } = buildGoldenRepository(failOpen);
		try {
			const commit = (artefacts: readonly string[]) => checkoutCommit(checkout, artefacts);
			expect(
				(await measure({ ...env, MELIAN_EVAL_PARITY_STOP_RUN: "200" }, runners(undefined, { commit }))).status,
			).toBe(3);
			expect(existsSync(`${env.MELIAN_EVAL_PARITY_OUT}.stores`)).toBe(true);
			const resumed = runners(undefined, { commit });
			expect((await measure(env, resumed)).status).toBe(1);
			expect(resumed.range).toHaveBeenCalledTimes(2);
			expect(results().stopped).toBeUndefined();
			const out = join(checkout, "parity.json");
			const misses = join(checkout, "misses.json");
			for (const [settings, inside] of [
				[{ MELIAN_EVAL_PARITY_OUT: out }, out],
				[{ MELIAN_EVAL_MISSES: misses }, misses],
			] as const) {
				if (inside === misses) writeFileSync(misses, readFileSync(env.MELIAN_EVAL_MISSES!, "utf8"));
				const refused = runners(undefined, { commit });
				expect(await measure({ ...env, ...settings, MELIAN_EVAL_PARITY_STOP_RUN: "200" }, refused)).toMatchObject({
					status: 2,
					errors: [
						`${inside} is inside the checkout ${checkout}, which the run must leave unchanged; name a path outside it`,
					],
				});
				expect(refused.models).not.toHaveBeenCalled();
				expect(refused.range).not.toHaveBeenCalled();
			}
			expect(existsSync(out)).toBe(false);
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}
	});

	it("refuses to resume on another probe host, whichever of its fields changed, or from another version or arm", async () => {
		await measure({ ...env, MELIAN_EVAL_PARITY_STOP_RUN: "200" }, runners());
		expect(results()).toMatchObject({ version: 2, host: probeHost });
		const others = [
			{ platform: "darwin" },
			{ sandbox: "unconfined" },
			{ sandboxVersion: "0.0.2" },
			{ arch: "arm64" },
			{ node: "22.0.0" },
		] as const;
		for (const other of others) {
			const elsewhere = runners(undefined, { host: () => ({ ...probeHost, ...other }) });
			expect(await measure(env, elsewhere), JSON.stringify(other)).toMatchObject({
				status: 2,
				errors: [
					`${env.MELIAN_EVAL_PARITY_OUT} probed on ${JSON.stringify(probeHost)}, not this host's ${JSON.stringify({ ...probeHost, ...other })}; resume on that host or name a new file`,
				],
			});
			expect(elsewhere.models).not.toHaveBeenCalled();
		}
		expect((await measure(env, runners())).status).toBe(1);
		const current = results();
		const { host: _, ...older } = current;
		for (const other of [
			{ ...older, version: 1 },
			{ ...current, arm: "Another arm" },
		]) {
			writeFileSync(env.MELIAN_EVAL_PARITY_OUT!, JSON.stringify(other));
			const old = runners();
			expect(await measure(env, old), other.arm).toMatchObject({
				status: 2,
				errors: [`${env.MELIAN_EVAL_PARITY_OUT} is not a results file of this measurement`],
			});
			expect(old.models).not.toHaveBeenCalled();
		}
	});

	it("refuses to resume when a miss it reviewed now names other lines, or the verifier changed", async () => {
		await measure({ ...env, MELIAN_EVAL_PARITY_STOP_RUN: "200" }, runners());
		const misses = JSON.parse(readFileSync(env.MELIAN_EVAL_MISSES!, "utf8"));
		writeFileSync(env.MELIAN_EVAL_MISSES!, JSON.stringify([{ ...misses[0], lines: [17, 17] }, misses[1]]));
		const moved = runners();
		expect(await measure(env, moved)).toMatchObject({
			status: 2,
			errors: [
				`${env.MELIAN_EVAL_PARITY_OUT} reviewed one as another miss, at another base, head, file, rules or lines; resume with the same misses or name a new file`,
			],
		});
		expect(moved.range).not.toHaveBeenCalled();
		writeFileSync(env.MELIAN_EVAL_MISSES!, JSON.stringify([misses[0], { ...misses[1], lines: [17, 17] }]));
		const unreviewed = runners();
		expect((await measure(env, unreviewed)).status).toBe(1);
		expect(unreviewed.range).toHaveBeenCalledTimes(2);
		// A resume narrowed to one miss keeps what the others named.
		expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, runners())).status).toBe(1);
		expect((await measure(env, runners())).status).toBe(1);
		const verified = runners();
		expect(await measure({ ...env, MELIAN_EVAL_VERIFIER_MODEL: "v/judge" }, verified)).toMatchObject({
			status: 2,
			errors: [
				`${env.MELIAN_EVAL_PARITY_OUT} was verified on the verifier's route, not v/judge; resume with the same verifier or name a new file`,
			],
		});
		expect(verified.models).not.toHaveBeenCalled();
	});

	it("lists every miss today's policy cannot score in one exit, and only lists them in a dry run", async () => {
		const [one] = JSON.parse(readFileSync(env.MELIAN_EVAL_MISSES!, "utf8"));
		const mixed = join(scratch, "mixed.json");
		writeFileSync(
			mixed,
			JSON.stringify([
				one,
				{ ...one, name: "unruled", rule: "no-such-rule" },
				{ ...one, name: "untouched", file: "src/none.ts" },
				{ ...one, name: "unknown", head: "nowhere" },
			]),
		);
		const refused = [
			`refused unruled, rule undeclared: unruled: no-such-rule is not a rule any lens in ${policy}'s full tier that reviews src/scan.ts declares`,
			expect.stringMatching(
				/^refused untouched, file unchanged: untouched: src\/none\.ts is not among the files [0-9a-f]{40}\.\.\.[0-9a-f]{40} changes$/,
			),
			expect.stringMatching(/^refused unknown, commit unresolved: /),
		];
		const using = runners();
		const { status, errors } = await measure({ ...env, MELIAN_EVAL_MISSES: mixed }, using);
		expect(status).toBe(2);
		expect(errors).toEqual([...refused, `1 of 4 misses can be scored under ${policy}`]);
		const dry = runners();
		const listed = await measure({ ...env, MELIAN_EVAL_MISSES: mixed, MELIAN_EVAL_PARITY_DRY: "1" }, dry);
		expect(listed).toEqual({
			status: 0,
			lines: [
				expect.stringMatching(/^scorable one: \S/),
				"    Enola's graph of one's head needs building before its reviews",
				...refused,
				`1 of 4 misses can be scored under ${policy}`,
			],
			errors: [],
		});
		for (const each of [using, dry]) {
			expect(each.availability).not.toHaveBeenCalled();
			expect(each.models).not.toHaveBeenCalled();
		}
		expect(existsSync(env.MELIAN_EVAL_PARITY_OUT!)).toBe(false);
		const other = buildGoldenRepository(failOpen);
		try {
			execFileSync("git", ["-C", other.repo, "checkout", "--quiet", "main"]);
			commitGoldenTree(other.repo, join(failOpen.directory, "head"), "moved");
			const split = join(scratch, "split.json");
			writeFileSync(
				split,
				JSON.stringify([one, { ...one, name: "far", repo: other.repo, base: other.base, head: other.head }]),
			);
			expect(
				(await measure({ ...env, MELIAN_EVAL_MISSES: split, MELIAN_EVAL_PARITY_DRY: "1" }, runners())).errors,
			).toEqual([
				expect.stringMatching(
					/^MELIAN_EVAL_POLICY_COMMIT main names [0-9a-f]{40} and [0-9a-f]{40} in the misses' clones, so the run would measure more than one policy$/,
				),
			]);
		} finally {
			rmSync(other.repo, { recursive: true, force: true });
		}
	});

	it("stops after a review that passed its stop, and at the run's stop before the next review", async () => {
		const review = await measure({ ...env, MELIAN_EVAL_PARITY_STOP_REVIEW: "179" }, runners());
		expect(review.status).toBe(3);
		expect(results().stopped).toBe("committed on one spent 180 tokens, past MELIAN_EVAL_PARITY_STOP_REVIEW, 179");
		expect(results().attempts).toHaveLength(1);
		rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		expect((await measure({ ...env, MELIAN_EVAL_PARITY_STOP_REVIEW: "180" }, runners())).status).toBe(1);
		rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		const run = runners();
		expect((await measure({ ...env, MELIAN_EVAL_PARITY_STOP_RUN: "180" }, run)).status).toBe(3);
		expect(run.range).toHaveBeenCalledTimes(1);
		rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		const under = runners();
		await measure({ ...env, MELIAN_EVAL_PARITY_STOP_RUN: "181", MELIAN_EVAL_PARITY_MISSES: "one" }, under);
		expect(under.range).toHaveBeenCalledTimes(2);
	});

	it("stops on a provider's usage limit, or a lens that answered on a second model, and records no score for that review", async () => {
		const limited = lensStage({ outcome: "failed", error: "You have hit your usage limit." });
		const failedOver = lensStage({ usage: usage({ first: 50, second: 50 }) });
		const proberOnTwo = lensStage({ role: "prober", usage: usage({ first: 50, second: 50 }) });
		const verifierOnTwo = lensStage({
			name: "melian.verification",
			subject: "verifier",
			usage: usage({ first: 50, second: 50 }),
		});
		for (const [stages, reason] of [
			[
				[limited],
				/^committed on one met a provider's usage limit in correctness@1@deep: You have hit your usage limit\.$/,
			],
			[
				[failedOver],
				/^committed on one met correctness@1@deep answered on first and second, so a model failed over$/,
			],
			[[proberOnTwo], /^committed on one met correctness@1@deep answered on first and second/],
			[[verifierOnTwo], /^committed on one met verifier answered on first and second/],
		] as const) {
			const { status, lines } = await measure(env, runners([stages]));
			expect(status).toBe(3);
			expect(results().stopped).toMatch(reason);
			expect(results().attempts).toEqual([
				expect.objectContaining({
					miss: "one",
					arm: "committed",
					said: "not scored: the run stopped",
					stopped: results().stopped,
					tokens: 100,
				}),
			]);
			expect(lines.at(-1)).toMatch(/^stopped: .*; resume with the same MELIAN_EVAL_PARITY_OUT$/);
			rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		}
		const thrown = runners(undefined, {
			range: vi.fn(async () => {
				throw new Error("429 rate_limit_error: quota exceeded");
			}),
		});
		expect((await measure(env, thrown)).status).toBe(3);
		expect(results().stopped).toMatch(/^committed on one met a provider's usage limit: 429/);
		expect(results().attempts).toEqual([
			expect.objectContaining({
				stopped: results().stopped,
				error: "429 rate_limit_error: quota exceeded",
				tokens: 0,
			}),
		]);
		rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		const other = runners(undefined, {
			range: vi.fn(async () => {
				throw new Error("the clone vanished");
			}),
		});
		expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, other)).status).toBe(1);
		expect(results().attempts).toEqual([
			{
				miss: "one",
				arm: "committed",
				said: "no score: the clone vanished",
				error: "the clone vanished",
				tokens: 0,
				cacheRead: 0,
				budgetTokens: 0,
				stages: [],
				store: `${env.MELIAN_EVAL_PARITY_OUT}.stores/one-committed.sqlite`,
				graph: snapshot,
			},
			{
				miss: "one",
				arm: "parity",
				said: "not run: the committed arm had no review",
				tokens: 0,
				cacheRead: 0,
				budgetTokens: 0,
				stages: [],
			},
		]);
	});
	it("stops on a review a model without credentials left unrun, whether a lens, a prober or the verifier lacked it", async () => {
		const fake = createFakeModels();
		const bare = fake.withoutCredentials("bare");
		const real = runners(undefined, {
			models: vi.fn(async () => fake.review),
			// Without the arm's graph, which this host cannot build, so the review reaches its lenses' routes.
			range: vi.fn((target, mode) =>
				runRange(target, {
					...mode,
					model: `${bare.provider}/${bare.modelId}`,
					probing: { routed: (config, lenses, files) => mode.probing!.routed(config, lenses, files) },
				}),
			),
		});
		expect((await measure(env, real)).status).toBe(3);
		expect(results().stopped).toMatch(
			/^committed on one met no model with credentials: lens \S+ may run from careful to deep, and no level there can run: careful runs on heavy, and none of locked\/bare is known with credentials;/,
		);
		expect(results().attempts.map(({ miss, arm, said }) => ({ miss, arm, said }))).toEqual([
			{ miss: "one", arm: "committed", said: "not scored: the run stopped" },
		]);
		rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		const unverified = ran([lensStage()]);
		const verifier = {
			...unverified,
			verdict: new Verdict({
				status: "not-reviewed",
				blocking: false,
				findings: { block: [], acknowledge: [], advisory: [], silent: [] },
				dismissed: [],
				notRun: [{ name: "verifier", status: "failed", reason: "the verifier has no model with credentials" }],
			}),
		};
		expect((await measure(env, runners(undefined, { range: vi.fn(async () => verifier) }))).status).toBe(3);
		expect(results().stopped).toBe(
			"committed on one met no model with credentials in verifier: the verifier has no model with credentials",
		);
		rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		const prober = lensStage({
			outcome: "failed",
			error: "deep ran without probes, since its prober runs on heavy, and none of h/heavy is known with credentials",
		});
		expect((await measure(env, runners([[prober]]))).status).toBe(3);
		expect(results().stopped).toBe(
			"committed on one met no model with credentials in correctness@1@deep: deep ran without probes, since its prober runs on heavy, and none of h/heavy is known with credentials",
		);
		rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		const other = ran([lensStage({ error: "the lens did not finish" })]);
		const skipped = {
			...other,
			verdict: new Verdict({
				status: "passed",
				blocking: false,
				findings: { block: [], acknowledge: [], advisory: [], silent: [] },
				dismissed: [],
				notRun: [{ name: "guardrails", status: "skipped", reason: "a golden runs its lenses alone" }],
			}),
		};
		const going = runners(undefined, { range: vi.fn(async () => skipped) });
		await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, going);
		expect(results().stopped).toBeUndefined();
		expect(results().attempts.map(({ arm }) => arm)).toEqual(["committed", "parity"]);
	});

	it("keeps a stopped attempt's spend on resume, and reviews its arm again", async () => {
		const limited = lensStage({ outcome: "failed", error: "You have hit your usage limit." });
		expect((await measure(env, runners([[limited], committedStages]))).status).toBe(3);
		const resumed = runners();
		const { status, lines } = await measure(env, resumed);
		expect(status).toBe(1);
		expect(lines[0]).toMatch(/; run so far 280 tokens, 170 by Melian's budget count$/);
		expect(vi.mocked(resumed.range).mock.calls.map(([, mode]) => mode.store)[0]).toBe(
			`${env.MELIAN_EVAL_PARITY_OUT}.stores/one-committed.2.sqlite`,
		);
		expect((vi.mocked(resumed.range).mock.calls[1]![1].probing as ParityArm).total).toBe(60);
		expect(results().attempts.map(({ miss, arm, stopped }) => [miss, arm, stopped !== undefined])).toEqual([
			["one", "committed", true],
			["one", "committed", false],
			["one", "parity", false],
			["two", "committed", false],
			["two", "parity", false],
		]);
	});

	it("stops, scoring nothing, on a review whose telemetry did not measure a model stage's usage", async () => {
		for (const stage of [lensStage({ usage: undefined }), lensStage({ usageIncomplete: 1 })]) {
			const using = runners([[stage]]);
			expect((await measure(env, using)).status).toBe(3);
			expect(using.range).toHaveBeenCalledTimes(1);
			expect(results().stopped).toBe(
				"committed on one met usage its telemetry did not measure, in lens correctness",
			);
			expect(results().attempts).toEqual([
				expect.objectContaining({ said: "not scored: the run stopped", stopped: results().stopped }),
			]);
			rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		}
	});

	it("counts what a failed review's stages spent, and stops on a usage limit one of them met", async () => {
		const failing = (stages: readonly StageFields[]) =>
			runners(undefined, {
				range: vi.fn(async () => {
					throw new GoldenRunError(
						new Error("the verifier failed"),
						new StageTelemetry("base..head", [...stages]),
					);
				}),
			});
		expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, failing([lensStage()]))).status).toBe(1);
		expect(results().attempts[0]).toMatchObject({
			miss: "one",
			arm: "committed",
			said: "no score: the verifier failed",
			error: "the verifier failed",
			tokens: 100,
			cacheRead: 40,
			stages: [{ subject: "correctness@1@deep", tokens: 100, cacheRead: 40 }],
		});
		rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		const limited = lensStage({ outcome: "failed", error: "You have hit your usage limit." });
		expect((await measure(env, failing([limited]))).status).toBe(3);
		expect(results().stopped).toMatch(
			/^committed on one met a provider's usage limit in correctness@1@deep: You have hit your usage limit\.$/,
		);
	});
	it("records the parity arm as not run when the committed arm's lenses spent nothing", async () => {
		const offTop = committedStages.slice(1);
		const using = runners([offTop]);
		expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, using)).status).toBe(1);
		expect(using.range).toHaveBeenCalledTimes(1);
		expect(results().attempts[1]).toEqual({
			miss: "one",
			arm: "parity",
			said: "not run: the committed arm's lenses spent nothing",
			tokens: 0,
			cacheRead: 0,
			budgetTokens: 0,
			stages: [],
		});
		rmSync(env.MELIAN_EVAL_PARITY_OUT!);
		const one = runners([[lensStage({ usage: usage({ model: 41 }, 40) }), ...offTop]]);
		await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, one);
		expect((vi.mocked(one.range).mock.calls[1]![1].probing as ParityArm).total).toBe(1);
	});

	it("keeps a run stopped when a narrowed resume finishes its misses and leaves another the results file names", async () => {
		const judge = vi.spyOn(Miss.prototype, "judge").mockResolvedValue({ said: "found", found: true });
		try {
			expect((await measure({ ...env, MELIAN_EVAL_PARITY_STOP_RUN: "540" }, runners([withinTotal]))).status).toBe(3);
			expect(results().attempts.map(({ miss, arm }) => [miss, arm])).toEqual([
				["one", "committed"],
				["one", "parity"],
				["two", "committed"],
			]);
			const narrowed = await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, runners([withinTotal]));
			expect(narrowed.status).toBe(3);
			expect(results().stopped).toBe(
				"two is not yet reviewed in both arms; resume with it in MELIAN_EVAL_PARITY_MISSES",
			);
			expect(narrowed.lines.at(-1)).toBe(
				`stopped: two is not yet reviewed in both arms; resume with it in MELIAN_EVAL_PARITY_MISSES; resume with the same MELIAN_EVAL_PARITY_OUT`,
			);
			expect((await measure(env, runners([withinTotal]))).status).toBe(0);
			expect(results().stopped).toBeUndefined();
		} finally {
			judge.mockRestore();
		}
	});

	it("exits 0 on a resumed run that scored every miss, whatever attempts an earlier stop left", async () => {
		const judge = vi.spyOn(Miss.prototype, "judge").mockResolvedValue({ said: "found", found: true });
		try {
			const limited = lensStage({ outcome: "failed", error: "You have hit your usage limit." });
			expect((await measure(env, runners([[limited], withinTotal]))).status).toBe(3);
			expect((await measure(env, runners([withinTotal]))).status).toBe(0);
			judge.mockResolvedValueOnce({ said: "no score: unadjudicated" });
			rmSync(env.MELIAN_EVAL_PARITY_OUT!);
			expect((await measure(env, runners([withinTotal]))).status).toBe(1);
		} finally {
			judge.mockRestore();
		}
	});

	it("runs the parity arm when the committed review ran and only its judging failed", async () => {
		const judge = vi.spyOn(Miss.prototype, "judge").mockRejectedValueOnce(new Error("no clone"));
		try {
			const using = runners();
			expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, using)).status).toBe(1);
			expect(using.range).toHaveBeenCalledTimes(2);
			expect(results().attempts.map(({ arm, said, total }) => [arm, said, total])).toEqual([
				["committed", "no score: no clone", undefined],
				["parity", expect.any(String), 60],
			]);
		} finally {
			judge.mockRestore();
		}
	});

	it("resolves a miss's changed paths before its reviews, so nothing that can fail sits between a review and its save", async () => {
		const resolve = Changeset.resolve.bind(Changeset);
		let reviewed = false;
		const spy = vi.spyOn(Changeset, "resolve").mockImplementation(async (...args) => {
			if (reviewed) throw new Error("git failed");
			return resolve(...args);
		});
		try {
			const using = runners(undefined, {
				range: vi.fn(async () => {
					reviewed = true;
					return ran(committedStages);
				}),
			});
			expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, using)).status).toBe(1);
			expect(results().attempts.map(({ arm, tokens }) => [arm, tokens])).toEqual([
				["committed", 180],
				["parity", 180],
			]);
		} finally {
			spy.mockRestore();
		}
	});
	describe("a run that ended during a review", () => {
		const lensNames = [
			"trust-boundary",
			"correctness",
			"contracts",
			"removed-behaviour",
			"tests",
			"conventions",
			"design",
		];
		const pendingStore = () => `${env.MELIAN_EVAL_PARITY_OUT}.stores/one-committed.sqlite`;

		// The review never returns, as when the process dies during it; the attempt saved before it is all that is left.
		async function endDuring(review: (mode: LiveGoldenMode, target: ReviewTarget) => Promise<void>) {
			let started!: () => void;
			const reviewed = new Promise<void>((resolve) => {
				started = resolve;
			});
			const using = runners(undefined, {
				range: vi.fn(async (target, mode) => {
					await review(mode, target);
					started();
					return new Promise<RangeRun>(() => {});
				}),
			});
			void measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, using);
			await reviewed;
			// The dead run's lock is left, and refuses a resume until a person who knows no run is using it removes it.
			const lock = `${env.MELIAN_EVAL_PARITY_OUT}.lock`;
			expect(readFileSync(lock, "utf8")).toMatch(new RegExp(`^${process.pid} [0-9a-f-]{36}\\n$`));
			expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, runners())).status).toBe(2);
			rmSync(lock);
		}

		const ended = {
			miss: "one",
			arm: "committed",
			said: "not scored: the run ended during this review",
			stopped: "committed on one ended with the run, during its review",
			tokens: 0,
			cacheRead: 0,
			budgetTokens: 0,
			stages: [],
			graph: snapshot,
		};

		it("saves the attempt before its review, and settles it on resume from what its store recorded", async () => {
			const fake = createFakeModels();
			scriptConversations(
				fake,
				lensNames.map((lens) => ({
					match: `You are the ${lens} reviewer`,
					replies: [fauxAssistantMessage("Reported 0 findings.")],
				})),
			);
			const ref = fake.ref();
			await endDuring(async (mode, target) => {
				await runRange(target, {
					kind: "live",
					models: fake.review,
					model: `${ref.provider}/${ref.modelId}`,
					store: mode.store!,
				}).catch(() => undefined);
			});
			expect(results().attempts).toEqual([{ ...ended, pending: true, store: pendingStore() }]);
			const storage = await openSqliteStorage(pendingStore());
			const recorded = await TelemetryReader.open(storage)
				.read(Revision.key((await Changeset.resolve(repo, `${policy}...${head}`)).revision))
				.finally(() => storage.close(backgroundContext));
			const tokens = recorded.stages.reduce((sum, stage) => sum + (stage.usage?.total.totalTokens ?? 0), 0);
			expect(tokens).toBeGreaterThan(0);
			const resumed = runners();
			const { status, lines } = await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, resumed);
			expect(status).toBe(1);
			const [settled, ...rest] = results().attempts;
			expect(settled).toEqual({
				...ended,
				tokens,
				cacheRead: recorded.stages.reduce((sum, stage) => sum + (stage.usage?.total.cacheRead ?? 0), 0),
				budgetTokens: expect.any(Number),
				stages: expect.arrayContaining([expect.objectContaining({ subject: recorded.stages[0]!.subject })]),
				store: pendingStore(),
			});
			expect(settled!.stages).toHaveLength(recorded.stages.length);
			expect(rest.map(({ arm, store }) => [arm, store])).toEqual([
				["committed", `${env.MELIAN_EVAL_PARITY_OUT}.stores/one-committed.2.sqlite`],
				["parity", `${env.MELIAN_EVAL_PARITY_OUT}.stores/one-parity.sqlite`],
			]);
			expect(lines[0]).toMatch(new RegExp(`; run so far ${tokens + 180} tokens, `));
		});

		it("settles an attempt whose review never opened its store as spending nothing", async () => {
			await endDuring(async () => {});
			expect(existsSync(pendingStore())).toBe(false);
			expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, runners())).status).toBe(1);
			expect(results().attempts[0]).toEqual({ ...ended, store: pendingStore() });
			expect(existsSync(pendingStore())).toBe(false);
		});

		it("refuses to resume over a store it cannot read, or a miss the run no longer names", async () => {
			await endDuring(async () => {});
			const narrowed = await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "two" }, runners());
			expect(narrowed.status).toBe(2);
			expect(narrowed.errors).toEqual([
				`${env.MELIAN_EVAL_PARITY_OUT} holds a review of one that the run ended during; resume with one among MELIAN_EVAL_PARITY_MISSES to settle it`,
			]);
			writeFileSync(pendingStore(), "not a database");
			const using = runners();
			const { status, errors } = await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, using);
			expect(status).toBe(2);
			expect(errors).toEqual([
				expect.stringMatching(
					new RegExp(
						`^Cannot read ${pendingStore()}, the store of a review the run ended during, so its spend is unknown: `,
					),
				),
			]);
			expect(using.range).not.toHaveBeenCalled();
			expect(results().attempts).toEqual([{ ...ended, pending: true, store: pendingStore() }]);
		});

		it("stops on resume when the store of the review it settled did not measure a model stage's usage", async () => {
			await endDuring(async (mode) => {
				await (await openSqliteStorage(mode.store!)).close(backgroundContext);
			});
			const read = vi
				.spyOn(TelemetryReader.prototype, "read")
				.mockResolvedValue(
					new StageTelemetry("base..head", [
						lensStage({ usage: undefined }),
						lensStage({ id: "v", subject: "verifier" }),
					]),
				);
			try {
				const using = runners();
				expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, using)).status).toBe(3);
				expect(using.range).not.toHaveBeenCalled();
			} finally {
				read.mockRestore();
			}
			expect(results().stopped).toBe(
				"committed on one ended with the run, during its review, and its store did not measure usage in lens correctness",
			);
			expect(results().attempts).toEqual([
				{
					...ended,
					tokens: 100,
					cacheRead: 40,
					budgetTokens: 60,
					stages: [expect.objectContaining({ tokens: 0 }), expect.objectContaining({ tokens: 100 })],
					store: pendingStore(),
				},
			]);
			expect((await measure({ ...env, MELIAN_EVAL_PARITY_MISSES: "one" }, runners())).status).toBe(1);
		});
	});
});

describe("checkoutCommit", () => {
	it("names a clean checkout's head, and refuses one with changes no commit holds", () => {
		const { repo } = buildGoldenRepository(failOpen);
		try {
			const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			expect(checkoutCommit(repo, [])).toBe(head);
			writeFileSync(join(repo, "stray.txt"), "untracked\n");
			expect(() => checkoutCommit(repo, [])).toThrow(
				/^The checkout has changes no commit holds, .*\n\?\? stray\.txt$/s,
			);
			rmSync(join(repo, "stray.txt"));
			writeFileSync(join(repo, "src/scan.ts"), "changed\n");
			expect(() => checkoutCommit(repo, [])).toThrow(/ M src\/scan\.ts$/);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses an artefact inside the checkout, whatever path names it, and accepts one beside it", () => {
		const { repo } = buildGoldenRepository(failOpen);
		try {
			const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			const beside = `${repo}-results`;
			mkdirSync(beside);
			expect(
				checkoutCommit(repo, [join(beside, "parity.json"), join(scratch, "misses.json"), join(repo, "..")]),
			).toBe(head);
			symlinkSync(repo, join(scratch, "link"));
			writeFileSync(join(repo, "kept.json"), "{}\n");
			execFileSync("git", ["-C", repo, "add", "kept.json"]);
			execFileSync("git", [
				"-C",
				repo,
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@example.com",
				"commit",
				"-qm",
				"keep results",
			]);
			symlinkSync(join(repo, "kept.json"), join(scratch, "kept.json"));
			for (const [named, inside] of [
				[join(repo, "src", "parity.json"), join(repo, "src", "parity.json")],
				[join(repo, "..parity.json"), join(repo, "..parity.json")],
				[repo, repo],
				[join(scratch, "link", "parity.json"), join(repo, "parity.json")],
			])
				expect(() => checkoutCommit(repo, [join(scratch, "misses.json"), named])).toThrow(
					`${inside} is inside the checkout ${repo}, which the run must leave unchanged; name a path outside it`,
				);
			// The last name is judged where it sits, and measureParity refuses it as a link before it is opened.
			symlinkSync(join(repo, "new.json"), join(scratch, "dangling.json"));
			expect(checkoutCommit(repo, [join(scratch, "kept.json"), join(scratch, "dangling.json")])).toBe(
				execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
			);
			expect(() => checkoutCommit(repo, [join(scratch, "missing", "parity.json")])).toThrow(/ENOENT/);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(`${repo}-results`, { recursive: true, force: true });
		}
	});

	it("reads its own checkout, whatever repository GIT_DIR and GIT_WORK_TREE name", () => {
		const { repo } = buildGoldenRepository(failOpen);
		const { repo: other } = buildGoldenRepository(failOpen);
		try {
			const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			writeFileSync(join(other, "stray.txt"), "untracked\n");
			execFileSync("git", [
				"-C",
				other,
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@example.com",
				"commit",
				"--allow-empty",
				"-qm",
				"another",
			]);
			vi.stubEnv("GIT_DIR", join(other, ".git"));
			vi.stubEnv("GIT_WORK_TREE", other);
			expect(checkoutCommit(repo, [])).toBe(head);
		} finally {
			vi.unstubAllEnvs();
			rmSync(repo, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});

	// Git's own stderr goes to this process's unless captured, so the check runs checkoutCommit in a child it reads.
	it("escapes the control bytes of a directory git cannot enter, in its error and on stderr", () => {
		const missing = join(scratch, "gone\u001b[31m");
		const parity = join(import.meta.dirname, "..", "src", "parity.ts");
		const child = spawnSync(
			process.execPath,
			[
				"--conditions=@melian-agent/source",
				"--no-warnings",
				"--input-type=module",
				"-e",
				`import { checkoutCommit } from ${JSON.stringify(parity)}; try { checkoutCommit(${JSON.stringify(missing)}, []); } catch (error) { process.stdout.write(error.message); }`,
			],
			{ encoding: "utf8", timeout: 60_000 },
		);
		expect(child.stdout).toContain(join(scratch, "gone\\u001b[31m"));
		expect(`${child.stdout}${child.stderr}`).not.toContain("\u001b");
	});
});

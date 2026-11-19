import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	Verdict,
} from "@melian-agent/core";
import { StageTelemetry, TokenUsage } from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoldenRepository, commitGoldenTree, loadGoldens, type RangeRun } from "../src/goldens.ts";
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
	scratch = mkdtempSync(join(tmpdir(), "melian-parity-eval-"));
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
		const lenses = [root, scoped, await named("b", ["docs/**"])];
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
		expect(arm.routed(config, lenses, files).lenses.map((lens) => lens.level("deep").budget.tokens)).toEqual([
			250, 125, 125,
		]);
		expect(Object.keys(arm.routed(config, lenses, files).config.lenses)).toEqual(["a", "b"]);
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
		const lenses = [a, graphed, off];
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
		expect(routed.config.lenses).toEqual({
			a: { route: { model: "r/route", thinking: "high" }, level: { floor: "deep", ceiling: "deep" } },
			b: { level: { floor: "deep", ceiling: "deep" } },
		});
		const [routedA, routedB, routedOff] = routed.lenses;
		expect(routedOff).toBe(off);
		expect(routedA!.tools).toEqual([...new Set([...a.tools, ...lensGraphToolNames])]);
		expect(routedA!.instructions).toBe(`${a.instructions}\n\n${graphGuidance}`);
		expect(routedB!.tools).toEqual(graphed.tools);
		expect(routedB!.instructions).toBe(graphed.instructions);
		const base = a.levels.deep ?? a.levels.careful;
		expect(routedA!.level("deep")).toEqual({
			...base,
			budget: {
				findings: Math.max(base.budget.findings, 16),
				tokens: Math.floor(shares.get("a")! / 2),
				tools: 400,
				ended: "count",
			},
			probe: base.probe ?? {},
		});
		expect(routedA!.level("careful")).toEqual(a.level("careful"));
		const unprobed = await named("b", ["**"], unprobing[0]);
		const [, again] = arm.routed(config, [a, unprobed], files).lenses;
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

	const committedStages = [
		lensStage(),
		lensStage({ id: "v", name: "melian.verification", subject: "verifier", usage: usage({ model: 30 }, 10) }),
		lensStage({ id: "p", role: "prober", usage: usage({ model: 50 }, 20) }),
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
			commit: () => "c".repeat(40),
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
		expect(lines[1]).toMatch(
			/^Parity per total budget two: .*; run so far 360 tokens, 220 by Melian's budget count$/,
		);
		const written = results();
		expect(written).toMatchObject({ version: 1, arm: parityArmName, commit: "c".repeat(40), policyCommit: policy });
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
			outcome: "completed",
			tokens: 100,
			cacheRead: 40,
			budgetTokens: 60,
			tools: 7,
			minutes: 2,
		});
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
			lines: [expect.stringMatching(/^scorable one: \S/), ...refused, `1 of 4 misses can be scored under ${policy}`],
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

	it("exits 0 on a resumed run that scored every miss, whatever attempts an earlier stop left", async () => {
		const judge = vi.spyOn(Miss.prototype, "judge").mockResolvedValue({ said: "found", found: true });
		try {
			const limited = lensStage({ outcome: "failed", error: "You have hit your usage limit." });
			expect((await measure(env, runners([[limited], committedStages]))).status).toBe(3);
			expect((await measure(env, runners())).status).toBe(0);
			judge.mockResolvedValueOnce({ said: "no score: unadjudicated" });
			rmSync(env.MELIAN_EVAL_PARITY_OUT!);
			expect((await measure(env, runners())).status).toBe(1);
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
});

describe("checkoutCommit", () => {
	it("names a clean checkout's head, and refuses one with changes no commit holds", () => {
		const { repo } = buildGoldenRepository(failOpen);
		try {
			const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			expect(checkoutCommit(repo)).toBe(head);
			writeFileSync(join(repo, "stray.txt"), "untracked\n");
			expect(() => checkoutCommit(repo)).toThrow(/^The checkout has changes no commit holds, .*\n\?\? stray\.txt$/s);
			rmSync(join(repo, "stray.txt"));
			writeFileSync(join(repo, "src/scan.ts"), "changed\n");
			expect(() => checkoutCommit(repo)).toThrow(/ M src\/scan\.ts$/);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

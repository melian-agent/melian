import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	verifierRoute,
} from "@melian-agent/evals";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptLenses,
	scriptVerifier,
	textOf,
	unconfinedSandbox,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GoldenRunError } from "../src/run-error.ts";

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
		["x=a/b c", 'entry "x=a/b c" is not'],
		["x=/b", 'entry "x=/b" is not'],
		["x=a/", 'entry "x=a/" is not'],
		["x=ab/c/d", undefined],
		["x=a b/c", 'entry "x=a b/c" is not'],
		["same=ax>a/x", 'entry "same=ax>a/x" is not'],
		["same=a/x>b", 'entry "same=a/x>b" is not'],
		["Same=a/x", 'entry "Same=a/x" is not'],
		["same=a/x;same=b/y", "names same twice"],
	])("refuses %s", (text, problem) => {
		if (problem === undefined) expect(parseCombinations(text)[0]!.routes).toEqual({ planner: "ab/c/d" });
		else expect(() => parseCombinations(text)).toThrow(problem);
	});

	it("trims each side of an entry, and leaves the prober out of a level without probes", () => {
		expect(parseCombinations("x= a/b > c/d ")[0]!.routes).toEqual({ planner: "a/b", prober: "c/d" });
		expect(parseCombinations("x=a/b")[0]!.routes).not.toHaveProperty("prober");
	});
});

describe("verifierRoute", () => {
	it("reads one route, trimmed, and refuses none or one that is not provider/model", () => {
		expect(verifierRoute("a/judge")).toBe("a/judge");
		expect(verifierRoute(" a/judge ")).toBe("a/judge");
		for (const text of [undefined, "", "judge", "a/"])
			expect(() => verifierRoute(text)).toThrow("MELIAN_EVAL_VERIFIER_MODEL must name one verifier route");
	});
});

describe("routedProbing", () => {
	it("moves each level that probes to a prober on medium, and routes heavy and medium", async () => {
		const lenses = await Lens.builtins();
		const routed = routedProbing({ planner: "a/plan", prober: "b/probe" }, lenses, defaultConfig);
		const trust = routed.lenses.find((lens) => lens.name === "trust-boundary")!;
		expect(trust.level("deep").probe).toEqual({ prober: "medium" });
		expect(trust.level("careful")).not.toHaveProperty("probe");
		expect(routed.config.models.heavy).toStrictEqual({ model: "a/plan" });
		expect(routed.config.models.medium).toStrictEqual({ model: "b/probe" });
	});

	it("keeps each tier's reasoning level, and none of its other models, on the combination's routes", async () => {
		const config = {
			...defaultConfig,
			models: {
				...defaultConfig.models,
				heavy: { model: "x/heavy", thinking: "low", fallbacks: ["x/other"] },
				medium: { model: "x/medium", thinking: "high" },
			},
		} as typeof defaultConfig;
		const routed = routedProbing({ planner: "a/plan", prober: "b/probe" }, await Lens.builtins(), config);
		expect(routed.config.models.heavy).toEqual({ model: "a/plan", thinking: "low" });
		expect(routed.config.models.medium).toEqual({ model: "b/probe", thinking: "high" });
	});

	it("drops every probe for the level without probes, and leaves medium as it was", async () => {
		const routed = routedProbing({ planner: "a/plan" }, await Lens.builtins(), defaultConfig);
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
		writeFileSync(bad, JSON.stringify([{ ...miss, file: "" }]));
		expect(() => loadMisses(bad)).toThrow(`${bad}: /0/file`);
		writeFileSync(bad, JSON.stringify([{ ...miss, extra: "x" }]));
		expect(() => loadMisses(bad)).toThrow(`${bad}: /0`);
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
		const unverified = Finding.create({
			rule: "path-traversal",
			message: "m",
			file: "src/a.ts",
			startLine: 1,
			snippet: "x",
			occurrence: 0,
			cause: "introduced",
			severity: "P1",
			explanation: { what: "w", whyHere: "y", whatToDo: "d" },
			source: { check: "lens.trust-boundary", version: "v@deep" },
		});
		expect(foundMiss(miss, [unverified])).toBe(true);
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
				goldens: { precision: null, recall: null, failed: 2 },
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
			/^off \(a\/x planning, no probes probing\): goldens incomplete; misses recall 0\.00 \(0 of 2\); .* 2 failed$/,
		);
	});
});

describe("measureProbing's totals", () => {
	it("sums each pass's scores, misses and spend, and counts every failure", async () => {
		// A clock that stands still, so the failed review's measured time is exactly 0.
		vi.useFakeTimers({ toFake: ["Date"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const lost = golden("trust-boundary-probe-claim-lost-release");
		const telemetry = {
			total: { total: { totalTokens: 7, cost: { total: 0.25 } } },
			spend: () => "7 tokens",
		} as never;
		const miss: Miss = { name: "m", repo: "/r", base: "a", head: "b", file: "f", rule: "r" };
		const hit = Finding.create({
			rule: "r",
			message: "m",
			file: "f",
			startLine: 1,
			snippet: "x",
			occurrence: 0,
			cause: "introduced",
			severity: "P1",
			explanation: { what: "w", whyHere: "y", whatToDo: "d" },
			source: { check: "lens.trust-boundary", version: "v@deep" },
		});
		let misses = 0;
		const lines: string[] = [];
		const [result] = await measureProbing(
			parseCombinations("x=a/b>c/d"),
			[lost],
			[miss, { ...miss, name: "n" }],
			2,
			{
				golden: async () => ({ telemetry, findings: [], milliseconds: 100 }) as never,
				miss: async () => {
					misses++;
					if (misses === 4) throw new Error("down");
					return { findings: misses === 1 ? [hit] : [], tokens: 3, cost: 0.5, milliseconds: 10 };
				},
			},
			(line) => lines.push(line),
		);
		expect(result).toEqual({
			label: "x",
			routes: { planner: "a/b", prober: "c/d" },
			passes: 2,
			goldens: { precision: 1, recall: 0, failed: 0 },
			misses: { found: 1, total: 4, recall: null, failed: 1 },
			tokens: 2 * 7 + 3 * 3,
			cost: 2 * 0.25 + 3 * 0.5,
			milliseconds: 2 * 100 + 3 * 10,
		});
		expect(lines).toEqual([
			"x pass 1 trust-boundary-probe-claim-lost-release: precision 1.00, recall 0.00, 7 tokens, 100 ms",
			"x pass 1 m: found, 1 reported, 3 tokens, $0.5, 10 ms",
			"x pass 1 n: missed, 0 reported, 3 tokens, $0.5, 10 ms",
			"x pass 2 trust-boundary-probe-claim-lost-release: precision 1.00, recall 0.00, 7 tokens, 100 ms",
			"x pass 2 m: missed, 0 reported, 3 tokens, $0.5, 10 ms",
			"x pass 2 n: no result (Error: down)",
			"x (a/b planning, c/d probing): goldens precision 1.00, recall 0.00; misses incomplete (1 of 4); 23 tokens, $2.00, 0 s; 1 failed",
		]);
	});

	it("gives no headline score to a combination with a failed review, and counts that review's spend and time", async () => {
		const lost = golden("trust-boundary-probe-claim-lost-release");
		const paid = { total: { total: { totalTokens: 7, cost: { total: 0.25 } } }, spend: () => "7 tokens" } as never;
		const miss: Miss = { name: "m", repo: "/r", base: "a", head: "b", file: "f", rule: "r" };
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const [failedGolden, failedMiss] = await measureProbing(
				parseCombinations("golden=a/b>c/d;miss=a/b>e/f"),
				[lost],
				[miss],
				1,
				{
					golden: async (_, routes) => {
						vi.setSystemTime(Date.now() + 30);
						if (routes.prober === "c/d") throw new GoldenRunError(new Error("down"), paid);
						return { telemetry: paid, findings: [], milliseconds: 30 } as never;
					},
					miss: async (_, routes) => {
						vi.setSystemTime(Date.now() + 20);
						if (routes.prober === "e/f") throw new GoldenRunError(new Error("gone"), paid);
						return { findings: [], tokens: 3, cost: 0.5, milliseconds: 20 };
					},
				},
				() => {},
			);
			expect(failedGolden).toMatchObject({
				goldens: { precision: null, recall: null, failed: 1 },
				misses: { recall: 0, failed: 0 },
				tokens: 7 + 3,
				cost: 0.25 + 0.5,
				milliseconds: 30 + 20,
			});
			expect(failedMiss).toMatchObject({
				goldens: { precision: 1, recall: 0, failed: 0 },
				misses: { found: 0, total: 1, recall: null, failed: 1 },
				tokens: 7 + 7,
				cost: 0.25 + 0.25,
				milliseconds: 30 + 20,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("counts nothing for a failed review that spent nothing, and scores the misses found as their share", async () => {
		const lost = golden("trust-boundary-probe-claim-lost-release");
		const miss: Miss = { name: "m", repo: "/r", base: "a", head: "b", file: "f", rule: "r" };
		const hit = Finding.create({
			rule: "r",
			message: "m",
			file: "f",
			startLine: 1,
			snippet: "x",
			occurrence: 0,
			cause: "introduced",
			severity: "P1",
			explanation: { what: "w", whyHere: "y", whatToDo: "d" },
			source: { check: "lens.trust-boundary", version: "v@deep" },
		});
		let misses = 0;
		const [result] = await measureProbing(
			parseCombinations("x=a/b>c/d"),
			[lost],
			[miss, { ...miss, name: "n" }],
			1,
			{
				golden: async () => {
					throw new GoldenRunError(new Error("refused"), { spend: () => "nothing" } as never);
				},
				miss: async () => ({ findings: ++misses === 1 ? [hit] : [], tokens: 0, cost: 0, milliseconds: 0 }),
			},
			() => {},
		);
		expect(result).toMatchObject({
			goldens: { precision: null, recall: null, failed: 1 },
			misses: { found: 1, total: 2, recall: 0.5, failed: 0 },
			tokens: 0,
			cost: 0,
		});
	});

	it("scores no misses as full recall", async () => {
		const [result] = await measureProbing(parseCombinations("x=a/b"), [], [], 1, {} as never, () => {});
		expect(result!.misses).toEqual({ found: 0, total: 0, recall: 1, failed: 0 });
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
			expect(run.milliseconds).toBeLessThan(60_000);
			expect(run.tokens).toBeGreaterThan(0);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("keeps the spend of a review that fails after a model answered", async () => {
		const { repo, base } = buildGoldenRepository(golden("trust-boundary-probe-claim-lost-release"));
		try {
			const fake = createFakeModels({ models: [{ id: "plan" }, { id: "probe" }] });
			const failure: unknown = await reviewMiss(
				{ name: "m", repo, base, head: "feature", file: ".github/workflows/claim.yml", rule: "fail-open" },
				fake.review,
				{ planner: `${fake.ref("plan").provider}/plan`, prober: `${fake.ref("probe").provider}/probe` },
				undefined,
				unconfinedSandbox(),
			).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(GoldenRunError);
			expect((failure as GoldenRunError).telemetry.total!.total.totalTokens).toBeGreaterThan(0);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it.each([true, false])(
		"finds a miss with a failing probe, judged on the verifier the measurement names: %s",
		async (verifier) => {
			const lost = golden("trust-boundary-probe-claim-lost-release");
			const { repo, base } = buildGoldenRepository(lost);
			try {
				const fake = createFakeModels({ models: [{ id: "plan" }, { id: "probe" }, { id: "judge" }] });
				const script = JSON.parse(readFileSync(join(lost.directory, "script.json"), "utf8")) as Record<
					string,
					{ calls?: { name: string; arguments: Record<string, unknown> }[]; text?: string }[]
				>;
				const turns = (steps: (typeof script)[string]) =>
					steps.map((step) => (messages: readonly { role: string }[]) => {
						if (step.text !== undefined) return fauxAssistantMessage(step.text);
						const results = (messages as Parameters<typeof textOf>[0][])
							.filter((each) => each.role === "toolResult")
							.map(textOf);
						const probe = results
							.map((each) => /probe (p[0-9]+)/.exec(each)?.[1])
							.filter(Boolean)
							.at(-1);
						return fauxAssistantMessage(
							step.calls!.map((call) =>
								fauxToolCall(
									call.name,
									JSON.parse(JSON.stringify(call.arguments).replaceAll("{{probe}}", probe ?? "")) as never,
								),
							),
							{ stopReason: "toolUse" },
						);
					});
				const judged: string[] = [];
				scriptConversations(fake, [
					{
						match: "Your role at this level: the attack planner",
						replies: turns(script["trust-boundary"]!) as never,
					},
					{
						match: "You are the prober for the trust-boundary lens",
						replies: turns(script["trust-boundary/prober"]!) as never,
					},
					{
						match: "Melian adversarial verifier",
						replies: [0, 1].map(() => (messages: Parameters<typeof scriptVerifier>[0], model: string) => {
							judged.push(model);
							return scriptVerifier(messages);
						}),
					},
				]);
				const provider = fake.ref("plan").provider;
				const miss: Miss = {
					name: "m",
					repo,
					base,
					head: "feature",
					file: ".github/workflows/claim.yml",
					rule: "fail-open",
				};
				const sandbox = unconfinedSandbox();
				const run = await reviewMiss(
					miss,
					fake.review,
					{ planner: `${provider}/plan`, prober: `${provider}/probe` },
					verifier ? `${provider}/judge` : undefined,
					sandbox,
				);
				expect(foundMiss(miss, run.findings)).toBe(true);
				expect(judged[0]).toBe(verifier ? "judge" : "plan");
				expect(sandbox.asked.length).toBeGreaterThan(0);
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		},
	);
});

describe("a live golden run under probing routes", { timeout: 60_000 }, () => {
	it("routes the planner on heavy and the prober on medium, and finds the golden's defect", async () => {
		const lost = golden("trust-boundary-probe-claim-lost-release");
		const fake = createFakeModels({ models: [{ id: "plan" }, { id: "probe" }] });
		const script = JSON.parse(readFileSync(join(lost.directory, "script.json"), "utf8")) as Record<
			string,
			{ calls?: { name: string; arguments: Record<string, unknown> }[]; text?: string }[]
		>;
		const seen: string[] = [];
		const turns = (steps: (typeof script)[string]) =>
			steps.map((step) => (messages: Parameters<typeof scriptVerifier>[0], model: string) => {
				seen.push(model);
				if (step.text !== undefined) return fauxAssistantMessage(step.text);
				const probe = messages
					.filter((each) => each.role === "toolResult")
					.map((each) => /probe (p[0-9]+)/.exec(textOf(each))?.[1])
					.filter(Boolean)
					.at(-1);
				return fauxAssistantMessage(
					step.calls!.map((call) =>
						fauxToolCall(
							call.name,
							JSON.parse(JSON.stringify(call.arguments).replaceAll("{{probe}}", probe ?? "")) as never,
						),
					),
					{ stopReason: "toolUse" },
				);
			});
		scriptConversations(fake, [
			{ match: "Your role at this level: the attack planner", replies: turns(script["trust-boundary"]!) },
			{ match: "You are the prober for the trust-boundary lens", replies: turns(script["trust-boundary/prober"]!) },
		]);
		const provider = fake.ref("plan").provider;
		const run = await runGolden(lost, {
			kind: "live",
			models: fake.review,
			verifierModel: `${provider}/plan`,
			probing: { planner: `${provider}/plan`, prober: `${provider}/probe` },
		});
		expect(run.findings.map((each) => each.ruleId)).toEqual(["fail-open"]);
		expect(seen.slice(0, 2)).toEqual(["plan", "plan"]);
		expect(seen.slice(2)).toEqual(["probe", "probe", "probe"]);
	});
});

describe("scripting a prober", () => {
	it("refuses a prober script for a lens the review has not, or a name that only starts like one", async () => {
		const fake = createFakeModels();
		const lenses = await Lens.builtins();
		expect(() => scriptLenses(fake, lenses, { "nope/prober": [] })).toThrow("nope/prober");
		expect(() => scriptLenses(fake, lenses, { "trust-boundary/proberx": [] })).toThrow("trust-boundary/proberx");
		expect(() => scriptLenses(fake, lenses, { "trust-boundary/prober": [] })).not.toThrow();
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
		// Every combination's verdicts come from one fixed verifier, so a planner never picks its own judge.
		const one = { MELIAN_EVAL_LIVE: "1", MELIAN_EVAL_PROBE_ROUTES: "same=a/x", MELIAN_EVAL_PROBE_PASSES: "1" };
		const judge = run({ ...one, MELIAN_EVAL_GOLDEN: "trust-boundary-probe-claim-lost-release" });
		expect(judge.status).toBe(2);
		expect(judge.stderr).toContain("MELIAN_EVAL_VERIFIER_MODEL must name one verifier route");
		const malformed = run({ ...one, MELIAN_EVAL_VERIFIER_MODEL: "judge" });
		expect(malformed.status).toBe(2);
		expect(malformed.stderr).toContain("MELIAN_EVAL_VERIFIER_MODEL must name one verifier route");
	}, 60_000);
});

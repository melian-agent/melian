import { describe, expect, it } from "vitest";
import { runStands } from "../src/review.ts";

type Run = Parameters<typeof runStands>[0];
type Outcome = Parameters<typeof runStands>[1];

// The fields of a run its record reads; the rest of a stored run does not decide whether it stands.
const run = (extra: Record<string, unknown> = {}): Run =>
	({
		key: "trust-boundary@1@deep",
		name: "trust-boundary",
		version: "1",
		level: "deep",
		budget: { findings: 8, tokens: 600_000, tools: 90 },
		...extra,
	}) as unknown as Run;

const done = (extra: Record<string, unknown> = {}): Outcome =>
	({ status: "done", model: "anthropic/claude-a", ...extra }) as Outcome;

const budgetEnded = { budget: "tokens", limit: 1, tokens: 2, tools: 0 };
const accepts = () => false;
const refuses = (refused: string) => (_key: string, model: string) => model === refused;
const probing = { attacks: 2, probes: 1, milliseconds: 1, skipped: 0, unanswered: [], model: "anthropic/claude-b" };

describe("runStands", () => {
	it.each([
		["with no outcome", run(), undefined, accepts],
		["that did not finish", run(), { status: "unanswered", reason: "r" } as Outcome, accepts],
		["whose every model failed", run(), { status: "exhausted", tried: ["a"], reason: "r" } as Outcome, accepts],
		[
			"whose prober left an attack unanswered",
			run({ probe: {} }),
			done({ probing: { ...probing, unanswered: [2] } }),
			accepts,
		],
		["that its findings budget capped", run(), done({ capped: 8 }), accepts],
		["that lost its standards", run({ standardsOmitted: true }), done(), accepts],
		["whose budget ended at a level that does not count it", run(), done({ budgetEnded }), accepts],
		["that finished on a model the plan refuses", run(), done(), refuses("anthropic/claude-a")],
		[
			"whose prober, on the level's own tier, finished on a model the plan refuses",
			run({ probe: { onLevelTier: true } }),
			done({ probing }),
			refuses("anthropic/claude-b"),
		],
	])("never lets a run stand %s", (_, given, outcome, refused) => {
		expect(runStands(given, outcome, refused, undefined)).toBe(false);
	});

	const result = (given: Record<string, unknown> = {}) => ({
		exitCode: 1,
		signal: null,
		output: "",
		truncated: false,
		timedOut: false,
		...given,
	});
	const ran = run({ probe: {} });
	const answered = done({ probing });

	it.each([
		["the sandbox refused, which left no result", { attempts: ["p1", "p2"], probes: { p1: { result: result() } } }],
		["the sandbox refused, as it refused every probe", { attempts: ["p1"] }],
		["timed out", { attempts: ["p1"], probes: { p1: { result: result({ exitCode: null, timedOut: true }) } } }],
		["was cut", { attempts: ["p1"], probes: { p1: { result: result({ truncated: true }) } } }],
		[
			"was ended by a signal",
			{ attempts: ["p1"], probes: { p1: { result: result({ exitCode: null, signal: "SIGKILL" }) } } },
		],
	])("never lets a probing run stand when a probe it tried %s", (_, tried) => {
		expect(runStands(ran, answered, accepts, tried as Parameters<typeof runStands>[3])).toBe(false);
	});

	it("lets a probing run stand when every probe it tried passed or failed", () => {
		const tried = {
			attempts: ["p1", "p2"],
			probes: { p1: { result: result({ exitCode: 0 }) }, p2: { result: result({ exitCode: 1 }) } },
		};
		expect(runStands(ran, answered, accepts, tried)).toBe(true);
	});

	it.each([
		["that ran", run(), done(), accepts],
		[
			"whose budget ended at a level that counts it",
			run({ budget: { findings: 8, tokens: 1, tools: 90, ended: "count" } }),
			done({ budgetEnded }),
			accepts,
		],
		["whose prober answered every attack", run({ probe: {} }), done({ probing }), accepts],
		["with no model recorded, since nothing names one to refuse", run(), done({ model: undefined }), () => true],
		[
			"whose prober on a tier of its own finished on a model its check is not judged by",
			run({ probe: {} }),
			done({ probing }),
			refuses("anthropic/claude-b"),
		],
	])("lets a run stand %s", (_, given, outcome, refused) => {
		expect(runStands(given, outcome, refused, undefined)).toBe(true);
	});
});

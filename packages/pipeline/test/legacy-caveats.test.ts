import { expect, it } from "vitest";
import { AdjudicationTask, VerdictDocument } from "../src/adjudication.ts";
import { blindCallers, callersWithLegacyCaveat, lightTriage, withLegacyCaveats } from "../src/caveats.ts";
import { createReviewRegistry } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";

const blind = `${blindCallers}: graph missing`;

it("adds the caveats a lens record's notes stand for, and leaves every other record as it was", () => {
	const lens = {
		name: "lens.correctness",
		status: "ran",
		reason: `kept a hand-off; Callers unavailable: graph missing; ${lightTriage}`,
	};
	expect(withLegacyCaveats(lens)).toEqual({ ...lens, caveats: [blind, lightTriage] });
	const kept = { ...lens, caveats: ["already said"] };
	expect(withLegacyCaveats(kept)).toBe(kept);
	const silent = { name: "lens.correctness", status: "ran" };
	expect(withLegacyCaveats(silent)).toBe(silent);
	const check = { name: "static.enola", status: "ran", reason: "Callers unavailable: graph missing" };
	expect(withLegacyCaveats(check)).toBe(check);
	const plain = { name: "lens.design", status: "ran", reason: "kept a hand-off" };
	expect(withLegacyCaveats(plain)).toBe(plain);
});

it("names the caller caveat of stored callers once, and only when no lens had a caller context", () => {
	const callers = {
		notes: { "a@1": ["Callers unavailable: graph missing"], "b@1": ["Callers unavailable: graph missing"] },
	};
	expect(callersWithLegacyCaveat(callers)).toEqual({ ...callers, caveat: blind });
	const named = { ...callers, caveat: "already said" };
	expect(callersWithLegacyCaveat(named)).toBe(named);
	const light = { notes: { "a@1": [lightTriage, "Callers unavailable for a.ts: line 1: ambiguous"] } };
	expect(callersWithLegacyCaveat(light)).toBe(light);
});

it("upgrades a version-3 review index entry's callers, and an entry with none as it was", () => {
	const migrate = ReviewIndex.definition.migrate!;
	const entry = { lenses: ["a"], callers: { notes: { "a@1": ["Callers unavailable: graph missing"] } } };
	const bare = { lenses: ["b"] };
	expect(migrate({ reviews: { one: entry, two: bare } }, 3)).toEqual({
		reviews: { one: { ...entry, callers: { ...entry.callers, caveat: blind } }, two: bare },
	});
});

it("upgrades a version-4 lens task input's callers, and an input with none as it was", () => {
	const migrate = createReviewRegistry().snapshot().task("melian.lenses")!.definition.migrate as (
		input: unknown,
		checkpoint: unknown,
		from: number,
	) => { input: { callers?: unknown } };
	const input = {
		root: 1,
		revision: {},
		lenses: [],
		callers: { notes: { "a@1": ["Callers unavailable: graph missing"] } },
	};
	expect(migrate(input, { phase: "spawn" }, 4).input.callers).toEqual({ ...input.callers, caveat: blind });
	const { callers: _, ...bare } = input;
	expect(migrate(bare, { phase: "spawn" }, 4).input).not.toHaveProperty("callers");
});

it("upgrades a version-12 verdict's lens records, and one recorded before verdicts kept the checks that ran", () => {
	const migrate = VerdictDocument.definition.migrate!;
	const verdict = (ran?: { name: string; status: string; reason: string }[]) => ({
		status: "passed",
		blocking: false,
		findings: { block: [], acknowledge: [], advisory: [], silent: [] },
		dismissed: [],
		notRun: [{ name: "lens.design", status: "failed", reason: "Callers unavailable: graph missing" }],
		...(ran === undefined ? {} : { ran }),
	});
	const upgraded = migrate(
		{
			verdicts: { one: verdict([{ name: "lens.correctness", status: "ran", reason: lightTriage }]), two: verdict() },
		},
		12,
	) as { verdicts: Record<string, { ran?: unknown[]; notRun: unknown[] }> };
	expect(upgraded.verdicts.one!.ran).toEqual([
		{ name: "lens.correctness", status: "ran", reason: lightTriage, caveats: [lightTriage] },
	]);
	expect(upgraded.verdicts.one!.notRun).toEqual([
		{ name: "lens.design", status: "failed", reason: "Callers unavailable: graph missing", caveats: [blind] },
	]);
	expect(upgraded.verdicts.two).not.toHaveProperty("ran");
});

it("upgrades a version-5 adjudication input's checks", () => {
	const migrate = AdjudicationTask.definition.migrate as (
		input: unknown,
		checkpoint: unknown,
		from: number,
	) => { input: { checks: unknown[] } };
	const checks = [{ name: "lens.correctness", status: "ran", reason: "Callers unavailable: graph missing" }];
	expect(migrate({ checks }, { phase: "adjudicate" }, 5).input.checks).toEqual([{ ...checks[0], caveats: [blind] }]);
});

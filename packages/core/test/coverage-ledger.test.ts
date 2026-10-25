import {
	CoverageRecord,
	coverageProducer,
	type LedgerGap,
	type StoredCheckCoverage,
	type StoredCoverageRecord,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const needs = {
	head: {
		"src/a.ts": [
			[1, 4],
			[9, 9],
		] as [number, number][],
	},
	base: { "src/gone.ts": [[1, 2]] as [number, number][] },
	units: { "bin/run": ["status", "path", "oldMode", "newMode", "oldKind", "newKind", "binary"] as const },
};

function lens(overrides: Partial<StoredCheckCoverage> = {}): StoredCheckCoverage {
	return {
		kind: "lens",
		version: "1",
		status: "ran",
		required: { "src/a.ts": "careful", "src/gone.ts": "careful", "bin/run": "careful" },
		needs: structuredClone({ ...needs, units: { "bin/run": [...needs.units["bin/run"]] } }),
		covered: [
			{
				level: "careful",
				head: { "src/a.ts": [[1, 9]] },
				base: { "src/gone.ts": [[1, 2]] },
				units: { "bin/run": [...needs.units["bin/run"]] },
			},
		],
		...overrides,
	};
}

function range(overrides: Partial<StoredCheckCoverage> = {}): StoredCheckCoverage {
	return {
		kind: "range",
		status: "ran",
		required: {},
		needs: structuredClone({ ...needs, units: { "bin/run": [...needs.units["bin/run"]] } }),
		covered: [{ ...structuredClone({ ...needs, units: { "bin/run": [...needs.units["bin/run"]] } }) }],
		...overrides,
	};
}

function record(
	checks: Record<string, StoredCheckCoverage>,
	overrides: Partial<StoredCoverageRecord> = {},
): CoverageRecord {
	return CoverageRecord.from({
		producer: { ...coverageProducer },
		round: "r2",
		base: "a".repeat(40),
		head: "b".repeat(40),
		tier: "full",
		policy: "p",
		source: "revision",
		melian: "0.0.0",
		leave: "writer",
		voids: [],
		units: { "bin/run": "mode" },
		checks,
		...overrides,
	});
}

const only = (gaps: LedgerGap[]) =>
	gaps.map(({ check, file, revision, lines, reason }) => ({ check, file, revision, lines, reason }));

describe("CoverageRecord", () => {
	it("is complete when every check covered everything it must, and names the rounds", () => {
		const covered = record({
			"lens.correctness": lens({
				covered: [
					{ ...lens().covered[0]!, head: { "src/a.ts": [[1, 4]] } },
					{ round: "r1", level: "deep", head: { "src/a.ts": [[9, 9]] }, base: {}, units: {} },
				],
			}),
			guardrails: range(),
		});
		expect(covered.gaps()).toEqual([]);
		expect(covered.complete()).toBe(true);
		expect(covered.rounds()).toEqual(["r1", "r2"]);
		expect(covered.summary()).toEqual({ complete: true, rounds: ["r1", "r2"], gaps: [] });
		expect(covered.render()).toBe("Coverage: complete, from r1, r2.\n");
	});

	it("orders rounds by number, so r10 follows r9", () => {
		const covered = record({
			guardrails: range({
				covered: [
					{ ...range().covered[0]!, round: "r10" },
					{ ...range().covered[0]!, round: "r9" },
				],
			}),
		});
		expect(covered.rounds()).toEqual(["r9", "r10"]);
	});

	it("names lines no round delivered, on each side", () => {
		const gaps = record({
			"lens.correctness": lens({
				covered: [
					{
						level: "careful",
						head: { "src/a.ts": [[2, 3]] },
						base: {},
						units: { "bin/run": [...needs.units["bin/run"]] },
					},
				],
			}),
		}).gaps();
		expect(only(gaps)).toEqual([
			{
				check: "lens.correctness",
				file: "src/a.ts",
				revision: undefined,
				lines: [
					[1, 1],
					[4, 4],
					[9, 9],
				],
				reason: "never delivered",
			},
			{
				check: "lens.correctness",
				file: "src/gone.ts",
				revision: "base",
				lines: [[1, 2]],
				reason: "never delivered",
			},
		]);
	});

	it("counts no segment below the required level, and says the level was too low", () => {
		const low = record({
			"lens.correctness": lens({ covered: [{ ...lens().covered[0]!, level: "quick" }] }),
		});
		expect(low.complete()).toBe(false);
		expect(only(low.gaps())[0]).toEqual({
			check: "lens.correctness",
			file: "src/a.ts",
			revision: undefined,
			lines: [
				[1, 4],
				[9, 9],
			],
			reason: "covered below the careful level its paths require",
		});
		const deep = record({
			"lens.correctness": lens({ required: { ...lens().required, "src/a.ts": "deep" } }),
		});
		expect(only(deep.gaps()).map((gap) => gap.file)).toEqual(["src/a.ts"]);
		const atFloor = record({
			"lens.correctness": lens({
				required: { ...lens().required, "src/a.ts": "quick" },
				covered: [{ ...lens().covered[0]!, level: "quick" }],
			}),
		});
		expect(only(atFloor.gaps()).map((gap) => gap.file)).toEqual(["src/gone.ts", "bin/run"]);
	});

	it("takes careful for a path whose required level the record does not hold", () => {
		const quick = record({
			"lens.correctness": lens({ required: {}, covered: [{ ...lens().covered[0]!, level: "quick" }] }),
		});
		expect(quick.complete()).toBe(false);
		expect(record({ "lens.correctness": lens({ required: {} }) }).complete()).toBe(true);
	});

	it("names a lens that ended, failed, or was skipped without leave as the reason, and counts its record for nothing", () => {
		const reason = (status: StoredCheckCoverage["status"], extra: Partial<StoredCheckCoverage> = {}) =>
			record({ "lens.correctness": lens({ status, covered: [], ...extra }) }).gaps()[0]?.reason;
		expect(reason("ended")).toBe("lens ended at its budget in r2");
		expect(reason("failed", { reason: "the route ran out" })).toBe("failed in r2: the route ran out");
		expect(reason("failed")).toBe("failed in r2");
		expect(reason("skipped", { reason: "triage skipped it" })).toBe("skipped without leave in r2: triage skipped it");
		expect(reason("skipped")).toBe("skipped without leave in r2");
		expect(reason("provisional")).toBe("provisional in r2, so its results rest on an earlier head");
		expect(reason("absent")).toBe("did not run in r2");
		expect(reason("ran")).toBe("never delivered");
		expect(reason("skipped", { leave: true })).toBe("never delivered");
		expect(record({ "static.biome": range({ status: "ended", covered: [] }) }).gaps()[0]?.reason).toBe(
			"check ended at its budget in r2",
		);
	});

	it("keeps a skip with leave whole when nothing is needed", () => {
		const skipped = record({
			"lens.correctness": lens({
				status: "skipped",
				leave: true,
				covered: [],
				needs: { head: {}, base: {}, units: {} },
			}),
		});
		expect(skipped.complete()).toBe(true);
	});

	it("says lines the prompt left out are still owed, apart from lines never delivered", () => {
		const gaps = record({
			"lens.correctness": lens({
				covered: [{ ...lens().covered[0]!, head: { "src/a.ts": [[1, 1]] } }],
				omitted: { head: { "src/a.ts": [[2, 3]] }, base: {}, units: {} },
			}),
		}).gaps();
		expect(only(gaps)).toEqual([
			{
				check: "lens.correctness",
				file: "src/a.ts",
				revision: undefined,
				lines: [[2, 3]],
				reason: "too large for the prompt; lines still owed",
			},
			{
				check: "lens.correctness",
				file: "src/a.ts",
				revision: undefined,
				lines: [
					[4, 4],
					[9, 9],
				],
				reason: "never delivered",
			},
		]);
	});

	it("gives a void's reason for the lens and files it names, and no other's", () => {
		const voided = record(
			{
				"lens.correctness": lens({ covered: [] }),
				"lens.tests": lens({ covered: [] }),
			},
			{
				voids: [
					{ reason: "lens.correctness@1 changed version since r1", lens: "correctness" },
					{ reason: "src/a.ts changed since r1", files: ["src/a.ts"] },
				],
			},
		);
		const reasons = voided.gaps().map((gap) => `${gap.check} ${gap.file} ${gap.reason}`);
		expect(reasons).toEqual([
			"lens.correctness src/a.ts lens.correctness@1 changed version since r1",
			"lens.correctness src/gone.ts lens.correctness@1 changed version since r1",
			"lens.correctness bin/run lens.correctness@1 changed version since r1",
			"lens.tests src/a.ts src/a.ts changed since r1",
			"lens.tests src/gone.ts never delivered",
			"lens.tests bin/run never delivered",
		]);
	});

	it("covers no lens in a file an injection attempt sits in", () => {
		const injected = record({
			"lens.correctness": lens({ injected: ["src/a.ts"] }),
			guardrails: range({ injected: ["src/a.ts"] }),
		});
		expect(injected.gaps()).toEqual([
			{
				check: "lens.correctness",
				file: "src/a.ts",
				lines: [
					[1, 4],
					[9, 9],
				],
				reason:
					"a melian/injection-attempt finding sits in the file, so no lens covers it until a round rereads it",
			},
		]);
	});

	it("names a file unit's missing fields, and a unit nothing reached as never delivered", () => {
		const partial = record({
			"lens.correctness": lens({
				covered: [{ ...lens().covered[0]!, units: { "bin/run": ["status", "path", "binary"] } }],
			}),
		}).gaps();
		expect(partial).toEqual([
			{
				check: "lens.correctness",
				file: "bin/run",
				lines: [],
				unit: "mode",
				fields: ["oldMode", "newMode", "oldKind", "newKind"],
				reason: "fields not delivered: oldMode, newMode, oldKind, newKind",
			},
		]);
		const none = record(
			{ "lens.correctness": lens({ covered: [{ ...lens().covered[0]!, units: {} }] }) },
			{ units: {} },
		).gaps();
		expect(none).toEqual([
			{
				check: "lens.correctness",
				file: "bin/run",
				lines: [],
				fields: ["status", "path", "oldMode", "newMode", "oldKind", "newKind", "binary"],
				reason: "never delivered",
			},
		]);
		const below = record({
			"lens.correctness": lens({
				covered: [{ ...lens().covered[0]!, level: "quick", head: { "src/a.ts": [[1, 9]] } }],
				required: { "bin/run": "careful", "src/a.ts": "quick", "src/gone.ts": "quick" },
			}),
		}).gaps();
		expect(below.map((gap) => gap.file)).toEqual(["bin/run"]);
		const ended = record({ "lens.correctness": lens({ status: "ended", covered: [] }) }).gaps();
		expect(ended.at(-1)?.reason).toBe("lens ended at its budget in r2");
	});

	it("covers nothing for a refused record, saying why", () => {
		const refused = record({ guardrails: range() }, { refused: "coverage is not recorded for a fork's head" });
		expect(refused.complete()).toBe(false);
		expect(refused.rounds()).toEqual([]);
		expect(refused.gaps().some((gap) => gap.own === true)).toBe(false);
		expect(record({ guardrails: range({ status: "failed", covered: [] }) }).gaps()[0]?.own).toBe(true);
		expect(new Set(refused.gaps().map((gap) => gap.reason))).toEqual(
			new Set(["coverage is not recorded for a fork's head"]),
		);
	});

	it("counts a record another coverage algorithm wrote for nothing", () => {
		const stale = record({ guardrails: range() }, { producer: { name: "melian.coverage", algorithm: 0 } });
		expect(stale.current()).toBe(false);
		expect(stale.complete()).toBe(false);
		expect(stale.summary()).toEqual({
			complete: false,
			rounds: [],
			gaps: [
				{
					check: "review.coverage",
					file: "",
					lines: [],
					reason: "recorded by coverage algorithm 0, not 1, so it counts for nothing",
				},
			],
		});
		expect(record({ guardrails: range() }, { producer: { name: "other", algorithm: 1 } }).current()).toBe(false);
		expect(stale.render()).toBe(
			"Coverage: incomplete.\n  review.coverage: recorded by coverage algorithm 0, not 1, so it counts for nothing\n",
		);
	});

	it("renders each gap with its check, file, side, lines and reason, with control characters made visible", () => {
		const text = record(
			{
				"lens.correctness": lens({
					covered: [{ round: "r1", level: "careful", head: { "src/a.ts": [[1, 3]] }, base: {}, units: {} }],
					needs: {
						head: {
							"src/a.ts": [
								[1, 4],
								[9, 9],
							],
							"src/\u001b.ts": [[2, 2]],
						},
						base: { "src/gone.ts": [[1, 2]] },
						units: { "bin/run": ["status"] },
					},
				}),
			},
			{ round: "r2" },
		).render();
		expect(text).toBe(
			[
				"Coverage: incomplete, partly from r1.",
				"  lens.correctness  src/\\u001b.ts 1 line at 2: never delivered",
				"  lens.correctness  src/a.ts 2 lines at 4, 9: never delivered",
				"  lens.correctness  src/gone.ts (base) 2 lines at 1-2: never delivered",
				"  lens.correctness  bin/run (mode): never delivered",
				"",
			].join("\n"),
		);
	});

	it("keeps its stored record apart from the one it was built from", () => {
		const stored = record({ guardrails: range() }).stored;
		const copy = CoverageRecord.from(stored);
		stored.checks.guardrails!.covered = [];
		expect(copy.complete()).toBe(true);
	});
});

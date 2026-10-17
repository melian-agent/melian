import {
	Adjudication,
	defaultConfig,
	Finding,
	type FindingInput,
	type Resolution,
	type Severity,
	type Verification,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const order: Resolution[] = ["silent", "advisory", "acknowledge", "block"];
const rank = (r: Resolution) => order.indexOf(r);
const lesser = (a: Resolution, b: Resolution) => (rank(a) < rank(b) ? a : b);

const base: FindingInput = {
	rule: "fail-open",
	message: "m",
	file: "src/a.ts",
	startLine: 1,
	snippet: "x()",
	occurrence: 0,
	cause: "introduced",
	severity: "P2",
	source: { check: "lens.trust-boundary", version: "1@careful" },
	failureScenario: "f",
	evidence: [{ file: "src/a.ts", startLine: 1, role: "cause", revision: "head", snippet: "x()" }],
	explanation: { what: "w", whyHere: "y", whatToDo: "z" },
};
const judge = (verdict: Verification["verdict"], lowered?: Verification["lowered"]): Verification => ({
	verdict,
	reason: "r",
	executor: "llm",
	model: "faux/judge",
	version: "1",
	evidence: base.evidence,
	...(lowered === undefined ? {} : { lowered }),
});
const next: Record<Severity, Severity | undefined> = {
	P0: undefined,
	P1: "P2",
	P2: "P3",
	P3: undefined,
	nit: undefined,
};

const tables: [string, object][] = [
	["default", {}],
	["P2 advisory", { P2: "advisory" }],
	["P1 advisory", { P1: "advisory" }],
	["P3 silent", { P3: "silent" }],
	["P2 silent", { P2: "silent" }],
	["P1 silent", { P1: "silent" }],
	["P3 block", { P3: "block" }],
	["P1 P2 silent", { P1: "silent", P2: "silent" }],
];
const ceilings: (Resolution | undefined)[] = [undefined, "silent", "advisory", "acknowledge"];
const protectedKinds: [string, Partial<FindingInput>][] = [
	["trust", {}],
	["tests vacuous", { rule: "vacuous-test", source: { check: "lens.tests", version: "1" } }],
	["untested (correctness)", { rule: "untested-behaviour", source: { check: "lens.correctness", version: "1" } }],
];
const causes = ["introduced", "pre-existing", "affected", "unproven"] as const;
const unprovenEvidence = [
	base.evidence![0]!,
	{ ...base.evidence![0]!, role: "context" as const, proves: true as const },
];
const causeOf = (c: (typeof causes)[number]) => (c === "unproven" ? "affected" : c);
const evidenceOf = (c: (typeof causes)[number]) => (c === "unproven" ? { evidence: unprovenEvidence } : {});

describe("step 29: confirmed outcomes bound protected judgements", () => {
	it("reuses confirmed resolution and count behaviour across the review grid", () => {
		let cases = 0;
		const failures: string[] = [];
		for (const [kind, over] of protectedKinds)
			for (const [tname, table] of tables)
				for (const ceiling of ceilings)
					for (const cause of causes)
						for (const severity of ["P0", "P1", "P2", "P3"] as const) {
							const check = (over.source ?? base.source).check;
							const config = {
								...defaultConfig,
								resolution: {
									...defaultConfig.resolution,
									...table,
									...(ceiling === undefined ? {} : { checks: { [check]: { ceiling } } }),
								},
							};
							const raw = Finding.create({
								...base,
								...over,
								cause: causeOf(cause),
								severity,
								...evidenceOf(cause),
							});
							const confirmed = raw.verifiedAs(judge("confirmed"));
							const variants: [string, Finding][] = [["refuted", raw.verifiedAs(judge("refuted"))]];
							const to = next[severity];
							if (to !== undefined)
								variants.push([
									"lowered",
									raw.verifiedAs(judge("plausible", { from: severity, to, reason: "Narrow." })),
								]);
							for (const [label, judged] of variants) {
								cases++;
								const ordinary = confirmed.decision(config);
								const expected = lesser("acknowledge", ordinary.resolution);
								const minimum = judged.trustFloor(config)[0]!;
								const verdict = new Adjudication({
									findings: [judged],
									config,
									manifest: [],
									checks: [],
								}).adjudicate();
								const result = verdict.all()[0]!;
								const resolution = result.properties.resolution!;
								const id = `${kind}|${tname}|${ceiling}|${cause}|${severity}|${label}`;
								if (minimum.minimum !== expected || Boolean(minimum.lifted) !== confirmed.lifted(config))
									failures.push(`${id}: minimum differs from confirmed outcome`);
								if (rank(resolution) < rank(expected)) failures.push(`${id}: escaped minimum`);
								if (label === "refuted" && resolution !== expected)
									failures.push(`${id}: refutation differs from capped confirmed resolution`);
								if (
									resolution === expected &&
									expected !== "silent" &&
									verdict.counted().length !== (confirmed.lifted(config) ? 0 : 1)
								)
									failures.push(`${id}: count differs from confirmed outcome`);
							}
						}
		expect(cases).toBe(2304);
		expect(failures).toEqual([]);
	});
	it("reuses the confirmed claim at the merged cause in both report orders", () => {
		let cases = 0;
		const failures: string[] = [];
		for (const [tname, table] of tables)
			for (const ceiling of ceilings)
				for (const tcause of causes)
					for (const ocause of causes)
						for (const tsev of ["P0", "P1", "P2", "P3"] as const)
							for (const osev of ["P1", "P3"] as const) {
								const config = {
									...defaultConfig,
									ruleAliases: { "unhandled-error": ["fail-open"] },
									resolution: {
										...defaultConfig.resolution,
										...table,
										...(ceiling === undefined ? {} : { checks: { "lens.trust-boundary": { ceiling } } }),
									},
								};
								const trust = Finding.create({
									...base,
									cause: causeOf(tcause),
									severity: tsev,
									...evidenceOf(tcause),
								});
								const other = Finding.create({
									...base,
									rule: "unhandled-error",
									source: { check: "lens.correctness", version: "1" },
									cause: causeOf(ocause),
									severity: osev,
									...evidenceOf(ocause),
								}).verifiedAs(judge("confirmed"));
								const variants: [string, Finding][] = [["refuted", trust.verifiedAs(judge("refuted"))]];
								const to = next[tsev];
								if (to !== undefined)
									variants.push([
										"lowered",
										trust.verifiedAs(judge("plausible", { from: tsev, to, reason: "Narrow." })),
									]);
								for (const [label, judged] of variants) {
									cases++;
									for (const reports of [
										[judged, other],
										[other, judged],
									]) {
										const adjudication = new Adjudication({
											findings: reports,
											config,
											manifest: [],
											checks: [],
										});
										const defect = adjudication.defects()[0]!;
										const confirmed = Finding.from({
											...trust.toJSON(),
											properties: {
												...trust.properties,
												cause: defect.speaker.properties.cause,
												evidence: defect.speaker.properties.evidence,
											},
										}).verifiedAs(judge("confirmed"));
										const ordinary = confirmed.decision(config);
										const minimum = judged.trustFloor(config, defect.speaker)[0]!;
										const id = `${tname}|${ceiling}|${tcause}/${tsev}|${ocause}/${osev}|${label}`;
										if (
											minimum.minimum !== lesser("acknowledge", ordinary.resolution) ||
											Boolean(minimum.lifted) !== confirmed.lifted(config)
										)
											failures.push(`${id}: minimum differs from confirmed outcome`);
										const baseline = new Adjudication({
											findings: [trust.verifiedAs(judge("confirmed")), other],
											config,
											manifest: [],
											checks: [],
										}).adjudicate();
										const got = adjudication.adjudicate();
										if (
											baseline.status === "passed" &&
											(got.status !== "passed" ||
												got.counted().length !== baseline.counted().length ||
												got.reviewStatus().state !== baseline.reviewStatus().state) &&
											confirmed.lifted(config)
										)
											failures.push(`${id}: display-only claim now counts`);
									}
								}
							}
		expect(cases).toBe(6144);
		expect(failures).toEqual([]);
	});
});

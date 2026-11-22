import {
	Finding,
	type RecordEnvelope,
	RecordError,
	type RecordJson,
	reviewPayloads,
	SharedRecord,
	withheld,
} from "@melian-agent/core";
import { recordKey } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";

const head = "b".repeat(40);
const revision = `${"a".repeat(40)}..${head}`;
const dismissed = "0123456789abcdef";
const dismissalRecord = "c".repeat(64);
const lensVersion = "0123456789ab";
const verifierVersion = "0123456789abcdef";
const blindCallers = "callers were unavailable for every changed site, so no lens saw who calls the changed code";
const hash = (digit: string) => digit.repeat(64);
const snapshotId = `sha256:${hash("e")}`;

function finding(check: string, version: string | undefined): RecordJson {
	return Finding.create({
		rule: "unsafe",
		message: "Unsafe input",
		file: "src/run.ts",
		startLine: 7,
		snippet: "run(input)",
		occurrence: 0,
		severity: "P1",
		cause: "introduced",
		source: { check, version },
		explanation: { what: "Unsafe input", whyHere: "New input", whatToDo: "Validate it" },
	}).toJSON() as unknown as RecordJson;
}

const snapshot = {
	commit: head,
	snapshotId,
	receipt: JSON.stringify({ format_version: 1, snapshot_id: snapshotId, enola_version: "0.4.0" }),
	cacheKey: hash("f"),
	coverage: { graph: hash("1"), review: hash("2"), test: hash("3") },
};
const budgetEnded = { budget: "tokens", limit: 10, tokens: 11, tools: 2 };
const verification = {
	verdict: "confirmed",
	reason: "It is reachable",
	matches: { [dismissed]: "same" },
	executor: "llm",
	model: "anthropic/opus",
	version: verifierVersion,
};
// A lineage as version 1 wrote it, and as version 2 writes it, naming the level its model answered at.
const legacyLineage = {
	model: "openai/terra",
	thinking: { level: "low", wanted: "high", by: "melian.local.yaml" },
	wanted: "anthropic/opus",
	by: "melian.local.yaml",
	moved: { by: "lenses.security.route", from: "careful", to: "own route" },
	outside: true,
};
const lineage = { ...legacyLineage, answeredAt: "medium" };
// A check as the review decided it, with every field present.
const decided = (name: string, version: string, level: string | null, line: RecordJson = lineage) => ({
	name,
	status: "ended",
	reason: withheld,
	error: "timeout",
	version,
	level,
	budgetEnded,
	caveats: [blindCallers],
	coverage: { graph: hash("4"), review: hash("5"), test: hash("6") },
	lineage: line,
});
const lens = (
	outcome: RecordJson,
	check: RecordJson | null = decided("lens.security", lensVersion, "careful"),
	v = 2,
) => ({
	v,
	name: "security",
	version: lensVersion,
	level: "careful",
	probe: false,
	outcome,
	sightings: [finding("lens.security", `${lensVersion}@careful`)],
	delivery: null,
	check,
});

// Every shape each kind's payload can take, each with every field present, so removing any one is a refusal.
const samples: [string, RecordJson][] = [
	[
		"check",
		{
			v: 1,
			result: {
				name: "static.biome",
				status: "ran",
				version: "2.0.0",
				findings: 1,
				notes: [],
				snapshots: [snapshot],
			},
			sightings: [finding("static.biome", "2.0.0")],
		},
	],
	[
		"check",
		{
			v: 1,
			result: {
				name: "static.mutation",
				status: "provisional",
				version: "1.0.0",
				findings: 0,
				notes: [],
				reason: withheld,
			},
			sightings: [],
		},
	],
	[
		"check",
		{
			v: 1,
			result: { name: "static.mutation", status: "skipped", reason: withheld, cause: "headNotAllowed" },
			sightings: [],
		},
	],
	[
		"check",
		{ v: 1, result: { name: "static.tsc", status: "failed", reason: "toolFailed", error: withheld }, sightings: [] },
	],
	[
		"lens",
		lens({
			status: "done",
			model: "anthropic/opus",
			budgetEnded,
			capped: 3,
			escalation: {
				trigger: { kind: "severity", severity: "P1" },
				to: "deep",
				carried: [dismissed],
				kept: [dismissed],
				refuted: [dismissed],
			},
			usage: { models: ["anthropic/opus"], tokens: 100, costMicros: 2_500_000 },
		}),
	],
	["lens", lens({ status: "unanswered", reason: withheld }, null)],
	[
		"lens",
		lens(
			{ status: "unanswered", reason: withheld },
			decided("lens.security", lensVersion, "careful", legacyLineage),
			1,
		),
	],
	[
		"lens",
		lens(
			{ status: "exhausted", tried: ["anthropic/opus"], reason: "aborted" },
			{
				name: "lens.security",
				status: "failed",
				reason: "failed",
				error: null,
				version: lensVersion,
				level: "careful",
				budgetEnded: null,
				caveats: null,
				coverage: null,
				lineage: null,
			},
		),
	],
	[
		"verification",
		{
			v: 2,
			claims: [
				{ id: dismissed, source: { check: "lens.security", version: `${lensVersion}@careful` }, verification },
			],
			dismissals: [{ finding: dismissed, record: dismissalRecord }],
			outcomes: [
				{ candidate: "1111111111111111", outcome: { status: "done", model: "anthropic/opus" } },
				{ candidate: "2222222222222222", outcome: { status: "ended", budgetEnded } },
				{ candidate: "3333333333333333", outcome: { status: "unanswered", reason: withheld } },
			],
			check: decided("verifier", verifierVersion, null),
		},
	],
	[
		"verification",
		{
			v: 1,
			claims: [
				{ id: dismissed, source: { check: "lens.security", version: `${lensVersion}@careful` }, verification },
			],
			dismissals: [{ finding: dismissed, record: dismissalRecord }],
			outcomes: [
				{ candidate: "1111111111111111", outcome: { status: "done", model: "anthropic/opus" } },
				{ candidate: "2222222222222222", outcome: { status: "ended", budgetEnded } },
				{ candidate: "3333333333333333", outcome: { status: "unanswered", reason: withheld } },
			],
			check: decided("verifier", verifierVersion, null, legacyLineage),
		},
	],
	[
		"walkthrough",
		{
			v: 1,
			route: "anthropic/opus@high",
			summary: "It adds a check",
			files: [{ path: "src/run.ts", summary: "The check" }],
			diagram: "graph TD; a-->b",
			note: "One note",
		},
	],
	[
		"triage",
		{
			v: 1,
			decision: {
				questionSet: { name: "triage", version: "1" },
				decider: "fake",
				calibrated: true,
				model: "anthropic/opus",
				answers: [{ question: "security", distribution: { careful: 750_000, deep: 250_000 }, chosen: "careful" }],
			},
			failure: withheld,
			inputCut: false,
		},
	],
	[
		"telemetry",
		{
			v: 1,
			durationMs: 1000,
			stages: [
				{
					name: "lens.security",
					level: "careful",
					models: ["anthropic/opus"],
					durationMs: 900,
					tokens: 100,
					cacheRead: 50,
					costMicros: 1_200_000,
					outcome: "completed",
					tools: 4,
					limits: { tokens: 1000, tools: 10 },
					ended: "tools",
					usageIncomplete: false,
				},
			],
		},
	],
	[
		"dismissal",
		{
			v: 1,
			by: "maintainer",
			reason: "Not a defect",
			at: "2026-11-15T00:00:00.000Z",
			severity: "P1",
			sighting: { revision, finding: finding("lens.security", `${lensVersion}@careful`) },
			head,
			rounds: [dismissalRecord],
			frontier: ["1".repeat(64), dismissalRecord],
			trigger: { hash: hash("7"), proof: [{ file: "src/run.ts", hash: hash("8") }] },
		},
	],
];

const account = {
	v: 2,
	checks: ["guardrails", "lens.security"],
	records: ["1".repeat(64), "2".repeat(64)],
	filled: [
		{
			name: "decisions.triage",
			status: "skipped",
			reason: "no record",
			error: null,
			version: null,
			level: null,
			budgetEnded: null,
			caveats: null,
			coverage: null,
			lineage: null,
		},
		{ ...decided("lens.design", lensVersion, "careful", legacyLineage), status: "failed" },
		{ ...decided("lens.design", lensVersion, "careful", legacyLineage), status: "failed", reason: "unexpected" },
	],
	allowSkip: ["decisions.triage", "lens.design"],
	producers: [
		{ check: "guardrails", version: null, ids: null },
		{ check: "lens.security", version: `${lensVersion}@careful`, ids: null },
		{ check: "lens.security", version: `${lensVersion}@quick`, ids: [dismissed, "1123456789abcdef"] },
	],
	resolutionPolicy: "2:0123456789abcdef",
};
samples.push(["account", account]);

// Checked by their own authority, so the walk removes them whole and does not go inside.
const opaque = new Set(["sightings", "sighting/finding", "claims/0/verification", "decision/answers/0/distribution"]);

function fields(value: RecordJson, at: readonly string[] = []): string[][] {
	if (value === null || typeof value !== "object") return [];
	if (Array.isArray(value)) return value.length === 0 ? [] : fields(value[0] as RecordJson, [...at, "0"]);
	return Object.entries(value).flatMap(([key, each]) => {
		const path = [...at, key];
		return [path, ...(opaque.has(path.join("/")) ? [] : fields(each, path))];
	});
}

function without(value: RecordJson, path: readonly string[]): RecordJson {
	const copy = structuredClone(value) as Record<string, RecordJson>;
	let parent = copy as RecordJson;
	for (const key of path.slice(0, -1)) parent = (parent as Record<string, RecordJson>)[key] as RecordJson;
	delete (parent as Record<string, RecordJson>)[path.at(-1) as string];
	return copy;
}

function at(value: RecordJson, path: readonly string[], replacement: RecordJson): RecordJson {
	const copy = structuredClone(value) as Record<string, RecordJson>;
	let parent = copy as RecordJson;
	for (const key of path.slice(0, -1)) parent = (parent as Record<string, RecordJson>)[key] as RecordJson;
	(parent as Record<string, RecordJson>)[path.at(-1) as string] = replacement;
	return copy;
}

// One value past each bound a field's schema sets, in the first sample of its kind.
const bounds: readonly [string, string, RecordJson][] = [
	["check", "result/name", ""],
	["check", "result/findings", -1],
	["lens", "level", "loud"],
	["lens", "outcome/escalation/carried/0", "0123456789abcdeg"],
	["lens", "check/lineage/answeredAt", "loud"],
	["lens", "check/lineage/answeredAt", ""],
	["verification", "check/lineage/answeredAt", "loud"],
	["dismissal", "rounds/0", "c".repeat(63)],
	["dismissal", "frontier/0", "1".repeat(63)],
	["dismissal", "sighting/revision", `${"a".repeat(40)}.${head}`],
	["dismissal", "head", "x"],
	["account", "records/0", "1".repeat(63)],
	["account", "filled/0/status", "ran"],
	["account", "producers/2/ids/0", "x"],
	["account", "resolutionPolicy", "2:0123456789abcdeg"],
];

// Each other value an enumerated field takes, so every one the schema lists is accepted.
const variants: readonly [string, string, RecordJson][] = [
	["lens", "outcome/budgetEnded/budget", "tools"],
	...["off", "minimal", "low", "high", "xhigh", "max", null].map(
		(level) => ["lens", "check/lineage/answeredAt", level] as [string, string, RecordJson],
	),
	["lens", "outcome/escalation/trigger", { kind: "budget", budget: "tokens" }],
	["lens", "outcome/escalation/trigger", { kind: "budget", budget: "tools" }],
	["verification", "outcomes/2/outcome", { status: "exhausted", reason: withheld }],
	["telemetry", "stages/0/ended", "tokens"],
	["telemetry", "stages/0/ended", null],
	["account", "filled/1/status", "skipped"],
	["account", "filled/0/reason", null],
	["account", "resolutionPolicy", null],
];

const check = (kind: string, payload: RecordJson) => reviewPayloads[kind]?.(payload);

describe("review payload checks", () => {
	it.each(samples)("accepts a whole %s payload, sample %#", (kind, payload) => {
		expect(check(kind, payload)).toBeUndefined();
	});

	it("has a check for every kind a review writes, and a dismissal", () => {
		expect(Object.keys(reviewPayloads).sort()).toEqual(
			["account", "check", "dismissal", "lens", "telemetry", "triage", "verification", "walkthrough"].sort(),
		);
	});

	it.each(
		samples.flatMap(([kind, payload]) =>
			fields(payload)
				// A dismissal an earlier build wrote names no frontier; the test below accepts one.
				.filter((path) => kind !== "dismissal" || path.join("/") !== "frontier")
				.map((path) => [kind, path.join("/"), payload, path] as const),
		),
	)("refuses a %s payload without %s, case %#", (kind, _name, payload, path) => {
		expect(check(kind, without(payload, path))).toMatch(/schema/);
	});

	it.each(samples)("refuses a %s payload with a field more, sample %#", (kind, payload) => {
		expect(check(kind, { ...(payload as Record<string, RecordJson>), extra: 1 })).toMatch(/schema/);
	});

	it.each(samples)("refuses a %s payload of another version, sample %#", (kind, payload) => {
		const known = kind === "lens" || kind === "verification" || kind === "account" ? 2 : 1;
		for (const v of [0, known + 1])
			expect(check(kind, { ...(payload as Record<string, RecordJson>), v })).toMatch(/schema/);
	});

	it.each(["lens", "verification"])("refuses a %s payload that is not an object", (kind) => {
		for (const payload of [null, [], "v", 1]) expect(check(kind, payload)).toMatch(/schema/);
	});

	it.each(["lens", "verification"])("reads a %s lineage's answeredAt only in version 2", (kind) => {
		const [, payload] = samples.find(([each]) => each === kind) as [string, Record<string, RecordJson>];
		const at = (v: number, line: RecordJson) =>
			check(kind, { ...payload, v, check: { ...(payload.check as object), lineage: line } });
		expect(at(2, lineage)).toBeUndefined();
		expect(at(2, { ...legacyLineage, answeredAt: null })).toBeUndefined();
		expect(at(2, legacyLineage)).toMatch(/schema/);
		expect(at(1, legacyLineage)).toBeUndefined();
		expect(at(1, lineage)).toMatch(/schema/);
		expect(at(1, { ...legacyLineage, answeredAt: null })).toMatch(/schema/);
	});

	it.each(bounds)("refuses a %s payload whose %s is %j", (kind, path, value) => {
		const [, payload] = samples.find(([each]) => each === kind) as [string, RecordJson];
		expect(check(kind, at(payload, path.split("/"), value))).toMatch(/schema/);
	});

	it.each(variants)("accepts a %s payload whose %s is %j", (kind, path, value) => {
		const [, payload] = samples.find(([each]) => each === kind) as [string, RecordJson];
		expect(check(kind, at(payload, path.split("/"), value))).toBeUndefined();
	});

	it.each([null, "noProductionLines", "headNotAllowed", "timeout", "unmutated"])(
		"accepts a skipped check whose cause is %j",
		(cause) => {
			const result = { name: "static.mutation", status: "skipped", reason: withheld, cause };
			expect(check("check", { v: 1, result, sightings: [] })).toBeUndefined();
		},
	);

	it("refuses a skipped check whose cause is none of those", () => {
		const result = { name: "static.mutation", status: "skipped", reason: withheld, cause: "bored" };
		expect(check("check", { v: 1, result, sightings: [] })).toMatch(/schema/);
	});

	it("refuses a float, since a record holds integers", () => {
		const [, telemetry] = samples.find(([kind]) => kind === "telemetry") as [string, RecordJson];
		const stages = (telemetry as { stages: Record<string, RecordJson>[] }).stages;
		expect(check("telemetry", { ...(telemetry as object), stages: [{ ...stages[0], costMicros: 1.5 }] })).toMatch(
			/schema/,
		);
	});

	it("refuses a check record whose sighting another check reported", () => {
		const payload = samples[0]?.[1] as Record<string, RecordJson>;
		expect(check("check", { ...payload, sightings: [finding("static.tsc", "2.0.0")] })).toBe(
			"holds a sighting at /sightings/0 from another producer than the record's",
		);
		expect(check("check", { ...payload, sightings: [finding("static.biome", "1.0.0")] })).toMatch(
			/than the record's$/,
		);
	});

	it("names a sighting with no version against a check with one", () => {
		const payload = samples[0]?.[1] as Record<string, RecordJson>;
		expect(check("check", { ...payload, sightings: [finding("static.biome", undefined)] })).toBe(
			"holds a sighting at /sightings/0 from another producer than the record's",
		);
	});

	it("names where a payload breaks its schema", () => {
		const payload = samples[0]?.[1] as { result: Record<string, RecordJson> };
		expect(check("check", { ...payload, result: { ...payload.result, findings: "one" } })).toMatch(
			/^does not match its schema at \/result\/findings: /,
		);
		expect(check("walkthrough", {})).toMatch(/^does not match its schema at \(top level\): /);
	});

	it("lets a fault inside the finding authority through, rather than call it a refusal", () => {
		const payload = samples[0]?.[1] as Record<string, RecordJson>;
		const faulty = {
			get ruleId(): string {
				throw new Error("the authority broke");
			},
		};
		expect(() => check("check", { ...payload, sightings: [faulty as unknown as RecordJson] })).toThrow(
			"the authority broke",
		);
	});

	it("matches a check with no version to a sighting with none", () => {
		const payload = samples[0]?.[1] as { result: Record<string, RecordJson> };
		const unversioned = {
			v: 1,
			result: { ...payload.result, version: null },
			sightings: [finding("static.biome", undefined)],
		};
		expect(check("check", unversioned)).toBeUndefined();
		expect(check("check", { ...unversioned, sightings: [finding("static.biome", "2.0.0")] })).toBe(
			"holds a sighting at /sightings/0 from another producer than the record's",
		);
	});

	it.each([
		["skipped", "holds sightings for a check that was skipped"],
		["failed", "holds sightings for a check that failed"],
	])("refuses a check that %s and still holds sightings", (status, refusal) => {
		const [, payload] = samples.find(
			([kind, each]) => kind === "check" && (each as { result: { status: string } }).result.status === status,
		) as [string, Record<string, RecordJson>];
		const name = (payload.result as { name: string }).name;
		expect(check("check", { ...payload, sightings: [finding(name, undefined)] })).toBe(refusal);
	});

	it("accepts a ran or provisional check holding no sightings", () => {
		const payload = samples[0]?.[1] as Record<string, RecordJson>;
		expect(check("check", { ...payload, sightings: [] })).toBeUndefined();
	});

	it("refuses a receipt whose Enola version is not in semver's own form of at most 64 characters", () => {
		const payload = samples[0]?.[1] as { v: 1; result: Record<string, RecordJson>; sightings: RecordJson };
		const receipt = (enola_version: string) =>
			check("check", {
				...payload,
				result: {
					...payload.result,
					snapshots: [
						{
							...snapshot,
							receipt: JSON.stringify({ format_version: 1, snapshot_id: snapshotId, enola_version }),
						},
					],
				},
			});
		const refusal = "names a version at /result/snapshots/0/receipt that is not one Melian writes";
		expect(receipt("0")).toBe(refusal);
		expect(receipt("01.2.3")).toBe(refusal);
		expect(receipt("0.4.40")).toBeUndefined();
		expect(receipt(`0.0.1-${"a".repeat(58)}`)).toBeUndefined();
		expect(receipt(`0.0.1-${"a".repeat(59)}`)).toMatch(
			/^does not match its schema at \/result\/snapshots\/0\/receipt/,
		);
	});

	it("refuses a verification outcome whose candidate is not a finding ID", () => {
		const payload = samples.find(([kind]) => kind === "verification")?.[1] as { outcomes: RecordJson[] };
		const outcome = { outcome: { status: "done", model: "anthropic/opus" } };
		const holding = (candidate: string) =>
			check("verification", { ...payload, outcomes: [{ candidate, ...outcome }] } as RecordJson);
		expect(holding("8f3f919a7c886b44")).toBeUndefined();
		expect(holding("anthropic/claude")).toMatch(/^does not match its schema at \/outcomes\/0\/candidate/);
		expect(holding("a".repeat(64))).toMatch(/^does not match its schema at \/outcomes\/0\/candidate/);
	});

	it("refuses a sighting that is not a finding", () => {
		const payload = samples[0]?.[1] as Record<string, RecordJson>;
		expect(check("check", { ...payload, sightings: [{ ruleId: "unsafe" }] })).toMatch(
			/^holds a sighting at \/sightings\/0 that is not a finding/,
		);
	});

	it("refuses a lens record whose sighting is another lens's, or another level's", () => {
		const payload = samples.find(([kind]) => kind === "lens")?.[1] as Record<string, RecordJson>;
		const refusal = "holds a sighting at /sightings/0 from another producer than the record's";
		expect(check("lens", { ...payload, sightings: [finding("lens.tests", `${lensVersion}@careful`)] })).toBe(refusal);
		expect(check("lens", { ...payload, sightings: [finding("lens.security", `${lensVersion}@quick`)] })).toBe(
			refusal,
		);
		expect(check("lens", { ...payload, sightings: [finding("lens.security", "0123456789ac@careful")] })).toBe(
			refusal,
		);
	});

	it("refuses a lens record that holds another lens's check, or one at another version or level", () => {
		const payload = samples.find(([kind]) => kind === "lens")?.[1] as Record<string, RecordJson>;
		const holding = (name: string, version: string | null, level: string | null) =>
			check("lens", { ...payload, check: decided(name, version as string, level) });
		const refusal = "holds the check of another lens, version or level than its own";
		expect(holding("lens.security", lensVersion, "careful")).toBeUndefined();
		expect(holding("lens.tests", lensVersion, "careful")).toBe(refusal);
		expect(holding("lens.security", "0123456789ac", "careful")).toBe(refusal);
		expect(holding("lens.security", null, "careful")).toBe(refusal);
		expect(holding("lens.security", lensVersion, "deep")).toBe(refusal);
		expect(holding("lens.security", lensVersion, null)).toBe(refusal);
		expect(check("lens", { ...payload, check: null })).toBeUndefined();
	});

	it("refuses a verification that holds a check other than the verifier's", () => {
		const payload = samples.find(([kind]) => kind === "verification")?.[1] as Record<string, RecordJson>;
		expect(check("verification", { ...payload, check: decided("lens.security", lensVersion, null) })).toBe(
			"holds the check of another check than the verifier",
		);
		expect(check("verification", { ...payload, check: null })).toBeUndefined();
	});

	// A version 1 lens task resumes with no level, so a source names the bare lens version or that version at a level.
	it("takes a lens source's version bare or at a level, and refuses any other", () => {
		const payload = samples.find(([kind]) => kind === "account")?.[1] as Record<string, RecordJson>;
		const naming = (version: string) =>
			check("account", { ...payload, producers: [{ check: "lens.security", version, ids: null }] });
		const refusal = "names a version at /producers/0/version that is not one Melian writes";
		expect(naming(lensVersion)).toBeUndefined();
		expect(naming(`${lensVersion}@careful`)).toBeUndefined();
		expect(naming(`${lensVersion}@loud`)).toBe(refusal);
		expect(naming(`${lensVersion}@careful@careful`)).toBe(refusal);
		expect(naming(`${lensVersion}@`)).toBe(refusal);
		expect(naming("0123456789a")).toBe(refusal);
		expect(naming("0123456789a@careful")).toBe(refusal);
	});

	it("refuses a verification that matches a claim against a dismissal it does not name", () => {
		const payload = samples.find(([kind]) => kind === "verification")?.[1] as Record<string, RecordJson>;
		expect(check("verification", { ...payload, dismissals: [] })).toBe(
			`matches claim 0 against ${dismissed}, which names no dismissal record`,
		);
	});

	it("refuses a verification that names one dismissed finding twice", () => {
		const payload = samples.find(([kind]) => kind === "verification")?.[1] as Record<string, RecordJson>;
		const twice = [
			{ finding: dismissed, record: dismissalRecord },
			{ finding: dismissed, record: "d".repeat(64) },
		];
		expect(check("verification", { ...payload, dismissals: twice })).toBe("names one dismissed finding twice");
	});

	it("accepts a verification whose claim matches nothing", () => {
		const payload = samples.find(([kind]) => kind === "verification")?.[1] as {
			claims: { verification: Record<string, RecordJson> }[];
		};
		const { matches: _, ...unmatched } = payload.claims[0]?.verification ?? {};
		const claims = [{ ...payload.claims[0], verification: unmatched }];
		expect(check("verification", { ...(payload as object), claims, dismissals: [] })).toBeUndefined();
	});

	it("refuses a dismissal made at a head other than its sighting's", () => {
		const payload = samples.find(([kind]) => kind === "dismissal")?.[1] as Record<string, RecordJson>;
		expect(check("dismissal", { ...payload, head: "c".repeat(40) })).toBe(
			"names a head that is not its sighting's revision's",
		);
	});

	it("accepts a dismissal an earlier build wrote, which names no frontier", () => {
		const sample = samples.find(([kind]) => kind === "dismissal")?.[1] as Record<string, RecordJson>;
		const { frontier: _, ...payload } = sample;
		expect(check("dismissal", payload)).toBeUndefined();
	});

	it.each([
		["out of order", [dismissalRecord, "1".repeat(64)]],
		["twice", [dismissalRecord, dismissalRecord]],
	])("refuses a dismissal that lists its frontier %s", (_, frontier) => {
		const payload = samples.find(([kind]) => kind === "dismissal")?.[1] as Record<string, RecordJson>;
		expect(check("dismissal", { ...payload, frontier })).toBe("lists its frontier out of order, or one twice");
	});

	it("refuses a dismissal whose sighting is not a finding", () => {
		const payload = samples.find(([kind]) => kind === "dismissal")?.[1] as Record<string, RecordJson>;
		expect(check("dismissal", { ...payload, sighting: { revision, finding: { ruleId: "unsafe" } } })).toMatch(
			/^holds a sighting at \/sighting\/finding that is not a finding/,
		);
	});

	it.each([
		["names one check twice", { checks: ["guardrails", "guardrails"] }],
		["lists its records out of ID order, or one twice", { records: ["2".repeat(64), "1".repeat(64)] }],
		["lists its records out of ID order, or one twice", { records: ["1".repeat(64), "1".repeat(64)] }],
		["fills its checks out of order, or one twice", { filled: [account.filled[1], account.filled[0]] }],
		["fills its checks out of order, or one twice", { filled: [account.filled[2], account.filled[1]] }],
		["fills its checks out of order, or one twice", { filled: [account.filled[0], account.filled[0]] }],
		["lists the skips it allows out of order, or one twice", { allowSkip: ["lens.design", "decisions.triage"] }],
		["lists the skips it allows out of order, or one twice", { allowSkip: ["lens.design", "lens.design"] }],
		["lists its producers out of order, or one twice", { producers: [account.producers[1], account.producers[0]] }],
		["lists its producers out of order, or one twice", { producers: [account.producers[2], account.producers[1]] }],
		["lists its producers out of order, or one twice", { producers: [account.producers[0], account.producers[0]] }],
		[
			"keeps the findings at /producers/0/ids out of order, or one twice",
			{
				producers: [
					{ check: "lens.security", version: `${lensVersion}@quick`, ids: ["1123456789abcdef", dismissed] },
				],
			},
		],
		[
			"keeps the findings at /producers/0/ids out of order, or one twice",
			{ producers: [{ check: "lens.security", version: `${lensVersion}@quick`, ids: [dismissed, dismissed] }] },
		],
	])("refuses an account that %s, case %#", (reason, fields) => {
		expect(check("account", { ...account, ...fields } as RecordJson)).toBe(reason);
	});

	it("takes a version-1 account, which names no resolution policy, and checks its order as version 2's", () => {
		const { resolutionPolicy: _, ...fields } = account;
		const legacy = { ...fields, v: 1 };
		expect(check("account", legacy)).toBeUndefined();
		expect(check("account", { ...legacy, resolutionPolicy: account.resolutionPolicy })).toMatch(/schema/);
		expect(check("account", { ...fields, v: 2 })).toMatch(/schema/);
		expect(check("account", { ...legacy, checks: ["guardrails", "guardrails"] })).toBe("names one check twice");
	});

	it.each([null, "account", 2, [account]])("refuses an account payload of %j as a breach of its schema", (payload) => {
		expect(check("account", payload as RecordJson)).toMatch(/schema/);
	});

	it("takes an account whose producers share a check and differ in version, the one with none first", () => {
		const producers = [
			{ check: "static.biome", version: null, ids: null },
			{ check: "static.biome", version: "2.0.0", ids: null },
		];
		expect(check("account", { ...account, producers })).toBeUndefined();
		expect(check("account", { ...account, producers: [producers[1], producers[0]] } as RecordJson)).toBe(
			"lists its producers out of order, or one twice",
		);
	});

	it("orders producers by check before version, though a later check's version text sorts first", () => {
		// "lens.a-b" sorts after "lens.a", but "lens.a-b@" sorts before "lens.a@", since "-" sorts before "@".
		const producers = [
			{ check: "lens.a", version: null, ids: null },
			{ check: "lens.a-b", version: null, ids: null },
		];
		expect(check("account", { ...account, producers })).toBeUndefined();
		expect(check("account", { ...account, producers: [producers[1], producers[0]] } as RecordJson)).toBe(
			"lists its producers out of order, or one twice",
		);
	});

	it("names the kind when a record's payload is refused", () => {
		const envelope: RecordEnvelope = {
			v: 1,
			changeset: "pull-0123456789abcdef",
			kind: "walkthrough",
			key: recordKey("w"),
			revision,
			payload: { v: 1 },
		};
		let error: unknown;
		try {
			SharedRecord.parse(envelope, reviewPayloads);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(RecordError);
		expect((error as Error).message).toMatch(/a walkthrough record's payload does not match its schema/);
	});
});

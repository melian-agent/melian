import {
	Finding,
	type RecordEnvelope,
	RecordError,
	type RecordJson,
	reviewPayloads,
	SharedRecord,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const head = "b".repeat(40);
const revision = `${"a".repeat(40)}..${head}`;
const dismissed = "0123456789abcdef";
const dismissalRecord = "c".repeat(64);

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
	snapshotId: "snap",
	receipt: "receipt",
	cacheKey: "cache",
	coverage: { graph: "g", review: "r", test: "t" },
};
const budgetEnded = { budget: "tokens", limit: 10, tokens: 11, tools: 2 };
const verification = {
	verdict: "confirmed",
	reason: "It is reachable",
	matches: { [dismissed]: "same" },
	executor: "llm",
	model: "anthropic/opus",
	version: "v1",
};
const lens = (outcome: RecordJson) => ({
	v: 1,
	name: "security",
	version: "abc",
	level: "careful",
	probe: false,
	outcome,
	sightings: [finding("lens.security", "abc@careful")],
	delivery: null,
});

// Every shape each kind's payload can take, each with every field present, so removing any one is a refusal.
const samples: readonly [string, RecordJson][] = [
	[
		"check",
		{
			v: 1,
			result: {
				name: "static.biome",
				status: "ran",
				version: "2.0.0",
				findings: 1,
				notes: ["a note"],
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
				version: "1",
				findings: 0,
				notes: [],
				reason: "reused",
			},
			sightings: [],
		},
	],
	[
		"check",
		{
			v: 1,
			result: { name: "static.mutation", status: "skipped", reason: "a fork", cause: "headNotAllowed" },
			sightings: [],
		},
	],
	[
		"check",
		{ v: 1, result: { name: "static.tsc", status: "failed", reason: "it crashed", error: "exit 2" }, sightings: [] },
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
	["lens", lens({ status: "unanswered", reason: "no answer" })],
	["lens", lens({ status: "exhausted", tried: ["anthropic/opus"], reason: "every model failed" })],
	[
		"verification",
		{
			v: 1,
			claims: [{ id: dismissed, source: { check: "lens.security", version: "abc@careful" }, verification }],
			dismissals: [{ finding: dismissed, record: dismissalRecord }],
			outcomes: [
				{ candidate: "one", outcome: { status: "done", model: "anthropic/opus" } },
				{ candidate: "two", outcome: { status: "ended", budgetEnded } },
				{ candidate: "three", outcome: { status: "unanswered", reason: "no answer" } },
			],
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
			failure: "a reason",
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
					outcome: "done",
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
			sighting: { revision, finding: finding("lens.security", "abc@careful") },
			head,
			rounds: [dismissalRecord],
			trigger: { hash: "h", proof: [{ file: "src/run.ts", hash: "p" }] },
		},
	],
];

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

const check = (kind: string, payload: RecordJson) => reviewPayloads[kind]?.(payload);

describe("review payload checks", () => {
	it.each(samples)("accepts a whole %s payload", (kind, payload) => {
		expect(check(kind, payload)).toBeUndefined();
	});

	it("has a check for every kind a review writes, and a dismissal", () => {
		expect(Object.keys(reviewPayloads).sort()).toEqual(
			["check", "dismissal", "lens", "telemetry", "triage", "verification", "walkthrough"].sort(),
		);
	});

	it.each(
		samples.flatMap(([kind, payload]) =>
			fields(payload).map((path) => [kind, path.join("/"), payload, path] as const),
		),
	)("refuses a %s payload without %s", (kind, _name, payload, path) => {
		expect(check(kind, without(payload, path))).toMatch(/schema/);
	});

	it.each(samples)("refuses a %s payload with a field more", (kind, payload) => {
		expect(check(kind, { ...(payload as Record<string, RecordJson>), extra: 1 })).toMatch(/schema/);
	});

	it.each(samples)("refuses a %s payload of another version", (kind, payload) => {
		expect(check(kind, { ...(payload as Record<string, RecordJson>), v: 2 })).toMatch(/schema/);
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
			"holds a sighting at /sightings/0 from static.tsc@2.0.0, not static.biome@2.0.0",
		);
		expect(check("check", { ...payload, sightings: [finding("static.biome", "1.0.0")] })).toMatch(
			/not static.biome@2.0.0/,
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
		expect(check("check", { ...unversioned, sightings: [finding("static.biome", "2.0.0")] })).toMatch(
			/from static.biome@2.0.0, not static.biome@$/,
		);
	});

	it.each(["skipped", "failed"])("refuses a check that %s and still holds sightings", (status) => {
		const [, payload] = samples.find(
			([kind, each]) => kind === "check" && (each as { result: { status: string } }).result.status === status,
		) as [string, Record<string, RecordJson>];
		const name = (payload.result as { name: string }).name;
		expect(check("check", { ...payload, sightings: [finding(name, undefined)] })).toMatch(
			/^holds sightings for a check/,
		);
	});

	it("accepts a ran or provisional check holding no sightings", () => {
		const payload = samples[0]?.[1] as Record<string, RecordJson>;
		expect(check("check", { ...payload, sightings: [] })).toBeUndefined();
	});

	it("refuses a sighting that is not a finding", () => {
		const payload = samples[0]?.[1] as Record<string, RecordJson>;
		expect(check("check", { ...payload, sightings: [{ ruleId: "unsafe" }] })).toMatch(
			/^holds a sighting at \/sightings\/0 that is not a finding/,
		);
	});

	it("refuses a lens record whose sighting is another lens's, or another level's", () => {
		const payload = samples.find(([kind]) => kind === "lens")?.[1] as Record<string, RecordJson>;
		expect(check("lens", { ...payload, sightings: [finding("lens.tests", "abc@careful")] })).toMatch(
			/from lens.tests@abc@careful, not lens.security@abc@careful/,
		);
		expect(check("lens", { ...payload, sightings: [finding("lens.security", "abc@quick")] })).toMatch(
			/not lens.security@abc@careful/,
		);
		expect(check("lens", { ...payload, sightings: [finding("lens.security", "abd@careful")] })).toMatch(
			/not lens.security@abc@careful/,
		);
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

	it("refuses a dismissal whose sighting is not a finding", () => {
		const payload = samples.find(([kind]) => kind === "dismissal")?.[1] as Record<string, RecordJson>;
		expect(check("dismissal", { ...payload, sighting: { revision, finding: { ruleId: "unsafe" } } })).toMatch(
			/^holds a sighting at \/sighting\/finding that is not a finding/,
		);
	});

	it("names the kind when a record's payload is refused", () => {
		const envelope: RecordEnvelope = {
			v: 1,
			changeset: "pull-0123456789abcdef",
			kind: "walkthrough",
			key: "w",
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

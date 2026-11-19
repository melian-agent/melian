import { Finding, Lens, type RecordJson, reviewPayloads } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

// Each field a shared record classes as an ID, hash, version, time or code refuses free text on read, as issue #548
// asks: a record Melian never built must not pass the reader with a token where a hash belongs.
const token = "ghp_token";
const withheld = "Melian shares none of this text, which the reviewing host's store and terminal hold";
const blindCallers = "callers were unavailable for every changed site, so no lens saw who calls the changed code";
const lightTriage =
	"triage chose quick for every lens, so the whole review looked lightly, at a change that can steer triage";
const head = "b".repeat(40);
const revision = `${"a".repeat(40)}..${head}`;
const lensVersion = "0123456789ab";
const verifierVersion = "0123456789abcdef";
const findingId = "0123456789abcdef";
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
	receipt: JSON.stringify({ format_version: 1, snapshot_id: snapshotId, enola_version: "0.4.0-dev.1" }),
	cacheKey: hash("f"),
	coverage: { graph: hash("1"), review: hash("2"), test: hash("3") },
};
const budgetEnded = { budget: "tokens", limit: 10, tokens: 11, tools: 2 };
const decided = (name: string, version: string | null, level: string | null) => ({
	name,
	status: "ended",
	reason: withheld,
	error: "timeout",
	version,
	level,
	budgetEnded,
	caveats: [blindCallers, lightTriage, withheld],
	coverage: { graph: hash("4"), review: hash("5"), test: hash("6") },
	lineage: {
		model: "openai/terra",
		thinking: { level: "low", wanted: "unset", by: "melian.local.yaml" },
		wanted: "anthropic/opus",
		by: "melian.local.yaml",
		moved: null,
		outside: false,
	},
});
const lens = (outcome: RecordJson) => ({
	v: 1,
	name: "security",
	version: lensVersion,
	level: "careful",
	probe: false,
	outcome,
	sightings: [finding("lens.security", `${lensVersion}@careful`)],
	delivery: null,
	check: decided("lens.security", lensVersion, "careful"),
});
const verification = {
	verdict: "confirmed",
	reason: "It is reachable",
	executor: "llm",
	model: "anthropic/opus",
	version: verifierVersion,
};

// One sample of each shape a field below lives in, every value as Melian's own build writes it.
const samples = {
	ran: {
		kind: "check",
		payload: {
			v: 1,
			result: {
				name: "static.biome",
				status: "ran",
				version: "2.0.0",
				findings: 1,
				notes: [],
				snapshots: [snapshot],
			},
			// No sighting, so a sighting's version that disagrees with the result's does not decide a version test.
			sightings: [],
		},
	},
	provisional: {
		kind: "check",
		payload: {
			v: 1,
			result: {
				name: "static.mutation",
				status: "provisional",
				version: "unavailable",
				findings: 0,
				notes: [],
				reason: withheld,
			},
			sightings: [],
		},
	},
	skipped: {
		kind: "check",
		payload: {
			v: 1,
			result: { name: "static.mutation", status: "skipped", reason: "timeout", cause: "timeout" },
			sightings: [],
		},
	},
	failed: {
		kind: "check",
		payload: {
			v: 1,
			result: { name: "static.tsc", status: "failed", reason: "unexpected", error: withheld },
			sightings: [],
		},
	},
	lens: {
		kind: "lens",
		payload: lens({ status: "unanswered", reason: withheld }),
	},
	// No check and no sighting, which repeat the version, so a version test fails on the version alone.
	bare: {
		kind: "lens",
		payload: { ...lens({ status: "unanswered", reason: withheld }), sightings: [], check: null },
	},
	exhausted: {
		kind: "lens",
		payload: lens({ status: "exhausted", tried: ["anthropic/opus"], reason: "aborted" }),
	},
	verification: {
		kind: "verification",
		payload: {
			v: 1,
			claims: [{ id: findingId, source: { check: "static.biome", version: withheld }, verification }],
			dismissals: [],
			outcomes: [{ candidate: "1111111111111111", outcome: { status: "unanswered", reason: withheld } }],
			check: decided("verifier", verifierVersion, null),
		},
	},
	telemetry: {
		kind: "telemetry",
		payload: {
			v: 1,
			durationMs: 10,
			stages: [
				{
					name: "lens.security",
					level: "careful",
					models: ["anthropic/opus"],
					durationMs: 10,
					tokens: 11,
					cacheRead: 0,
					costMicros: 12,
					outcome: "completed",
					tools: 2,
					limits: { tokens: 10, tools: null },
					ended: "tokens",
					usageIncomplete: false,
				},
			],
		},
	},
	triage: {
		kind: "triage",
		payload: { v: 1, decision: null, failure: withheld, inputCut: false },
	},
	dismissal: {
		kind: "dismissal",
		payload: {
			v: 1,
			by: "maintainer",
			reason: "Not a defect",
			at: "2026-11-15T00:00:00.000Z",
			severity: "P1",
			sighting: { revision, finding: finding("lens.security", `${lensVersion}@careful`) },
			head,
			rounds: [],
			trigger: { hash: hash("7"), proof: [{ file: "src/run.ts", hash: hash("8") }] },
		},
	},
	account: {
		kind: "account",
		payload: {
			v: 1,
			checks: ["static.biome"],
			records: [],
			filled: [
				{
					name: "static.biome",
					status: "failed",
					reason: "no record",
					error: withheld,
					version: "2.0.0",
					level: null,
					budgetEnded: null,
					caveats: null,
					coverage: null,
					lineage: null,
				},
			],
			allowSkip: [],
			producers: [
				{ check: "lens.security", version: `${lensVersion}@careful`, ids: null },
				{ check: "static.biome", version: "2.0.0", ids: null },
			],
		},
	},
} satisfies Record<string, { kind: string; payload: RecordJson }>;
type Sample = keyof typeof samples;

function at(value: RecordJson, path: string, replacement: RecordJson): RecordJson {
	const copy = structuredClone(value) as Record<string, RecordJson>;
	const keys = path.split("/");
	let parent = copy as RecordJson;
	for (const key of keys.slice(0, -1)) parent = (parent as Record<string, RecordJson>)[key] as RecordJson;
	(parent as Record<string, RecordJson>)[keys.at(-1) as string] = replacement;
	return copy;
}

const check = (sample: Sample, payload: RecordJson = samples[sample].payload) =>
	reviewPayloads[samples[sample].kind]?.(payload);

// Each field the shared record decision classes as an ID, hash, version, time or code, with only that field wrong.
const fields: readonly [Sample, string][] = [
	["ran", "result/version"],
	["ran", "result/notes/0"],
	["ran", "result/snapshots/0/commit"],
	["ran", "result/snapshots/0/snapshotId"],
	["ran", "result/snapshots/0/receipt"],
	["ran", "result/snapshots/0/cacheKey"],
	["ran", "result/snapshots/0/coverage/graph"],
	["ran", "result/snapshots/0/coverage/review"],
	["ran", "result/snapshots/0/coverage/test"],
	["provisional", "result/version"],
	["provisional", "result/reason"],
	["skipped", "result/reason"],
	["failed", "result/reason"],
	["failed", "result/error"],
	["bare", "version"],
	["lens", "outcome/reason"],
	["exhausted", "outcome/reason"],
	["lens", "check/reason"],
	["lens", "check/error"],
	["lens", "check/caveats/0"],
	["lens", "check/coverage/graph"],
	["lens", "check/coverage/review"],
	["lens", "check/coverage/test"],
	["lens", "check/lineage/thinking/level"],
	["lens", "check/lineage/thinking/wanted"],
	["verification", "claims/0/source/version"],
	["verification", "outcomes/0/outcome/reason"],
	["verification", "check/version"],
	["verification", "claims/0/verification/version"],
	["telemetry", "stages/0/outcome"],
	["triage", "failure"],
	["dismissal", "at"],
	["dismissal", "trigger/hash"],
	["dismissal", "trigger/proof/0/hash"],
	["account", "filled/0/reason"],
	["account", "filled/0/error"],
	["account", "filled/0/version"],
	["account", "producers/1/version"],
];

describe("a shared record's classed fields", () => {
	it.each(Object.keys(samples) as Sample[])("accepts the %s sample, as Melian writes it", (sample) => {
		expect(check(sample)).toBeUndefined();
	});

	it.each(fields)("refuses free text in the %s sample's %s", (sample, path) => {
		const refused = check(sample, at(samples[sample].payload, path, token));
		expect(refused).toBeTypeOf("string");
		expect(refused).not.toContain(token);
	});

	it("refuses a note, which a record always leaves empty", () => {
		expect(check("ran", at(samples.ran.payload, "result/notes", [withheld]))).toBeTypeOf("string");
	});

	// Each value is right but for one character, so a pattern that is not anchored, or one digit short, lets it in.
	it.each([
		["ran", "result/snapshots/0/commit", "b".repeat(39)],
		["ran", "result/snapshots/0/commit", "B".repeat(40)],
		["ran", "result/snapshots/0/snapshotId", hash("e")],
		["ran", "result/snapshots/0/snapshotId", `${snapshotId}0`],
		["ran", "result/snapshots/0/cacheKey", "f".repeat(63)],
		["ran", "result/snapshots/0/cacheKey", `x${hash("f")}`],
		["ran", "result/snapshots/0/receipt", `${snapshot.receipt} `],
		["ran", "result/version", "v2.0.0"],
		["ran", "result/version", `1.0.0-${"a".repeat(59)}`],
		["bare", "version", "0123456789abc"],
		["bare", "version", "0123456789a"],
		["verification", "check/version", "0123456789abcde"],
		["dismissal", "at", "2026-11-15T00:00:00Z"],
		["dismissal", "at", "2026-11-15T00:00:00.000+00:00"],
		["dismissal", "trigger/hash", `${hash("7")}0`],
		["lens", "check/caveats/0", `${blindCallers}: src/run.ts`],
		// A lens's source is a hash, `@` and a level; each value has only one of the three wrong.
		["account", "producers/0/version", `${lensVersion}@careful@quick`],
		["account", "producers/0/version", "0123456789a@careful"],
		["account", "producers/0/version", `${lensVersion}@reckless`],
		["dismissal", "sighting/finding/properties/source/version", `${lensVersion}@reckless`],
	] as const)("refuses the %s sample's %s at %j", (sample, path, value) => {
		expect(check(sample, at(samples[sample].payload, path, value))).toBeTypeOf("string");
	});

	// The other values each class takes, so a closed set or a pattern lets in every value Melian writes.
	it.each([
		["ran", "result/snapshots/0/commit", hash("c")],
		["ran", "result/snapshots/0/receipt", withheld],
		["ran", "result/snapshots/0/cacheKey", null],
		["ran", "result/version", withheld],
		["ran", "result/version", `1.0.0-${"a".repeat(58)}`],
		["provisional", "result/reason", "withheld"],
		["failed", "result/reason", "toolFailed"],
		["lens", "check/lineage/thinking/level", "unset"],
		["lens", "check/lineage/thinking/wanted", "xhigh"],
		["verification", "check/version", null],
		["telemetry", "stages/0/outcome", "faulted"],
		["telemetry", "stages/0/outcome", withheld],
		["account", "filled/0/version", "unavailable"],
	] as const)("accepts the %s sample's %s at %j", (sample, path, value) => {
		expect(check(sample, at(samples[sample].payload, path, value))).toBeUndefined();
	});

	// A refusal names where the record went wrong in the schema's words, never in words the record supplied.
	it.each([
		["a field no schema has", "ran", (payload: RecordJson) => ({ ...(payload as object), [token]: 1 })],
		[
			"a map's key whose value is wrong",
			"triage",
			(payload: RecordJson) =>
				at(payload, "decision", {
					questionSet: { name: "triage", version: "1" },
					decider: "llm",
					calibrated: false,
					model: null,
					answers: [{ question: "security", distribution: { [token]: -1 }, chosen: "careful" }],
				}),
		],
		["the verifier check's name", "verification", (payload: RecordJson) => at(payload, "check/name", token)],
		["a sighting that is not a finding", "lens", (payload: RecordJson) => at(payload, "sightings/0", { [token]: 1 })],
	] as const)("refuses %s without repeating it", (_, sample, change) => {
		const refused = check(sample, change(samples[sample].payload));
		expect(refused).toBeTypeOf("string");
		expect(refused).not.toContain(token);
	});

	// An array index is the schema's word and stays; a key that only starts or ends with digits is the record's.
	it("names an array index in the path and masks a key that holds digits", () => {
		const { payload } = samples.telemetry;
		const stages = Array.from({ length: 11 }, () => structuredClone(payload.stages[0]));
		expect(check("telemetry", at({ ...payload, stages }, "stages/10/tools", -1))).toBe(
			"does not match its schema at /stages/10/tools: must be >= 0",
		);
		for (const key of ["1ghp", "ghp1"])
			expect(check("telemetry", { ...payload, [key]: 1 })).toBe("does not match its schema at /*: schema is false");
	});

	// An index is kept only where the schema has an array, so a key spelt in digits is the record's and is masked.
	it("masks an unknown key spelt in digits, wherever it sits", () => {
		const { payload } = samples.telemetry;
		const key = "9876543210987654321098765432109876543210";
		expect(check("telemetry", { ...payload, [key]: 1 })).toBe("does not match its schema at /*: schema is false");
		const stages = [{ ...structuredClone(payload.stages[0]), [key]: 1 }];
		expect(check("telemetry", { ...payload, stages })).toBe(
			"does not match its schema at /stages/0/*: schema is false",
		);
	});

	// The walk follows the schema through a union, an array and a map, and masks only what the schema does not name.
	it("names each segment the schema names through a union, an array or a map", () => {
		const key = "98765";
		const done = { status: "done", model: null, budgetEnded: null, capped: null, escalation: null, usage: null };
		const escalation = { to: null, carried: [], kept: [], refuted: [] };
		const triggered = (trigger: RecordJson) =>
			check("lens", at(samples.lens.payload, "outcome", { ...done, escalation: { ...escalation, trigger } }));
		const answers = [{ question: "security", distribution: { [key]: -1 }, chosen: "careful" }];
		const decision = { questionSet: { name: "triage", version: "1" }, decider: "llm", calibrated: false, model: null };
		const proof = { file: "src/run.ts", hash: hash("1") };
		const wrong = "does not match its schema at";
		expect.soft(triggered({ kind: "severity", severity: "PX" })).toBe(
			`${wrong} /outcome/escalation/trigger/severity: must be equal to constant`,
		);
		expect.soft(triggered({ kind: "severity", severity: "P1", [key]: 1 })).toBe(
			`${wrong} /outcome/escalation/trigger/*: schema is false`,
		);
		const usage = { models: [1], tokens: 0, costMicros: 0 };
		expect.soft(check("lens", at(samples.lens.payload, "outcome", { ...done, usage }))).toBe(
			`${wrong} /outcome/usage/models/0: must be string`,
		);
		expect.soft(check("triage", at(samples.triage.payload, "decision", { ...decision, answers }))).toBe(
			`${wrong} /decision/answers/0/distribution/*: must be >= 0`,
		);
		expect.soft(check("dismissal", at(samples.dismissal.payload, "trigger/proof/0", { ...proof, [key]: 1 }))).toBe(
			`${wrong} /trigger/proof/0/*: schema is false`,
		);
		expect.soft(check("verification", at(samples.verification.payload, "check/status", "x"))).toBe(
			`${wrong} /check/status: must be equal to constant`,
		);
	});

	// The pattern takes its length from the one `versioned` cuts a lens's hash to, so every lens Melian ships fits it.
	it("accepts every built-in lens's version", async () => {
		const lenses = await Lens.builtins();
		expect(lenses.length).toBeGreaterThan(0);
		for (const { version } of lenses)
			expect(check("bare", at(samples.bare.payload, "version", version))).toBeUndefined();
	});
});

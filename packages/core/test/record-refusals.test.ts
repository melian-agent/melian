import {
	accountPayloadSchema,
	checkPayloadSchema,
	dismissalPayloadSchema,
	Finding,
	legacyAccountPayloadSchema,
	lensPayloadSchema,
	RecordError,
	type RecordJson,
	reviewPayloads,
	SharedRecord,
	telemetryPayloadSchema,
	triagePayloadSchema,
	verificationPayloadSchema,
	walkthroughPayloadSchema,
	withheld,
} from "@melian-agent/core";
import type { TSchema } from "typebox";
import { describe, expect, it } from "vitest";

// A refusal is printed to a terminal and kept in a store, so it names where a record went wrong and never repeats what
// the record wrote: a terminal escape or a bidi control in a record must not reach either. The sentinel is built from
// char codes so a formatter cannot turn an escape into the character it names.
const terminalEscape = String.fromCharCode(0x1b);
const override = String.fromCharCode(0x202e);
const marker = "record-text-548";
const sentinel = `${terminalEscape}[31m${marker}${override}`;

const head = "b".repeat(40);
const revision = `${"a".repeat(40)}..${head}`;
const lensVersion = "0123456789ab";
const verifierVersion = "0123456789abcdef";
const findingId = "0123456789abcdef";
const otherId = "fedcba9876543210";
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

const budgetEnded = { budget: "tokens", limit: 10, tokens: 11, tools: 2 };
const coverage = { graph: hash("4"), review: hash("5"), test: hash("6") };
const lineage = {
	model: "openai/terra",
	thinking: { level: "low", wanted: "unset", by: "melian.local.yaml" },
	wanted: "anthropic/opus",
	by: "melian.local.yaml",
	moved: { by: "melian.yaml", from: "anthropic/opus", to: "openai/terra" },
	outside: false,
};
const decided = (name: string, version: string | null, level: string | null) => ({
	name,
	status: "ended",
	reason: withheld,
	error: "timeout",
	version,
	level,
	budgetEnded,
	caveats: [withheld],
	coverage,
	lineage,
});
const filled = (name: string, version: string | null) => ({
	name,
	status: "failed",
	reason: "timeout",
	error: withheld,
	version,
	level: null,
	budgetEnded,
	caveats: [withheld],
	coverage,
	lineage,
});
const snapshot = {
	commit: head,
	snapshotId,
	receipt: JSON.stringify({ format_version: 1, snapshot_id: snapshotId, enola_version: "0.4.0" }),
	cacheKey: hash("f"),
	coverage,
};
const verification = {
	verdict: "confirmed",
	reason: "It is reachable",
	correction: "It is reachable from the handler",
	answers: { code: "yes", guard: "no", base: "no" },
	evidence: [{ file: "src/run.ts", startLine: 7, endLine: 8, role: "cause", revision: "head", snippet: "run(input)" }],
	lowered: { from: "P1", to: "P2", reason: "Behind a flag" },
	matches: { [otherId]: "same" },
	executor: "llm",
	model: "anthropic/opus",
	version: verifierVersion,
};
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
const accountFields = {
	checks: ["lens.security", "static.biome"],
	records: [hash("1"), hash("2")],
	filled: [filled("static.biome", "2.0.0"), filled("static.tsc", "5.0.0")],
	allowSkip: ["static.biome", "static.tsc"],
	producers: [
		{ check: "lens.security", version: `${lensVersion}@careful`, ids: [findingId, otherId] },
		{ check: "static.biome", version: "2.0.0", ids: null },
	],
};

// One payload of each shape a kind takes, as Melian writes it, filled so that between them they hold every string
// field each kind's schema has; the test below fails when a schema gains a string field no sample holds.
const payloads: readonly [string, RecordJson][] = [
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
				version: "unavailable",
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
			result: { name: "static.mutation", status: "skipped", reason: "timeout", cause: "timeout" },
			sightings: [],
		},
	],
	[
		"check",
		{
			v: 1,
			result: { name: "static.tsc", status: "failed", reason: "unexpected", error: withheld },
			sightings: [],
		},
	],
	[
		"lens",
		lens({
			status: "done",
			model: "openai/sol",
			budgetEnded,
			capped: 1,
			escalation: {
				trigger: { kind: "severity", severity: "P1" },
				to: "anthropic/opus",
				carried: [findingId],
				kept: [findingId, otherId],
				refuted: [otherId],
			},
			usage: { models: ["openai/sol", "anthropic/opus"], tokens: 12, costMicros: 13 },
		}),
	],
	["lens", lens({ status: "unanswered", reason: withheld })],
	["lens", lens({ status: "exhausted", tried: ["anthropic/opus", "openai/sol"], reason: "aborted" })],
	[
		"verification",
		{
			v: 1,
			claims: [
				{ id: findingId, source: { check: "static.biome", version: "2.0.0" }, verification },
				{ id: otherId, source: { check: "lens.security", version: `${lensVersion}@careful` }, verification },
			],
			dismissals: [
				{ finding: otherId, record: hash("3") },
				{ finding: findingId, record: hash("4") },
			],
			outcomes: [
				{ candidate: "1111111111111111", outcome: { status: "done", model: "anthropic/opus" } },
				{ candidate: "2222222222222222", outcome: { status: "ended", budgetEnded } },
				{ candidate: "3333333333333333", outcome: { status: "unanswered", reason: withheld } },
			],
			check: decided("verifier", verifierVersion, null),
		},
	],
	[
		"walkthrough",
		{
			v: 1,
			route: "openai/sol",
			summary: "Adds a check",
			files: [
				{ path: "src/a.ts", summary: "The check" },
				{ path: "src/b.ts", summary: "Its caller" },
			],
			diagram: "a --> b",
			note: "Read a first",
		},
	],
	[
		"triage",
		{
			v: 1,
			decision: {
				questionSet: { name: "triage", version: "1" },
				decider: "model",
				calibrated: false,
				model: "openai/terra",
				answers: [
					{ question: "risk", distribution: { low: 250_000, high: 750_000 }, chosen: "high" },
					{ question: "size", distribution: { small: 1_000_000 }, chosen: "small" },
				],
			},
			failure: withheld,
			inputCut: false,
		},
	],
	[
		"telemetry",
		{
			v: 1,
			durationMs: 10,
			stages: [
				{
					name: "lens.security",
					level: "careful",
					models: ["anthropic/opus", "openai/sol"],
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
				{
					name: "lens.tests",
					level: null,
					models: [],
					durationMs: null,
					tokens: null,
					cacheRead: null,
					costMicros: null,
					outcome: "faulted",
					tools: null,
					limits: null,
					ended: null,
					usageIncomplete: true,
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
			rounds: [hash("1"), hash("2")],
			frontier: [hash("1"), hash("2")],
			trigger: {
				hash: hash("7"),
				proof: [
					{ file: "src/a.ts", hash: hash("8") },
					{ file: "src/b.ts", hash: hash("9") },
				],
			},
		},
	],
	["account", { v: 2, ...accountFields, resolutionPolicy: "2:0123456789abcdef" }],
	["account", { v: 1, ...accountFields }],
	[
		"round",
		{
			read: [
				{ kind: "check", key: hash("5"), id: hash("1") },
				{ kind: "lens", key: hash("6"), id: hash("2") },
			],
			walkthrough: { key: hash("7"), id: hash("3") },
			replaces: [hash("1"), hash("2")],
			before: [hash("3"), hash("4")],
		},
	],
];

// A sighting whose producer is the sentinel, so a refusal that names the producer it expected or found is caught.
const sighted: readonly [string, RecordJson][] = [
	[
		"check",
		{
			v: 1,
			result: { name: "static.biome", status: "ran", version: "2.0.0", findings: 1, notes: [], snapshots: null },
			sightings: [finding(sentinel, "2.0.0")],
		},
	],
	[
		"check",
		{
			v: 1,
			result: { name: "static.biome", status: "ran", version: "2.0.0", findings: 1, notes: [], snapshots: null },
			sightings: [finding("static.biome", sentinel)],
		},
	],
	["lens", { ...(lens({ status: "unanswered", reason: withheld }) as object), sightings: [finding(sentinel, "1")] }],
];

const schemas: Record<string, TSchema> = {
	check: checkPayloadSchema,
	lens: lensPayloadSchema,
	verification: verificationPayloadSchema,
	walkthrough: walkthroughPayloadSchema,
	triage: triagePayloadSchema,
	telemetry: telemetryPayloadSchema,
	dismissal: dismissalPayloadSchema,
	account: accountPayloadSchema,
	"account v1": legacyAccountPayloadSchema,
};

type Path = readonly (string | number)[];

// Every path at which `schema` takes free string text, an array's item and a map's value written `*`. A literal is a
// value Melian names, not text, and an unknown value is a finding, which `Finding.parse` checks.
function stringFields(schema: TSchema, at = ""): string[] {
	const node = schema as {
		type?: string;
		const?: unknown;
		anyOf?: TSchema[];
		properties?: Record<string, TSchema>;
		items?: TSchema;
		maxItems?: number;
		patternProperties?: Record<string, TSchema>;
	};
	if (node.anyOf !== undefined) return node.anyOf.flatMap((each) => stringFields(each, at));
	if (node.type === "string" && node.const === undefined) return [at];
	if (node.properties !== undefined)
		return Object.entries(node.properties).flatMap(([key, each]) => stringFields(each, `${at}/${key}`));
	// A list that may hold no item, as a check's notes, holds no text.
	if (node.items !== undefined) return node.maxItems === 0 ? [] : stringFields(node.items, `${at}/*`);
	if (node.patternProperties !== undefined)
		return Object.values(node.patternProperties).flatMap((each) => stringFields(each, `${at}/*`));
	return [];
}

// Every string in `value`, outside a sighting's finding, by path.
function strings(value: RecordJson, at: Path = []): Path[] {
	if (typeof value === "string") return [at];
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([key, each]) =>
		strings(each as RecordJson, [...at, Array.isArray(value) ? Number(key) : key]),
	);
}

function arrays(value: RecordJson, at: Path = []): Path[] {
	if (typeof value !== "object" || value === null) return [];
	const own = Array.isArray(value) && value.length > 0 ? [at] : [];
	return [
		...own,
		...Object.entries(value).flatMap(([key, each]) =>
			arrays(each as RecordJson, [...at, Array.isArray(value) ? Number(key) : key]),
		),
	];
}

function objectKeys(value: RecordJson, at: Path = []): Path[] {
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([key, each]) => {
		const path = [...at, Array.isArray(value) ? Number(key) : key];
		return [...(Array.isArray(value) ? [] : [path]), ...objectKeys(each as RecordJson, path)];
	});
}

const pattern = (path: Path) => path.map((segment) => (typeof segment === "number" ? "*" : segment));

function edit(
	value: RecordJson,
	path: Path,
	change: (parent: Record<string | number, RecordJson>, key: string | number) => void,
) {
	const copy = structuredClone(value);
	let parent = copy as Record<string | number, RecordJson>;
	for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<string | number, RecordJson>;
	change(parent, path.at(-1) as string | number);
	return copy;
}

const put = (value: RecordJson, path: Path, replacement: RecordJson) =>
	edit(value, path, (parent, key) => {
		parent[key] = replacement;
	});

const envelope = (kind: string, payload: RecordJson): RecordJson => ({
	v: 1,
	changeset: hash("c"),
	...(kind === "dismissal" ? {} : { revision }),
	kind,
	key: kind === "dismissal" ? findingId : hash("d"),
	payload,
});

function refusal(record: RecordJson): string | undefined {
	try {
		SharedRecord.parse(record, reviewPayloads);
		return undefined;
	} catch (error) {
		if (error instanceof RecordError) return error.message;
		throw error;
	}
}

// Each record with the sentinel in one string or one key, alone, beside one other string that is wrong, or beside an
// array out of order or holding one item twice, so each refusal a record can reach is reached with the sentinel in it.
function variants(record: RecordJson): RecordJson[] {
	const texts = strings(record);
	const lists = arrays(record);
	return [
		...objectKeys(record).map((path) =>
			edit(record, path, (parent, key) => {
				parent[sentinel] = parent[key] as RecordJson;
				delete parent[key];
			}),
		),
		...texts.flatMap((path) => {
			const marked = put(record, path, sentinel);
			return [
				marked,
				...texts.filter((other) => other.join("/") !== path.join("/")).map((other) => put(marked, other, "x")),
				...lists.flatMap((list) => [
					edit(marked, list, (parent, key) => {
						(parent[key] as RecordJson[]).reverse();
					}),
					edit(marked, list, (parent, key) => {
						const items = parent[key] as RecordJson[];
						items.push(structuredClone(items[0] as RecordJson));
					}),
				]),
			];
		}),
	];
}

// Every refusal the records below reached, so the last test can show the sentinel reached each that once named it.
const reached = new Set<string>();

describe("a shared record's refusal", () => {
	it.each(payloads)("accepts the %s sample", (kind, payload) => {
		expect(refusal(envelope(kind, payload))).toBeUndefined();
	});

	it.each(Object.entries(schemas))("has a sample holding each string field of the %s schema", (name, schema) => {
		const [kind, version] = name.split(" v");
		const held = new Set(
			payloads
				.filter(
					([each, payload]) =>
						each === kind && (version === undefined || (payload as { v: number }).v === Number(version)),
				)
				.filter(([, payload]) => name !== "account" || (payload as { v: number }).v === 2)
				.flatMap(([, payload]) => strings(payload).map((path) => `/${pattern(path).join("/")}`)),
		);
		expect(stringFields(schema).filter((field) => !held.has(field))).toEqual([]);
	});

	// A kind is dot-joined segments of [a-z0-9-], so the one refusal that names a record's kind, of an unknown kind,
	// repeats only those characters, and the sentinel's terminalEscape fails the pattern before it.
	// A verification record has the most variants, and took past five seconds on a loaded runner on main too.
	it.each([...payloads, ...sighted])(
		"repeats no text from a %s record",
		(kind, payload) => {
			for (const record of [...variants(envelope(kind, payload)), ...[envelope(kind, payload)]]) {
				const refused = refusal(record) ?? "";
				reached.add(refused);
				expect(refused).not.toContain(marker);
				expect(refused).not.toContain(terminalEscape);
				expect(refused).not.toContain(override);
			}
		},
		30_000,
	);

	it("reaches the refusals that once named a producer, with the sentinel in the record", () => {
		expect([...reached]).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/from another producer/),
				expect.stringMatching(/that is not one Melian writes/),
				expect.stringMatching(/holds the check of another lens/),
				expect.stringMatching(/keeps the findings at /),
			]),
		);
	});
});

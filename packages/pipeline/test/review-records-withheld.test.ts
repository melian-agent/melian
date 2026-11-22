import { type CheckRecord, Finding, type SharedRecord, type StoredFinding, type Walkthrough } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { blindCallers, lightTriage } from "../src/caveats.ts";
import type { CheckRunRecord } from "../src/checks.ts";
import { ReviewRecords, withheld } from "../src/review-records.ts";

// Text a tool, a provider or the head's code wrote, such as a login one of them read.
const token = "melian-test-token-5f1e2d";
const records = ReviewRecords.of("c".repeat(64), { base: "a".repeat(40), head: "b".repeat(40) });
const bytes = (record: SharedRecord) => JSON.stringify(record.toJSON());
const payload = (record: SharedRecord) => record.toJSON().payload as Record<string, unknown>;

const run = {
	name: "correctness",
	version: "0123456789ab",
	level: "careful",
	request: "d".repeat(64),
	probe: false,
} as const;
const decided = (record: CheckRecord) => ({
	reason: null,
	error: null,
	version: null,
	level: null,
	budgetEnded: null,
	caveats: null,
	coverage: null,
	lineage: null,
	...record,
});

const sighting = (version: string | undefined, check = "static.biome"): StoredFinding =>
	Finding.create({
		rule: "lint/style",
		message: "Unsafe input",
		file: "src/run.ts",
		startLine: 7,
		snippet: "run(input)",
		occurrence: 0,
		severity: "P2",
		cause: "introduced",
		source: { check, version },
		explanation: { what: "Unsafe input", whyHere: "New input", whatToDo: "Validate it" },
	}).toJSON();
const verdict = {
	verdict: "confirmed",
	reason: "It runs",
	executor: "llm",
	model: "anthropic/claude",
	version: "0123456789abcdef",
} as const;

const checks: CheckRunRecord[] = [
	{ name: "static.enola", status: "ran", findings: 0, notes: [`line 3: ${token}`] },
	{ name: "static.mutation", status: "provisional", findings: 0, notes: [token], reason: token },
	{ name: "static.mutation", status: "skipped", reason: `the head wrote ${token}` },
	{ name: "static.enola", status: "failed", reason: token, error: `Enola exited 2: ${token}` },
];

describe("an exported record holds no text a tool, a provider or the head wrote", () => {
	it.each(checks)("as a $status check", (result) => {
		expect(bytes(records.check("e".repeat(64), result, []))).not.toContain(token);
	});

	it.each(["ran", "provisional"] as const)(
		"as a %s check's version, which the installed tool's manifest names",
		(status) => {
			const result = { name: "static.biome", status, findings: 0, notes: [], version: token, reason: "" };
			expect(bytes(records.check("e".repeat(64), result as CheckRunRecord, []))).not.toContain(token);
		},
	);

	it("as a lens that did not answer, gave up, or failed with a provider's message and caveats", () => {
		const check: CheckRecord = {
			name: "lens.correctness",
			version: "0123456789ab",
			level: "careful",
			status: "failed",
			reason: token,
			error: token,
			caveats: [`${blindCallers}: ${token}`, lightTriage, token],
		};
		for (const outcome of [
			{ status: "unanswered", reason: token },
			{ status: "exhausted", tried: ["openai-codex/gpt"], reason: token },
		] as const)
			expect(bytes(records.lens(run, outcome, [], check))).not.toContain(token);
	});

	it("as a verification whose candidate failed with a provider's message", () => {
		const record = records.verification("f".repeat(64), {
			claims: [],
			dismissals: [],
			outcomes: [{ candidate: "1111111111111111", outcome: { status: "unanswered", reason: token } }],
			check: { name: "verifier", status: "failed", reason: token, error: token },
		});
		expect(bytes(record)).not.toContain(token);
	});

	it("as a tool version that names a finding's source, wherever the finding goes", () => {
		const finding = sighting(token);
		const result = { name: "static.biome", status: "ran", findings: 1, notes: [], version: token } as CheckRunRecord;
		expect(bytes(records.check("e".repeat(64), result, [finding]))).not.toContain(token);
		const claims = [{ id: finding.properties.id, source: finding.properties.source, verification: verdict }];
		expect(bytes(records.verification("f".repeat(64), { claims, dismissals: [], outcomes: [] }))).not.toContain(
			token,
		);
		const producers = [{ check: "static.biome", version: token }];
		const account = {
			checks: ["static.biome"],
			records: [],
			filled: [],
			allowSkip: [],
			producers,
			resolutionPolicy: null,
		};
		expect(bytes(records.account(account))).not.toContain(token);
		const dismissal = records.dismissal({
			finding: finding.properties.id,
			by: "writer",
			reason: "fine",
			at: "2026-11-16T00:00:00.000Z",
			severity: "P2",
			// A static finding's dismissal is shared only with its run's proof, so a guardrail's carries the version here.
			sighting: { revision: `${"a".repeat(40)}..${"b".repeat(40)}`, finding: sighting(token, "guardrails") },
			rounds: [],
			trigger: { hash: "a".repeat(64), proof: [{ file: "src/run.ts", hash: "f".repeat(64) }] },
		});
		expect(bytes(dismissal)).not.toContain(token);
	});

	it("as a triage whose decider failed with a provider's message", () => {
		expect(bytes(records.triage("f".repeat(64), { failure: token }))).not.toContain(token);
	});

	it("as an account that filled a check with a reason and an error", () => {
		const record = records.account({
			checks: ["static.enola"],
			records: [],
			filled: [{ name: "static.enola", status: "failed", reason: token, error: token }],
			allowSkip: [],
			producers: [],
			resolutionPolicy: null,
		});
		expect(bytes(record)).not.toContain(token);
	});
});

describe("an exported record keeps what Melian defines", () => {
	it.each([
		"unknownCheck",
		"unknownTier",
		"tierCycle",
		"unknownConversation",
		"notCompleted",
		"noEnvironment",
		"worktreeFailed",
		"toolMissing",
		"toolFailed",
		"timeout",
		"aborted",
		"nothingToCheck",
		"outputTooLarge",
		"invalidOutput",
		"unreadable",
		"tooLarge",
		"failed",
		"orphaned",
		"faulted",
		"no record",
		"unexpected",
		"recordTooLarge",
	])("keeps the code %s as a failed or skipped check's reason", (code) => {
		const failed = records.check(
			"e".repeat(64),
			{ name: "static.enola", status: "failed", reason: code, error: "" },
			[],
		);
		const skipped = records.check("e".repeat(64), { name: "static.enola", status: "skipped", reason: code }, []);
		expect((payload(failed).result as { reason: string }).reason).toBe(code);
		expect((payload(skipped).result as { reason: string }).reason).toBe(code);
	});

	it("keeps a failed check's error code, and names any other code unexpected", () => {
		const known = records.check("e".repeat(64), checks[3]!, []);
		expect(payload(known).result).toEqual({
			name: "static.enola",
			status: "failed",
			reason: "unexpected",
			error: withheld,
		});
		const coded = records.check(
			"e".repeat(64),
			{ ...(checks[3] as CheckRunRecord & { status: "failed" }), reason: "toolFailed" },
			[],
		);
		expect((payload(coded).result as { reason: string }).reason).toBe("toolFailed");
	});

	it("says it withheld a skipped or provisional check's reason, and drops every note", () => {
		expect(payload(records.check("e".repeat(64), checks[0]!, [])).result).toMatchObject({ notes: [] });
		expect(payload(records.check("e".repeat(64), checks[1]!, [])).result).toMatchObject({
			notes: [],
			reason: withheld,
		});
		expect(payload(records.check("e".repeat(64), checks[2]!, [])).result).toEqual({
			name: "static.mutation",
			status: "skipped",
			reason: withheld,
			cause: null,
		});
	});

	it.each(["2.3.4", "6.0.0-dev.20261101", "unavailable"])("keeps the version %s a check ran with", (version) => {
		for (const status of ["ran", "provisional"] as const) {
			const result = { name: "static.biome", status, findings: 0, notes: [], version, reason: "" } as CheckRunRecord;
			expect((payload(records.check("e".repeat(64), result, [])).result as { version: string }).version).toBe(
				version,
			);
		}
	});

	it("exports a check whose version it withholds with the sightings that name that version", () => {
		const result = {
			name: "static.biome",
			status: "ran",
			findings: 1,
			notes: [],
			version: "1.2.3+build",
		} as CheckRunRecord;
		const exported = payload(records.check("e".repeat(64), result, [sighting("1.2.3+build")]));
		expect((exported.result as { version: string }).version).toBe(withheld);
		expect((exported.sightings as StoredFinding[])[0]!.properties.source).toEqual({
			check: "static.biome",
			version: withheld,
		});
	});

	it("exports a sighting of a check that names no version as it was found", () => {
		const finding = sighting(undefined, "guardrails");
		const result = { name: "guardrails", status: "ran", findings: 1, notes: [] } as CheckRunRecord;
		expect((payload(records.check("e".repeat(64), result, [finding])).sightings as StoredFinding[])[0]).toStrictEqual(
			finding,
		);
	});

	it("keeps a lens's own version where a finding's source names it", () => {
		const finding = sighting("0123456789ab@careful", "lens.security");
		const claims = [{ id: finding.properties.id, source: finding.properties.source, verification: verdict }];
		const record = records.verification("f".repeat(64), { claims, dismissals: [], outcomes: [] });
		expect((payload(record).claims as { source: unknown }[])[0]!.source).toEqual({
			check: "lens.security",
			version: "0123456789ab@careful",
		});
		const producers = [{ check: "lens.security", version: "0123456789ab@careful" }];
		const account = payload(
			records.account({ checks: [], records: [], filled: [], allowSkip: [], producers, resolutionPolicy: null }),
		);
		expect((account.producers as { version: string }[])[0]!.version).toBe("0123456789ab@careful");
	});

	it.each([
		[["b".repeat(16)], ["a".repeat(16)], ["a".repeat(16), "b".repeat(16)]],
		[["a".repeat(16)], undefined, null],
		[undefined, ["b".repeat(16)], null],
	])("unites the ids %j and %j of two producers whose versions it withholds", (first, second, ids) => {
		const producers = [
			{ check: "static.biome", version: "v1", ...(first === undefined ? {} : { ids: first }) },
			{ check: "static.biome", version: "v2", ...(second === undefined ? {} : { ids: second }) },
		];
		const account = payload(
			records.account({ checks: [], records: [], filled: [], allowSkip: [], producers, resolutionPolicy: null }),
		);
		expect(account.producers).toEqual([{ check: "static.biome", version: withheld, ids }]);
	});

	it("keeps apart two producers of one check whose versions it keeps", () => {
		const producers = [
			{ check: "lens.security", version: "bbbbbbbbbbbb@careful" },
			{ check: "lens.security", version: "aaaaaaaaaaaa@careful" },
		];
		const account = payload(
			records.account({ checks: [], records: [], filled: [], allowSkip: [], producers, resolutionPolicy: null }),
		);
		expect(account.producers).toEqual([
			{ check: "lens.security", version: "aaaaaaaaaaaa@careful", ids: null },
			{ check: "lens.security", version: "bbbbbbbbbbbb@careful", ids: null },
		]);
	});

	it("keeps a version of 64 characters and withholds one of 65", () => {
		const of = (length: number) => `1.0.0-${"a".repeat(length - 6)}`;
		const exported = (version: string) =>
			(
				payload(
					records.check(
						"e".repeat(64),
						{ name: "static.biome", status: "ran", findings: 0, notes: [], version } as CheckRunRecord,
						[],
					),
				).result as { version: string }
			).version;
		expect(exported(of(64))).toBe(of(64));
		expect(exported(of(65))).toBe(withheld);
	});

	it("writes a check that names no version with a null version", () => {
		const result = { name: "static.biome", status: "ran", findings: 0, notes: [] } as CheckRunRecord;
		expect((payload(records.check("e".repeat(64), result, [])).result as { version: unknown }).version).toBeNull();
	});

	it.each(["v2.3.4", "2.3", "2.3.4 "])("withholds %j, which is not a version in its own form", (version) => {
		const result = { name: "static.biome", status: "ran", findings: 0, notes: [], version } as CheckRunRecord;
		expect((payload(records.check("e".repeat(64), result, [])).result as { version: string }).version).toBe(withheld);
	});

	it("keeps the code of a check no record holds", () => {
		const record = records.account({
			checks: ["static.enola"],
			records: [],
			filled: [{ name: "static.enola", status: "skipped", reason: "no record" }],
			allowSkip: [],
			producers: [],
			resolutionPolicy: null,
		});
		expect(payload(record).filled).toEqual([
			decided({ name: "static.enola", status: "skipped", reason: "no record" }),
		]);
	});

	it("keeps Melian's own caveats and withholds the rest of a lens's text", () => {
		const check: CheckRecord = {
			name: "lens.correctness",
			version: "0123456789ab",
			level: "careful",
			status: "failed",
			reason: token,
			error: token,
			caveats: [`${blindCallers}: ${token}`, lightTriage, token],
		};
		const record = records.lens(run, { status: "unanswered", reason: token }, [], check);
		expect(payload(record).outcome).toEqual({ status: "unanswered", reason: withheld });
		expect(payload(record).check).toEqual(
			decided({
				name: "lens.correctness",
				version: "0123456789ab",
				level: "careful",
				status: "failed",
				reason: withheld,
				error: withheld,
				caveats: [blindCallers, lightTriage, withheld],
			}),
		);
	});

	it("withholds a verifier candidate's reason and a triage failure, and keeps their codes", () => {
		const record = records.verification("f".repeat(64), {
			claims: [],
			dismissals: [],
			outcomes: [
				{ candidate: "3333333333333333", outcome: { status: "done", model: "openai-codex/sol" } },
				{ candidate: "1111111111111111", outcome: { status: "unanswered", reason: token } },
				{ candidate: "2222222222222222", outcome: { status: "exhausted", reason: "timeout" } },
			],
		});
		expect(payload(record).outcomes).toEqual([
			{ candidate: "1111111111111111", outcome: { status: "unanswered", reason: withheld } },
			{ candidate: "2222222222222222", outcome: { status: "exhausted", reason: "timeout" } },
			{ candidate: "3333333333333333", outcome: { status: "done", model: "openai-codex/sol" } },
		]);
		expect(payload(records.triage("f".repeat(64), { failure: token })).failure).toBe(withheld);
		expect(payload(records.triage("f".repeat(64), {})).failure).toBeNull();
	});

	it("keeps the routes a lens that gave up tried, and withholds why it gave up", () => {
		const outcome = { status: "exhausted", tried: ["openai-codex/gpt", "anthropic/claude"], reason: token } as const;
		expect(payload(records.lens(run, outcome, [])).outcome).toEqual({
			status: "exhausted",
			tried: ["openai-codex/gpt", "anthropic/claude"],
			reason: withheld,
		});
	});

	it("leaves a lens record's absent reason and error absent", () => {
		const record = records.lens(run, { status: "done" }, [], {
			name: "lens.correctness",
			status: "ran",
			version: "0123456789ab",
			level: "careful",
		});
		expect(payload(record).check).toEqual(
			decided({ name: "lens.correctness", status: "ran", version: "0123456789ab", level: "careful" }),
		);
	});
});

describe("a walkthrough record exports the review's content", () => {
	// Each key a walkthrough has, decided: a new one fails to compile here until someone says whether a record carries it.
	const exported: Record<keyof Walkthrough, true> = { summary: true, files: true, diagram: true, note: true };
	const exportedFile: Record<keyof Walkthrough["files"][number], true> = { path: true, summary: true };

	it("carries every field a model wrote, as written", () => {
		const walkthrough: Required<Walkthrough> = {
			summary: `the change ${token}`,
			files: [{ path: "src/a.ts", summary: `a file ${token}` }],
			diagram: `graph ${token}`,
			note: `a note ${token}`,
		};
		const shown = payload(records.walkthrough("f".repeat(64), "openai-codex/sol", walkthrough));
		expect(shown).toEqual({ v: 1, route: "openai-codex/sol", ...walkthrough });
		expect(Object.keys(shown).sort()).toEqual(["route", "v", ...Object.keys(exported)].sort());
		expect(Object.keys((shown.files as object[])[0]!).sort()).toEqual(Object.keys(exportedFile).sort());
	});

	it("writes an absent diagram and note as null", () => {
		const shown = payload(records.walkthrough("f".repeat(64), "r", { summary: "s", files: [] }));
		expect(shown).toEqual({ v: 1, route: "r", summary: "s", files: [], diagram: null, note: null });
	});
});

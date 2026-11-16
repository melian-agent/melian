import type { CheckRecord, SharedRecord } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { blindCallers, lightTriage } from "../src/caveats.ts";
import type { CheckRunRecord } from "../src/checks.ts";
import { ReviewRecords, withheld } from "../src/review-records.ts";

// Text a tool, a provider or the head's code wrote, such as a login one of them read.
const token = "melian-test-token-5f1e2d";
const records = ReviewRecords.of("c".repeat(64), { base: "a".repeat(40), head: "b".repeat(40) });
const bytes = (record: SharedRecord) => JSON.stringify(record.toJSON());
const payload = (record: SharedRecord) => record.toJSON().payload as Record<string, unknown>;

const run = { name: "correctness", version: "1", level: "careful", request: "d".repeat(64), probe: false } as const;
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

	it("as a lens that did not answer, gave up, or failed with a provider's message and caveats", () => {
		const check: CheckRecord = {
			name: "lens.correctness",
			version: "1",
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
			outcomes: [{ candidate: "anthropic/claude", outcome: { status: "unanswered", reason: token } }],
			check: { name: "verifier", status: "failed", reason: token, error: token },
		});
		expect(bytes(record)).not.toContain(token);
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

	it("keeps the code of a check no record holds", () => {
		const record = records.account({
			checks: ["static.enola"],
			records: [],
			filled: [{ name: "static.enola", status: "skipped", reason: "no record" }],
			allowSkip: [],
			producers: [],
		});
		expect(payload(record).filled).toEqual([
			decided({ name: "static.enola", status: "skipped", reason: "no record" }),
		]);
	});

	it("keeps Melian's own caveats and withholds the rest of a lens's text", () => {
		const check: CheckRecord = {
			name: "lens.correctness",
			version: "1",
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
				version: "1",
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
				{ candidate: "anthropic/claude", outcome: { status: "unanswered", reason: token } },
				{ candidate: "openai-codex/gpt", outcome: { status: "exhausted", reason: "timeout" } },
				{ candidate: "openai-codex/sol", outcome: { status: "done", model: "openai-codex/sol" } },
			],
		});
		expect(payload(record).outcomes).toEqual([
			{ candidate: "anthropic/claude", outcome: { status: "unanswered", reason: withheld } },
			{ candidate: "openai-codex/gpt", outcome: { status: "exhausted", reason: "timeout" } },
			{ candidate: "openai-codex/sol", outcome: { status: "done", model: "openai-codex/sol" } },
		]);
		expect(payload(records.triage("f".repeat(64), { failure: token })).failure).toBe(withheld);
		expect(payload(records.triage("f".repeat(64), {})).failure).toBeNull();
	});

	it("leaves a lens record's absent reason and error absent", () => {
		const record = records.lens(run, { status: "done" }, [], {
			name: "lens.correctness",
			status: "ran",
			version: "1",
			level: "careful",
		});
		expect(payload(record).check).toEqual(
			decided({ name: "lens.correctness", status: "ran", version: "1", level: "careful" }),
		);
	});
});

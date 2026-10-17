import {
	type ConversationId,
	backgroundContext as context,
	createMemoryStorage,
	type DocumentRecord,
	type EntryId,
	type JsonObject,
	ROOT_CONVERSATION_ID,
	type Storage,
	type SubmissionId,
	type TaskId,
	UsageDoc,
} from "@melian-agent/pipeline";
import { afterEach, expect, it, vi } from "vitest";
import { CheckSources, ChecksDocument } from "../src/checks.ts";
import { DecisionDocument } from "../src/decisions.ts";
import { LensDocument } from "../src/lens-tools.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { SummaryIndex } from "../src/summarize.ts";
import { TimingDocument } from "../src/task-timing.ts";
import { StageTelemetry, TelemetryReader } from "../src/telemetry.ts";
import { ModelAttemptsDocument } from "../src/token-usage.ts";

type Task = NonNullable<Awaited<ReturnType<Storage["task"]>>>;
type Snapshot = NonNullable<Awaited<ReturnType<Storage["document"]>>>;
const revision = "base..head";
const fixtures: ReaderFixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.storage.close(context);
	vi.restoreAllMocks();
});

class ReaderFixture {
	readonly storage = createMemoryStorage();
	readonly tasks = new Map<number, Task>();
	private readonly documents: { record: DocumentRecord; snapshot: Snapshot }[] = [];
	constructor() {
		fixtures.push(this);
		vi.spyOn(this.storage, "findDocument").mockImplementation(
			async (address) =>
				this.documents.find(
					({ record }) =>
						record.kind === address.kind &&
						record.key === address.key &&
						JSON.stringify(record.scope) === JSON.stringify(address.scope),
				)?.record,
		);
		vi.spyOn(this.storage, "document").mockImplementation(
			async (id) => this.documents.find(({ record }) => record.id === id)?.snapshot,
		);
		vi.spyOn(this.storage, "task").mockImplementation(async (id) => this.tasks.get(id));
	}
	document(
		token: { definition: { kind: string; version: number } },
		value: JsonObject,
		key?: string,
		conversationId = ROOT_CONVERSATION_ID,
	) {
		const id = this.documents.length + 1;
		this.documents.push({
			record: {
				id,
				kind: token.definition.kind,
				key,
				scope: { kind: "conversation", conversationId },
				createdAt: 1,
				history: "latest",
				fork: "current",
			} as DocumentRecord,
			snapshot: { version: token.definition.version, value } as Snapshot,
		});
	}
	task(id: number, state: Task["state"], extra: Partial<Task> = {}) {
		this.tasks.set(id, {
			id: id as TaskId,
			conversationId: ROOT_CONVERSATION_ID,
			kind: "test",
			version: 1,
			input: null,
			background: false,
			abortRequested: false,
			state,
			...extra,
		} as Task);
	}
	triage(id: number, failure?: string) {
		this.document(DecisionDocument, {
			decisions: {
				[revision]: { triage: { task: id, key: "test", ...(failure === undefined ? {} : { failure }) } },
			},
		});
	}
	async read(before?: number) {
		return TelemetryReader.open(this.storage).read(revision, before);
	}
}

it.each(["terminal", "completing"] as const)("projects %s outcomes and incomplete intervals", async (status) => {
	const fixture = new ReaderFixture();
	fixture.document(ReviewIndex, { reviews: { [revision]: { lenses: [], adjudication: { task: 1, input: "{}" } } } });
	fixture.task(1, { status, outcome: { status: "completed", result: null } });
	const row = (await fixture.read()).stages[0]!;
	expect(row).toMatchObject({ outcome: "completed", timing: "unavailable", reused: false, resumed: false });
	expect(row.durationMs).toBeUndefined();
	expect(row.clockRegressed).toBeUndefined();
});

it("omits the end property when no end was recorded", async () => {
	const fixture = new ReaderFixture();
	fixture.triage(1);
	fixture.task(1, { status: "running", checkpoint: { phase: "run" } });
	fixture.document(TimingDocument, { startedAt: 0 }, "1");
	const row = (await fixture.read()).stages[0]!;
	expect(row).toMatchObject({ outcome: "running", timing: "available", startedAt: 0 });
	expect(row).not.toHaveProperty("endedAt");
});

it.each([
	[{ status: "completed", result: "superseded" }, "superseded"],
	[{ status: "completed", result: { kind: "superseded" } }, "superseded"],
	[{ status: "completed", result: { kind: "staleTarget" } }, "failed"],
	[{ status: "failed", error: { message: "failed task" } }, "failed"],
	[{ status: "aborted" }, "aborted"],
] as const)("projects task result %j", async (outcome, expected) => {
	const fixture = new ReaderFixture();
	fixture.triage(1);
	fixture.task(1, { status: "terminal", outcome });
	const row = (await fixture.read()).stages[0]!;
	expect(row.outcome).toBe(expected);
	expect(row.error).toBe(outcome.status === "failed" ? "failed task" : undefined);
});

it.each([
	[{ status: "skipped", cause: "timeout", reason: "deadline" }, "timed-out"],
	[{ status: "skipped", cause: "unavailable", reason: "no executable" }, "skipped"],
	[{ status: "failed", error: "tool failed" }, "failed"],
	[{ status: "ran", findings: [] as JsonObject[] }, "completed"],
	[{ status: "provisional", reason: "cached" }, "provisional"],
] as const)("projects untimed check %j", async (record, outcome) => {
	const fixture = new ReaderFixture();
	fixture.document(ChecksDocument, {
		tasks: { "base head first": 9 },
		runs: { "base head first 9": { "static.biome": record } },
	});
	const row = (await fixture.read()).stages[0]!;
	expect(row).toMatchObject({ task: 9, subject: "static.biome", outcome, reused: false, resumed: false });
	expect(row.error).toBe(record.status === "failed" ? "tool failed" : undefined);
	expect(row.durationMs).toBeUndefined();
});

it("uses recorded triage failures and the latest matching legacy check parent", async () => {
	const fixture = new ReaderFixture();
	fixture.triage(1, "triage failed");
	fixture.task(1, { status: "terminal", outcome: { status: "completed", result: "recorded" } });
	fixture.document(ChecksDocument, {
		tasks: { "other head irrelevant": 99, "base head old": 2, "base head new": 3 },
		runs: { "base head new 3": { "static.biome": { status: "ran", findings: [] } } },
	});
	const rows = (await fixture.read()).stages;
	expect(rows[0]).toMatchObject({ outcome: "failed", error: "triage failed" });
	expect(rows[1]).toMatchObject({ task: 3, subject: "static.biome" });
	expect(rows).toHaveLength(2);
});

it.each(["running", "failed", "completed"] as const)(
	"reads a %s source check without inventing its result",
	async (status) => {
		const fixture = new ReaderFixture();
		fixture.document(ChecksDocument, {
			tasks: { "base head recent": 8, "base head selected": 3 },
			owners: { [revision]: "base head selected 3" },
			runs: {},
		});
		fixture.document(CheckSources, { tasks: { "static.biome": 2 } }, "3");
		fixture.task(
			2,
			status === "running"
				? { status: "running", checkpoint: { phase: "run" } }
				: {
						status: "terminal",
						outcome:
							status === "completed"
								? { status: "completed", result: { status: "skipped", cause: "timeout", reason: "deadline" } }
								: { status: "failed", error: { message: "check fault" } },
					},
			{ owner: 3 as TaskId },
		);
		const row = (await fixture.read()).stages[0]!;
		expect(row).toMatchObject({ task: 2, outcome: status === "completed" ? "timed-out" : status, reused: false });
		expect(row.error).toBe(status === "failed" ? "check fault" : undefined);
	},
);

it.each([
	[
		{ status: "failed", error: { message: "check fault" }, result: { status: "ran", findings: [] as JsonObject[] } },
		{ outcome: "failed", error: "check fault" },
	],
	[{ status: "aborted", result: { status: "ran", findings: [] as JsonObject[] } }, { outcome: "aborted" }],
] as const)("preserves check outcome %j over its partial result", async (outcome, expected) => {
	const fixture = new ReaderFixture();
	fixture.document(ChecksDocument, {
		tasks: { "base head selected": 3 },
		owners: { [revision]: "base head selected 3" },
		runs: {},
	});
	fixture.document(CheckSources, { tasks: { "static.biome": 2 } }, "3");
	fixture.task(2, { status: "terminal", outcome }, { owner: 3 as TaskId });
	expect((await fixture.read()).stages).toEqual([expect.objectContaining(expected)]);
});

it.each([undefined, 0, 1])("keeps exact rendered spacing with %s incomplete requests", (count) => {
	const telemetry = new StageTelemetry(revision, [
		{
			id: "task:1",
			task: 1,
			name: "triage",
			subject: "test",
			outcome: "completed",
			timing: "available",
			startedAt: 0,
			endedAt: 5,
			durationMs: 5,
			reused: false,
			resumed: false,
			usageIncomplete: count,
		},
	]);
	expect(telemetry.render()).toBe(
		count === 1
			? "triage test completed start=0 end=5 duration=5ms (usage incomplete: 1 request(s) not measured)\nTotal: Token usage unavailable (usage incomplete: 1 request(s) not measured).\n"
			: "triage test completed start=0 end=5 duration=5ms\nTotal: Token usage unavailable.\n",
	);
});

it.each([false, true])("reads modern and legacy deterministic timing (legacy=%s)", async (legacy) => {
	const fixture = new ReaderFixture();
	fixture.triage(1);
	fixture.task(1, { status: "terminal", outcome: { status: "completed", result: "recorded" } });
	fixture.document(TimingDocument, { startedAt: 0, endedAt: 10, ...(legacy ? { legacy: true } : {}) }, "1");
	const row = (await fixture.read(20)).stages[0]!;
	expect(row.startedAt).toBe(legacy ? undefined : 0);
	expect(row.durationMs).toBe(legacy ? undefined : 10);
	expect(row.reused).toBe(true);
});

it("ignores old publications without a target and follows the publication cursor and query", async () => {
	const fixture = new ReaderFixture();
	fixture.task(1, { status: "terminal", outcome: { status: "completed", result: null } }, { input: {} });
	fixture.task(
		2,
		{ status: "terminal", outcome: { status: "completed", result: null } },
		{ input: { target: { revision } } },
	);
	vi.spyOn(fixture.storage, "scanTasks").mockImplementation(async (query, limit, cursor) => {
		expect(query).toEqual({ kind: "melian.publish" });
		expect(limit).toBe(200);
		if (cursor === undefined) return { items: [fixture.tasks.get(1)!], next: { after: 1 } };
		expect(cursor).toEqual({ after: 1 });
		return { items: [fixture.tasks.get(2)!] };
	});
	expect((await fixture.read()).stages).toEqual([expect.objectContaining({ task: 2, reused: false, resumed: false })]);
});

it("follows conversation cursors with the selected owner's query", async () => {
	const fixture = new ReaderFixture();
	fixture.document(SummaryIndex, { tasks: { [revision]: 1 }, counted: {} });
	fixture.task(1, { status: "terminal", outcome: { status: "completed", result: null } });
	vi.spyOn(fixture.storage, "scanConversations").mockImplementation(async (query, limit, cursor) => {
		expect(query).toEqual({ ownerTaskId: 1 });
		expect(limit).toBe(200);
		if (cursor === undefined) return { items: [], next: { after: 1 } };
		expect(cursor).toEqual({ after: 1 });
		return { items: [{ id: 2 as ConversationId }] as Awaited<ReturnType<Storage["scanConversations"]>>["items"] };
	});
	const rows = (await fixture.read()).stages;
	expect(rows).toEqual([expect.objectContaining({ name: "melian.walkthrough", conversation: 2 })]);
});

it.each(["missing", "no-model", "empty-model"])(
	"reads a %s input entry without a fabricated timestamp",
	async (shape) => {
		const fixture = new ReaderFixture();
		fixture.document(SummaryIndex, { tasks: { [revision]: 1 }, counted: {} });
		fixture.task(1, { status: "terminal", outcome: { status: "completed", result: null } });
		vi.spyOn(fixture.storage, "scanConversations").mockImplementation(async (query) => {
			expect(query).toEqual({ ownerTaskId: 1 });
			return { items: [{ id: 2 as ConversationId }] as Awaited<ReturnType<Storage["scanConversations"]>>["items"] };
		});
		vi.spyOn(fixture.storage, "scanSubmissions").mockImplementation(async (query) => {
			expect(query).toEqual({ conversationId: 2 });
			return {
				items: [
					{
						id: 1 as SubmissionId,
						conversationId: 2 as ConversationId,
						type: "input",
						status: "placed",
						entry: 3 as EntryId,
					},
				] as Awaited<ReturnType<Storage["scanSubmissions"]>>["items"],
			};
		});
		vi.spyOn(fixture.storage, "entry").mockImplementation(async (id) => {
			expect(id).toBe(3);
			return shape === "missing"
				? undefined
				: ({ entry: shape === "no-model" ? {} : { model: [] } } as NonNullable<
						Awaited<ReturnType<Storage["entry"]>>
					>);
		});
		const row = (await fixture.read()).stages[0]!;
		expect(row.startedAt).toBeUndefined();
		expect(row.durationMs).toBeUndefined();
	},
);

it.each(["quick", undefined])("reads verification claim IDs and lens subjects at level %s", async (level) => {
	const fixture = new ReaderFixture();
	fixture.document(ReviewIndex, {
		reviews: { [revision]: { task: 1, lenses: [], verification: { task: 2, input: "{}" } } },
	});
	fixture.task(1, { status: "terminal", outcome: { status: "completed", result: null } });
	fixture.task(2, { status: "terminal", outcome: { status: "completed", result: null } });
	fixture.document(
		LensDocument,
		{ lens: { name: "correctness", version: "v1", ...(level === undefined ? {} : { level }) } },
		undefined,
		3 as ConversationId,
	);
	fixture.document(
		LensDocument,
		{ lens: { claims: [{ id: "first" }, { id: "second" }] } },
		undefined,
		4 as ConversationId,
	);
	vi.spyOn(fixture.storage, "scanConversations").mockImplementation(async (query) => {
		if (query.ownerTaskId === 1)
			return { items: [{ id: 3 as ConversationId }] as Awaited<ReturnType<Storage["scanConversations"]>>["items"] };
		expect(query).toEqual({ ownerTaskId: 2 });
		return { items: [{ id: 4 as ConversationId }] as Awaited<ReturnType<Storage["scanConversations"]>>["items"] };
	});
	expect((await fixture.read()).stages.map(({ subject }) => subject)).toEqual([
		`correctness@v1@${level ?? "legacy"}`,
		"first,second",
	]);
});

it("refuses an unsupported old checks document instead of treating it as current", async () => {
	const fixture = new ReaderFixture();
	const migrate = vi.spyOn(ChecksDocument.definition, "migrate");
	fixture.document({ definition: { kind: ChecksDocument.definition.kind, version: 2 } }, { tasks: {}, runs: {} });
	await expect(fixture.read()).rejects.toThrow("the checks document needs migrating from version 2");
	expect(migrate).toHaveBeenCalledWith({ tasks: {}, runs: {} }, 2);
});

it("preserves every Pi counter per model and sums conversations once, including absent optional counters", async () => {
	const fixture = new ReaderFixture();
	fixture.document(SummaryIndex, { tasks: { [revision]: 1 }, counted: {} });
	fixture.task(1, { status: "terminal", outcome: { status: "completed", result: null } });
	vi.spyOn(fixture.storage, "scanConversations").mockImplementation(async (query) => {
		expect(query).toEqual({ ownerTaskId: 1 });
		return {
			items: [{ id: 2 as ConversationId }, { id: 3 as ConversationId }] as Awaited<
				ReturnType<Storage["scanConversations"]>
			>["items"],
		};
	});
	const one = {
		input: 11,
		output: 7,
		cacheRead: 13,
		cacheWrite: 5,
		reasoning: 3,
		cacheWrite1h: 2,
		totalTokens: 36,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
	};
	const two = {
		input: 2,
		output: 3,
		cacheRead: 4,
		cacheWrite: 1,
		totalTokens: 10,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
	};
	fixture.document(UsageDoc, { models: { "provider/model": one }, tools: {} }, undefined, 2 as ConversationId);
	fixture.document(UsageDoc, { models: { "provider/model": two }, tools: {} }, undefined, 3 as ConversationId);
	const telemetry = await fixture.read();
	expect(telemetry.render()).toContain("provider/model: input=11 output=7");
	expect(telemetry.render()).toContain("provider/model: input=2 output=3");
	expect(telemetry.render()).toContain(
		"provider/model: input=13 output=10 cache-read=17 cache-write=6 reasoning=3 cache-write-1h=2",
	);
	expect(telemetry.stages[0]!.usage).toMatchObject({ models: { "provider/model": one } });
	expect(telemetry.toJSON()).toMatchObject({
		total: {
			models: {
				"provider/model": {
					input: 13,
					output: 10,
					cacheRead: 17,
					cacheWrite: 6,
					reasoning: 3,
					cacheWrite1h: 2,
					totalTokens: 46,
					cost: { input: 1.1, output: 2.2, cacheRead: 3.3, cacheWrite: 4.4, total: 11 },
				},
			},
			total: {
				input: 13,
				output: 10,
				cacheRead: 17,
				cacheWrite: 6,
				totalTokens: 46,
				reasoning: 3,
				cost: { total: 11 },
			},
		},
		usageUnavailable: [],
	});
});

it("sums the selected stages into a run total without altering their per-model records", () => {
	const one = {
		input: 11,
		output: 7,
		cacheRead: 13,
		cacheWrite: 5,
		reasoning: 3,
		cacheWrite1h: 2,
		totalTokens: 97,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 99 },
	};
	const total = {
		input: 22,
		output: 14,
		cacheRead: 26,
		cacheWrite: 10,
		reasoning: 6,
		cacheWrite1h: 4,
		totalTokens: 194,
		cost: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 198 },
	};
	const base = {
		task: 1,
		subject: "test",
		name: "melian.lens",
		outcome: "completed",
		timing: "unavailable" as const,
		reused: false,
		resumed: false,
		usage: { models: { model: one }, total: one },
	};
	const telemetry = new StageTelemetry(revision, [
		{ ...base, id: "first" },
		{ ...base, id: "second", reused: true },
	]);
	expect(telemetry.toJSON()).toMatchObject({ total: { models: { model: total }, total }, usageUnavailable: [] });
	expect(telemetry.stages.map((stage) => stage.usage)).toEqual([base.usage, base.usage]);
});

it.each([0, 1, 2])("reads the missing-request count %i without inventing a zero marker", async (count) => {
	const fixture = new ReaderFixture();
	fixture.triage(1);
	fixture.task(1, { status: "terminal", outcome: { status: "completed", result: "recorded" } });
	fixture.document(ModelAttemptsDocument, { started: 3, unmeasured: count }, "1");
	const telemetry = await fixture.read();
	const row = telemetry.stages[0]!;
	if (count === 0) {
		expect(row).not.toHaveProperty("usageIncomplete");
		expect(telemetry.toJSON()).not.toHaveProperty("usageIncomplete");
	} else {
		expect(row).toHaveProperty("usageIncomplete", count);
		expect(telemetry.toJSON()).toHaveProperty("usageIncomplete", count);
	}
});

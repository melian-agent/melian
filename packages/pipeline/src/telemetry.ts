import { deterministicChecks, visibleText } from "@melian-agent/core";
import { type CheckRunRecord, CheckSources, ChecksDocument } from "./checks.ts";
import { DecisionDocument } from "./decisions.ts";
import {
	backgroundContext,
	type Context,
	type ConversationId,
	type DocumentRecord,
	type EntryId,
	type JsonObject,
	ROOT_CONVERSATION_ID,
	type Storage,
	type TaskId,
	UsageDoc,
} from "./harness.ts";
import { LensDocument } from "./lens-tools.ts";
import { ReviewIndex } from "./review-index.ts";
import { SummaryIndex } from "./summarize.ts";
import { TimingDocument } from "./task-timing.ts";

type TaskRecord = NonNullable<Awaited<ReturnType<Storage["task"]>>>;
type DocumentScope = DocumentRecord["scope"];
type Doc<T> = {
	definition: { kind: string; version: number; migrate?: (value: JsonObject, from: number) => T };
};

function interval(
	startedAt: number | undefined,
	endedAt: number | undefined,
): Pick<Stage, "startedAt" | "endedAt" | "durationMs" | "clockRegressed" | "timing" | "note"> {
	return {
		...(startedAt === undefined
			? ({ timing: "unavailable", note: "No start recorded by the older build, or stage not started." } as const)
			: ({ timing: "available", startedAt } as const)),
		...(endedAt === undefined ? {} : { endedAt }),
		...(startedAt === undefined || endedAt === undefined
			? {}
			: { durationMs: Math.max(0, endedAt - startedAt), clockRegressed: endedAt < startedAt }),
	};
}

function outcome(task: TaskRecord): { outcome: string; error?: string } {
	const state = task.state;
	if (state.status !== "terminal" && state.status !== "completing") return { outcome: "running" };
	const result = state.outcome;
	if (result.status !== "completed")
		return { outcome: result.status, ...("error" in result ? { error: result.error!.message } : {}) };
	const kind = (result.result as { kind?: string } | null)?.kind;
	if (result.result === "superseded" || kind === "superseded") return { outcome: "superseded" };
	if (kind === "staleTarget") return { outcome: "failed" };
	return { outcome: "completed" };
}

function checkOutcome(record: CheckRunRecord): { outcome: string; error?: string } {
	switch (record.status) {
		case "ran":
			return { outcome: "completed" };
		case "skipped":
			return { outcome: record.cause === "timeout" ? "timed-out" : "skipped" };
		case "failed":
			return { outcome: "failed", error: record.error };
		case "provisional":
			return { outcome: "provisional" };
	}
}

/** One durable stage, projected without changing its source records. */
export type Stage = {
	id: string;
	name: string;
	subject: string;
	task: number;
	conversation?: number;
	outcome: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	timing: "available" | "unavailable";
	note?: string;
	error?: string;
	clockRegressed?: boolean;
	reused: boolean;
	resumed: boolean;
	usage?: { models: string[]; tokens: number; cost: number };
};

/** The stages selected for one revision, with terminal renderings. */
export class StageTelemetry {
	readonly revision: string;
	readonly stages: readonly Stage[];

	constructor(revision: string, stages: readonly Stage[]) {
		this.revision = revision;
		this.stages = stages;
	}

	/** Plain JSON beside a verdict, never part of its identity. */
	toJSON(): { revision: string; stages: readonly Stage[] } {
		return { revision: this.revision, stages: this.stages };
	}

	/** Up to three slowest ended intervals. */
	slowest(): string {
		const ranked = this.stages
			.filter((stage) => stage.durationMs !== undefined)
			.toSorted(
				(a, b) =>
					b.durationMs! - a.durationMs! || a.name.localeCompare(b.name) || a.subject.localeCompare(b.subject),
			)
			.slice(0, 3);
		if (ranked.length === 0) return "melian: Stage timings unavailable.\n";
		return `melian: Slowest stages: ${ranked.map((stage) => `${visibleText(stage.name)} ${visibleText(stage.subject)} ${stage.durationMs}ms${stage.reused ? " (reused)" : stage.resumed ? " (resumed)" : ""}`).join("; ")}.\n`;
	}

	/** The full local timing view. */
	render(): string {
		return `${this.stages
			.map((stage) =>
				visibleText(
					[
						stage.name,
						stage.subject,
						stage.outcome,
						`start=${stage.startedAt ?? "unavailable"}`,
						`end=${stage.endedAt ?? "unavailable"}`,
						`duration=${stage.durationMs ?? "unavailable"}ms`,
						stage.reused ? "reused" : stage.resumed ? "resumed" : "",
						stage.note,
						stage.error,
						stage.usage === undefined
							? ""
							: `${stage.usage.models.join(", ")}: ${stage.usage.tokens} tokens, $${stage.usage.cost}`,
						stage.clockRegressed ? "clock regressed" : "",
					]
						.filter(Boolean)
						.join(" "),
				),
			)
			.join("\n")}\n`;
	}
}

/** Reads durable records without opening a harness or scheduler. */
export class TelemetryReader {
	private readonly storage: Storage;

	private constructor(storage: Storage) {
		this.storage = storage;
	}

	/** The caller owns and closes storage. */
	static open(storage: Storage): TelemetryReader {
		return new TelemetryReader(storage);
	}

	/** Select the revision's stages, marking reuse against the optional call start. */
	async read(revision: string, before?: number, context: Context = backgroundContext): Promise<StageTelemetry> {
		const scope = { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } as const;
		const index = await this.document(ReviewIndex, scope, context);
		const selected = index?.reviews[revision];
		const decisions = await this.document(DecisionDocument, scope, context);
		const summaries = await this.document(SummaryIndex, scope, context);
		const checks = await this.document(ChecksDocument, scope, context);
		const rows: Stage[] = [];
		for (const entry of Object.values(decisions?.decisions[revision] ?? {})) {
			const task = (await this.storage.task(entry.task as TaskId, context))!;
			rows.push(
				await this.deterministic(
					task,
					"melian.triage",
					"triage",
					before,
					false,
					context,
					entry.failure === undefined ? undefined : { outcome: "failed", error: entry.failure },
				),
			);
		}
		const authority = checks?.owners?.[revision];
		const prefix = `${revision.replace("..", " ")} `;
		const parent =
			authority === undefined
				? Object.entries(checks?.tasks ?? {})
						.filter(([key]) => key.startsWith(prefix))
						.toSorted((a, b) => b[1] - a[1])[0]?.[1]
				: Number(authority.split(" ").at(-1));
		const sources = await this.document(CheckSources, scope, context, String(parent));
		const records =
			Object.entries(checks?.runs ?? {}).find(
				([key]) => key.startsWith(prefix) && key.endsWith(` ${parent}`),
			)?.[1] ?? {};
		const names = new Set([
			...Object.keys(sources?.tasks ?? {}),
			...Object.keys(records).filter((name) => (deterministicChecks as readonly string[]).includes(name)),
		]);
		for (const name of names) {
			const id = sources?.tasks[name];
			if (id === undefined) {
				rows.push({
					id: `check:${parent}:${name}`,
					task: parent!,
					name: "melian.check",
					subject: name,
					...checkOutcome(records[name]!),
					...interval(undefined, undefined),
					reused: false,
					resumed: false,
				});
				continue;
			}
			const task = (await this.storage.task(id as TaskId, context))!;
			const record =
				task.state.status === "terminal" && task.state.outcome.status === "completed"
					? (task.state.outcome.result as CheckRunRecord)
					: undefined;
			rows.push(
				await this.deterministic(
					task,
					"melian.check",
					name,
					before,
					task.owner !== parent,
					context,
					record === undefined ? undefined : checkOutcome(record),
				),
			);
		}
		for (const [id, name] of [
			[selected?.task, "melian.lens"],
			[selected?.verification?.task, "melian.verification.candidate"],
			[summaries?.tasks[revision], "melian.walkthrough"],
		] as const) {
			if (id === undefined) continue;
			const task = (await this.storage.task(id as TaskId, context))!;
			let page = await this.storage.scanConversations({ ownerTaskId: task.id }, 200, undefined, context);
			for (;;) {
				for (const child of page.items) {
					const policy = (
						await this.document(LensDocument, { kind: "conversation", conversationId: child.id }, context)
					)?.lens;
					const subject =
						name === "melian.walkthrough"
							? "walkthrough"
							: name === "melian.lens"
								? `${policy!.name}@${policy!.version}@${policy!.level ?? "legacy"}`
								: policy!.claims!.map(({ id }) => id).join(",");
					rows.push(await this.conversation(task, child.id, name, subject, before, context));
				}
				if (page.next === undefined) break;
				page = await this.storage.scanConversations({ ownerTaskId: task.id }, 200, page.next, context);
			}
		}
		if (selected?.adjudication !== undefined) {
			const task = (await this.storage.task(selected.adjudication.task as TaskId, context))!;
			rows.push(await this.deterministic(task, "melian.adjudication", "adjudication", before, false, context));
		}
		let page = await this.storage.scanTasks({ kind: "melian.publish" }, 200, undefined, context);
		for (;;) {
			for (const task of page.items) {
				const input = task.input as { target?: { revision: string } };
				if (input.target?.revision !== revision) continue;
				rows.push(await this.deterministic(task, "melian.publication", "publication", before, false, context));
			}
			if (page.next === undefined) break;
			page = await this.storage.scanTasks({ kind: "melian.publish" }, 200, page.next, context);
		}
		return new StageTelemetry(revision, rows);
	}

	private async document<T>(
		token: Doc<T>,
		scope: DocumentScope,
		context: Context,
		key?: string,
	): Promise<T | undefined> {
		const record = await this.storage.findDocument({ kind: token.definition.kind, scope, key }, "current", context);
		if (record === undefined) return undefined;
		const stored = (await this.storage.document(record.id, "current", context))!;
		if (stored.version > token.definition.version)
			throw new TelemetryError(`Cannot read newer ${token.definition.kind} version ${stored.version}`);
		return stored.version === token.definition.version
			? (stored.value as T)
			: token.definition.migrate!(stored.value, stored.version);
	}

	private async deterministic(
		task: TaskRecord,
		name: string,
		subject: string,
		before: number | undefined,
		kept: boolean,
		context: Context,
		result = outcome(task),
	): Promise<Stage> {
		const timing = await this.document(
			TimingDocument,
			{ kind: "conversation", conversationId: task.conversationId },
			context,
			String(task.id),
		);
		const startedAt =
			timing?.startedAt ??
			(typeof task.memos?.["telemetry.start"] === "number" ? task.memos["telemetry.start"] : undefined);
		const faulted = result.outcome === "faulted";
		const start = timing?.legacy === true ? undefined : faulted ? task.startedAt : startedAt;
		const end = faulted ? task.endedAt : timing?.endedAt;
		return {
			id: `task:${task.id}`,
			name,
			subject,
			task: task.id,
			...result,
			...interval(start, end),
			...this.attachment(start, end, before, kept),
		};
	}

	private attachment(
		start: number | undefined,
		end: number | undefined,
		before: number | undefined,
		kept = false,
	): Pick<Stage, "reused" | "resumed"> {
		return {
			reused: kept || (before !== undefined && end !== undefined && end < before),
			resumed: before !== undefined && start !== undefined && start < before && (end === undefined || end >= before),
		};
	}

	private async conversation(
		task: TaskRecord,
		id: ConversationId,
		name: string,
		subject: string,
		before: number | undefined,
		context: Context,
	): Promise<Stage> {
		const submissions = [];
		let page = await this.storage.scanSubmissions({ conversationId: id }, 200, undefined, context);
		for (;;) {
			submissions.push(...page.items.filter((entry) => entry.type === "input"));
			if (page.next === undefined) break;
			page = await this.storage.scanSubmissions({ conversationId: id }, 200, page.next, context);
		}
		const first = submissions[0];
		const last = submissions.at(-1);
		const start = first?.entry === undefined ? undefined : await this.timestamp(first.entry, context);
		let end: number | undefined;
		let result = outcome(task);
		if (last?.status === "done") {
			end = await this.timestamp(last.answer, context);
			result = { outcome: "completed" };
		} else if (last?.status === "unanswered") {
			const entries = await this.storage.scanEntries({ conversationId: id }, 1, undefined, context);
			const latest = entries.items[0];
			end = latest === undefined ? undefined : await this.timestamp(latest.id, context);
			result = { outcome: "failed", ...(typeof last.detail === "string" ? { error: last.detail } : {}) };
		}
		const policy = await this.document(LensDocument, { kind: "conversation", conversationId: id }, context);
		if (policy?.spend?.ended !== undefined || policy?.spend?.capped !== undefined) result = { outcome: "ended" };
		if (end === undefined && task.state.status === "terminal" && task.state.outcome.status === "faulted") {
			end = task.endedAt;
			result = outcome(task);
		}
		const usage = await this.document(UsageDoc, { kind: "conversation", conversationId: id }, context);
		return {
			id: `conversation:${id}`,
			name,
			subject,
			task: task.id,
			conversation: id,
			...result,
			...interval(start, end),
			...this.attachment(start, end, before),
			...(usage === undefined
				? {}
				: {
						usage: {
							models: Object.keys(usage.models),
							tokens: Object.values(usage.models).reduce((sum, item) => sum + item.totalTokens, 0),
							cost: Object.values(usage.models).reduce((sum, item) => sum + item.cost.total, 0),
						},
					}),
		};
	}

	private async timestamp(id: EntryId, context: Context): Promise<number | undefined> {
		const entry = await this.storage.entry(id, context);
		return entry?.entry.model?.[0]?.timestamp;
	}
}

/** A stored timing shape this build cannot read. */
export class TelemetryError extends Error {
	readonly code = "unreadable";
}

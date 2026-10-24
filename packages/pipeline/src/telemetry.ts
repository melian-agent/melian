import { deterministicChecks, type ReasoningValue, type RequestReasoning, visibleText } from "@melian-agent/core";
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
import { PrepareDocument, type PrepareRecord } from "./spans.ts";
import { SummaryIndex } from "./summarize.ts";
import { TimingDocument } from "./task-timing.ts";
import { ModelAttemptsDocument, ModelUsageDocument, TokenUsage, type UsageSummary } from "./token-usage.ts";

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
	usage?: UsageSummary;
	usageIncomplete?: number;
	/** For a model stage, the summed response time of its answers; the rest is tools and orchestration. */
	modelMs?: number;
};

/** A stretch of a review's wall clock that no span or stage covers. */
export type Untimed = { startedAt: number; endedAt: number; durationMs: number };

// A gap this long between timed work is worth naming; shorter ones are the orchestrator's own bookkeeping.
const untimedLimitMs = 1000;

function reasoningText(reasoning: RequestReasoning): string {
	const sent = reasoning.sent.map((body) => {
		if (body === "provider default") return body;
		const effort =
			(body.reasoning as { effort?: ReasoningValue } | undefined)?.effort ??
			body["output_config.effort"] ??
			body["additionalModelRequestFields.output_config.effort"] ??
			body.reasoning_effort ??
			body.reasoningEffort;
		return effort === undefined ? `sent=${JSON.stringify(body)}` : `effort=${String(effort)}`;
	});
	const mapped = reasoning.catalogMapped === null ? "provider default" : (reasoning.catalogMapped ?? "unavailable");
	return `requested=${reasoning.requested} ${sent.join(" / ") || `catalogue=${mapped}`} ${reasoning.source}${reasoning.providerReported === undefined ? "" : ` provider-reported=${reasoning.providerReported}`}`;
}

function usageText(usage: UsageSummary): string {
	return Object.entries(usage.models)
		.map(
			([model, usage]) =>
				`${model}: input=${usage.input} output=${usage.output} cache-read=${usage.cacheRead} cache-write=${usage.cacheWrite}${usage.reasoning === undefined ? "" : ` reasoning=${usage.reasoning}`}${usage.cacheWrite1h === undefined ? "" : ` cache-write-1h=${usage.cacheWrite1h}`} ${usage.totalTokens} tokens, $${usage.cost.total}`,
		)
		.join("; ");
}

function incompleteUsage(count: number | undefined): string {
	return count ? ` (usage incomplete: ${count} request(s) not measured)` : "";
}

/** The stages selected for one revision, with terminal renderings. */
export class StageTelemetry {
	readonly revision: string;
	readonly stages: readonly Stage[];
	readonly total?: UsageSummary;
	readonly usageUnavailable: readonly string[];
	readonly usageIncomplete?: number;
	readonly prepare?: PrepareRecord;

	constructor(revision: string, stages: readonly Stage[], prepare?: PrepareRecord) {
		this.revision = revision;
		this.stages = stages;
		if (prepare !== undefined) this.prepare = prepare;
		const unmeasured = stages.reduce((sum, stage) => sum + (stage.usageIncomplete ?? 0), 0);
		if (unmeasured > 0) this.usageIncomplete = unmeasured;
		const usage = new TokenUsage();
		for (const stage of stages) {
			if (stage.usage !== undefined) usage.include(stage.usage);
		}
		if (stages.some((stage) => stage.usage !== undefined)) this.total = usage.toJSON();
		this.usageUnavailable = stages
			.filter(
				(stage) =>
					["melian.triage", "melian.lens", "melian.verification.candidate", "melian.walkthrough"].includes(
						stage.name,
					) && stage.usage === undefined,
			)
			.map((stage) => stage.id);
	}

	/** Plain JSON beside a verdict, never part of its identity. */
	toJSON(): {
		revision: string;
		stages: readonly Stage[];
		total?: UsageSummary;
		usageUnavailable: readonly string[];
		usageIncomplete?: number;
		prepare?: PrepareRecord;
		untimed?: Untimed[];
	} {
		return {
			revision: this.revision,
			stages: this.stages,
			...(this.total === undefined ? {} : { total: this.total }),
			usageUnavailable: this.usageUnavailable,
			...(this.usageIncomplete === undefined ? {} : { usageIncomplete: this.usageIncomplete }),
			...(this.prepare === undefined ? {} : { prepare: this.prepare, untimed: this.untimed() }),
		};
	}

	/** Gaps over a second in the review's wall clock, from its process start to its verdict, that nothing timed. */
	untimed(): Untimed[] {
		if (this.prepare === undefined) return [];
		const { startedAt, endedAt, spans } = this.prepare;
		const timed = [
			...spans,
			// Publication runs in another command, so it covers none of this review's time.
			...this.stages.filter(
				(stage) =>
					stage.name !== "melian.publication" && stage.startedAt !== undefined && stage.endedAt !== undefined,
			),
		].toSorted((a, b) => a.startedAt! - b.startedAt!);
		const gaps: Untimed[] = [];
		let covered = startedAt;
		const gap = (until: number) => {
			if (until - covered > untimedLimitMs)
				gaps.push({ startedAt: covered, endedAt: until, durationMs: until - covered });
		};
		for (const interval of timed) {
			gap(Math.min(interval.startedAt!, endedAt));
			covered = Math.max(covered, interval.endedAt!);
		}
		gap(endedAt);
		return gaps;
	}

	/** The recorded spend, with missing stages named as incomplete coverage. */
	spend(): string {
		if (this.total === undefined) return `Token usage unavailable${incompleteUsage(this.usageIncomplete)}`;
		const models = this.models();
		return `${this.total.total.totalTokens} tokens, $${this.total.total.cost.total}${this.usageUnavailable.length === 0 ? "" : ` (usage unavailable for ${this.usageUnavailable.length} stage${this.usageUnavailable.length === 1 ? "" : "s"})`}${incompleteUsage(this.usageIncomplete)}${models === "" ? "" : `; ${models}`}`;
	}

	/** Recorded reasoning settings, grouped by actual model. */
	models(): string {
		const requests = this.total?.requests ?? [];
		return [...new Set(requests.map((request) => request.model))]
			.map((model) =>
				visibleText(
					`${model} ${[...new Set(requests.filter((request) => request.model === model).map((request) => reasoningText(request.reasoning)))].join("; ")}`,
				),
			)
			.join("; ");
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
		if (ranked.length === 0) return `melian: Stage timings unavailable. Total: ${this.spend()}.\n`;
		return `melian: Slowest stages: ${ranked.map((stage) => `${visibleText(stage.name)} ${visibleText(stage.subject)} ${stage.durationMs}ms${stage.reused ? " (reused)" : stage.resumed ? " (resumed)" : ""}`).join("; ")}. Total: ${this.spend()}.\n`;
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
						stage.modelMs === undefined ? "" : `model=${stage.modelMs}ms`,
						stage.reused ? "reused" : stage.resumed ? "resumed" : "",
						stage.note,
						stage.error,
						stage.usage === undefined ? "" : usageText(stage.usage),
						(stage.usage?.requests ?? [])
							.map(
								(request) =>
									`${request.model} ${reasoningText(request.reasoning)} sent=${JSON.stringify(request.reasoning.sent)}`,
							)
							.join("; "),
						incompleteUsage(stage.usageIncomplete).trim(),
						stage.clockRegressed ? "clock regressed" : "",
					]
						.filter(Boolean)
						.join(" "),
				),
			)
			.join(
				"\n",
			)}\nTotal: ${this.spend()}.\n${this.total === undefined ? "" : `${visibleText(usageText(this.total))}\n`}${(
			this.prepare?.spans ?? []
		)
			.toSorted((a, b) => a.startedAt - b.startedAt || b.endedAt - a.endedAt)
			.map(
				(span) =>
					`${visibleText(`span ${span.name} start=${span.startedAt} end=${span.endedAt} duration=${span.durationMs}ms${span.parent === undefined ? "" : ` parent=${span.parent}`}`)}\n`,
			)
			.join("")}${this.untimed()
			.map((gap) => `untimed start=${gap.startedAt} end=${gap.endedAt} duration=${gap.durationMs}ms\n`)
			.join("")}`;
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
		return new StageTelemetry(revision, rows, await this.document(PrepareDocument, scope, context, revision));
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
		const usage = await this.document(
			ModelUsageDocument,
			{ kind: "conversation", conversationId: task.conversationId },
			context,
			String(task.id),
		);
		const attempts = await this.document(
			ModelAttemptsDocument,
			{ kind: "conversation", conversationId: task.conversationId },
			context,
			String(task.id),
		);
		const unmeasured = attempts === undefined ? 0 : attempts.unmeasured;
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
			...(usage?.usage === undefined ? {} : { usage: usage.usage }),
			...(unmeasured > 0 ? { usageIncomplete: unmeasured } : {}),
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
		let ending: Pick<Stage, "endedAt" | "note"> = {};
		let result = outcome(task);
		if (last?.status === "done") {
			ending = await this.ending(last.answer, context);
			result = { outcome: "completed" };
		} else if (last?.status === "unanswered") {
			const entries = await this.storage.scanEntries({ conversationId: id }, 1, undefined, context);
			const latest = entries.items[0];
			ending = latest === undefined ? {} : await this.ending(latest.id, context);
			result = { outcome: "failed", ...(typeof last.detail === "string" ? { error: last.detail } : {}) };
		}
		const policy = await this.document(LensDocument, { kind: "conversation", conversationId: id }, context);
		if (policy?.spend?.ended !== undefined || policy?.spend?.capped !== undefined) result = { outcome: "ended" };
		if (ending.endedAt === undefined && task.state.status === "terminal" && task.state.outcome.status === "faulted") {
			ending = { endedAt: task.endedAt };
			result = outcome(task);
		}
		const recorded = await this.document(
			ModelUsageDocument,
			{ kind: "conversation", conversationId: id },
			context,
			`conversation:${id}`,
		);
		const usage = await this.document(UsageDoc, { kind: "conversation", conversationId: id }, context);
		let modelMs = 0;
		let entries = await this.storage.scanEntries({ conversationId: id }, 200, undefined, context);
		for (;;) {
			for (const entry of entries.items)
				for (const message of entry.model ?? [])
					if (message.role === "assistant") modelMs += message.durationMs ?? 0;
			if (entries.next === undefined) break;
			entries = await this.storage.scanEntries({ conversationId: id }, 200, entries.next, context);
		}
		return {
			id: `conversation:${id}`,
			name,
			subject,
			task: task.id,
			conversation: id,
			...result,
			...interval(start, ending.endedAt),
			...ending,
			...this.attachment(start, ending.endedAt, before),
			modelMs,
			...(usage === undefined
				? {}
				: {
						usage: {
							...new TokenUsage(usage.models).toJSON(),
							...(recorded?.requests === undefined ? {} : { requests: recorded.requests }),
						},
					}),
		};
	}

	private async ending(id: EntryId, context: Context): Promise<Pick<Stage, "endedAt" | "note">> {
		const message = (await this.storage.entry(id, context))?.entry.model?.[0];
		const durationMs = message?.role === "assistant" ? message.durationMs : 0;
		return {
			endedAt: message === undefined ? undefined : message.timestamp + (durationMs ?? 0),
			...(durationMs === undefined
				? { note: "Response duration unavailable; end uses the request timestamp." }
				: {}),
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

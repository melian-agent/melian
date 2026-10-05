import type { ModelReference, StoredVerificationState } from "@melian-agent/core";
import { revisionKey, sightingVerification } from "./findings.ts";
import {
	type Context,
	type ConversationId,
	configure,
	type DocumentReader,
	defineTask,
	type Harness,
	isFailoverError,
	type TaskId,
} from "./harness.ts";
import {
	budgetEnded,
	LensDocument,
	lensReadTools,
	type ReviewState,
	reportVerdict,
	type StoredBudgetEnd,
} from "./lens-tools.ts";
import { lensExtension } from "./review.ts";
import { attachable, ReviewIndex } from "./review-index.ts";
import { quoteUntrusted } from "./untrusted.ts";
import { verifierInstructions } from "./verification-instructions.ts";

export type VerificationCandidate = {
	key: string;
	state: StoredVerificationState;
	finder: string;
	route: ModelReference[];
	budget: { tokens: number; tools: number };
};
export type VerificationInput = {
	root: ConversationId;
	revision: ReviewState;
	version: string;
	candidates: VerificationCandidate[];
};
type Checkpoint =
	| { phase: "spawn" }
	| { phase: "verify"; children: Record<string, ConversationId>; attempts: Record<string, number> };
type Outcome =
	| { status: "done"; model: string }
	| { status: "ended"; budgetEnded: StoredBudgetEnd }
	| { status: "unanswered" | "exhausted"; reason: string };
export type VerificationResult = Record<string, Outcome>;

async function replaced(
	reader: DocumentReader,
	input: VerificationInput,
	task: number,
	context: Context,
): Promise<boolean> {
	return (
		(await reader.snapshot(ReviewIndex, input.root, context))?.reviews[revisionKey(input.revision)]?.verification
			?.task !== task
	);
}

export const VerificationTask = defineTask<VerificationInput, Checkpoint, VerificationResult>({
	name: "melian.verification",
	version: 1,
	initial: () => ({ phase: "spawn" }),
	phases: {
		spawn: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				if (
					(await tx.doc(ReviewIndex, task.input.root)).reviews[revisionKey(task.input.revision)]?.verification
						?.task !== runtime.taskId
				)
					return { status: "terminal", outcome: { status: "completed", result: {} } };
				const children: Record<string, ConversationId> = {};
				for (const candidate of task.input.candidates) {
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
					children[candidate.key] = child.id;
					const claims = candidate.state.claims.map(({ id, source }, index) => ({
						label: `c${index + 1}`,
						id,
						source,
					}));
					await configure(tx, child.id, {
						model: candidate.route[0],
						instructions: [
							verifierInstructions,
							...claims.map(({ label, id }) => `Claim ${label} finding ${id}`),
						].join("\n\n"),
						tools: [...Object.values(lensReadTools), reportVerdict],
						extensions: [lensExtension],
					});
					(await tx.doc(LensDocument, child.id)).lens = {
						name: "verifier",
						version: task.input.version,
						role: "verifier",
						model: `${candidate.route[0]!.provider}/${candidate.route[0]!.modelId}`,
						claims,
						review: task.input.root,
						revision: task.input.revision,
						tools: ["read_file", "search", "list_files"],
						severities: [],
						rules: [],
						budget: candidate.state.claims.length,
						limits: candidate.budget,
						coverage: { scope: "", paths: ["**"], nearer: [] },
						task: runtime.taskId,
					};
				}
				return { status: "running", checkpoint: { phase: "verify", children, attempts: {} } };
			}, context);
		},
		verify: async (task, runtime, context) => {
			const started = task.state.checkpoint as Extract<Checkpoint, { phase: "verify" }>;
			const result: VerificationResult = {};
			const run = async (candidate: VerificationCandidate): Promise<Outcome> => {
				const id = started.children[candidate.key]!;
				const child = (await runtime.conversation(id, context))!;
				for (let attempt = started.attempts[candidate.key] ?? 0; ; attempt++) {
					if (await replaced(runtime, task.input, runtime.taskId, context))
						return { status: "unanswered", reason: "superseded" };
					const content =
						attempt === 0
							? candidate.state.claims
									.map(
										(claim, index) =>
											`Claim c${index + 1}\n${quoteUntrusted("findings", JSON.stringify(claim), task.input.revision.nonce)}`,
									)
									.join("\n\n")
							: "Continue judging the labelled claims. Already recorded verdicts remain; answer every claim still missing.";
					const settled = await (
						await child.submit(
							{ type: "input", content, requestId: `verify:${candidate.key}:${attempt}` },
							context,
						)
					).wait(context);
					const ended = await budgetEnded(runtime, id, context);
					if (ended !== undefined) return { status: "ended", budgetEnded: ended };
					if (settled.status === "done") {
						const verdicts = await Promise.all(
							candidate.state.claims.map((claim) =>
								sightingVerification(
									runtime,
									task.input.root,
									revisionKey(task.input.revision),
									claim.id,
									claim.source,
									task.input.version,
									context,
								),
							),
						);
						if (verdicts.some((verdict) => verdict === undefined))
							return { status: "unanswered", reason: "the verifier left a claim unjudged" };
						const model = candidate.route[attempt]!;
						return { status: "done", model: `${model.provider}/${model.modelId}` };
					}
					const reason = typeof settled.detail === "string" ? settled.detail : (settled.reason ?? "unanswered");
					if (settled.reason !== "no_model" && !(settled.reason === "model_error" && isFailoverError(reason)))
						return { status: "unanswered", reason };
					const next = candidate.route[attempt + 1];
					if (next === undefined) return { status: "exhausted", reason };
					await runtime.commit(async (tx, current) => {
						if (
							(await tx.doc(ReviewIndex, task.input.root)).reviews[revisionKey(task.input.revision)]
								?.verification?.task !== runtime.taskId
						)
							return undefined;
						await configure(tx, id, { model: next });
						(await tx.doc(LensDocument, id)).lens!.model = `${next.provider}/${next.modelId}`;
						const checkpoint = current.state.checkpoint as Extract<Checkpoint, { phase: "verify" }>;
						return {
							status: "running",
							checkpoint: { ...checkpoint, attempts: { ...checkpoint.attempts, [candidate.key]: attempt + 1 } },
						};
					}, context);
				}
			};
			let cursor = 0;
			await Promise.all(
				Array.from({ length: Math.min(8, task.input.candidates.length) }, async () => {
					for (;;) {
						const candidate = task.input.candidates[cursor++];
						if (candidate === undefined) return;
						result[candidate.key] = await run(candidate);
					}
				}),
			);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

export async function startVerification(
	harness: Harness,
	input: VerificationInput,
	selection: readonly string[],
	rerun: boolean,
	context: Context,
): Promise<TaskId<VerificationResult> | undefined> {
	const root = await harness.root(context);
	const { nonce: _, ...revision } = input.revision;
	const candidates = input.candidates.map((candidate) => ({
		...candidate,
		state: {
			speaker: candidate.state.speaker.properties.id,
			claims: candidate.state.claims.map(({ verification: __, ...claim }) => claim),
		},
	}));
	const key = JSON.stringify({ root: input.root, revision, version: input.version, candidates });
	return root.commit(async (tx) => {
		const index = await tx.doc(ReviewIndex, root.id);
		const known = index.reviews[revisionKey(input.revision)];
		if (known !== undefined && known.lenses.join("\n") !== selection.join("\n")) return undefined;
		const previous = known?.verification;
		const record = previous === undefined ? undefined : await tx.task(previous.task as TaskId);
		const failed =
			record?.state.status === "terminal" &&
			(record.state.outcome.status !== "completed" ||
				Object.values(record.state.outcome.result as VerificationResult).some(
					(outcome) => outcome.status !== "done",
				));
		if (previous?.input === key && !(rerun && failed) && (await attachable(tx, previous.task, [])))
			return previous.task as TaskId<VerificationResult>;
		const created = await tx.createTask(VerificationTask, input, { ownership: { kind: "conversation" } });
		index.reviews[revisionKey(input.revision)] = {
			...(known ?? { lenses: [...selection] }),
			verification: { task: created, input: key },
		};
		return created;
	}, context);
}

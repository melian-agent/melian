import type { ModelReference, ModelRoute, Severity, StoredVerificationState } from "@melian-agent/core";
import { Revision } from "@melian-agent/core";
import { clearVerifications, FindingsDocument, sightingIn, sightingVerification } from "./findings.ts";
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
import type { ProbeSandbox } from "./probe.ts";
import {
	type ClaimProbe,
	claimKey,
	type ProbeRun,
	type ProbingEnvironment,
	probeFailed,
	renderProbeEvidence,
	runHeadProbe,
} from "./probing.ts";
import { lensExtension } from "./review.ts";
import { ReviewIndex } from "./review-index.ts";
import { quoteUntrusted } from "./untrusted.ts";
import { verifierInstructions } from "./verification-instructions.ts";

export type VerificationCandidate = {
	key: string;
	state: StoredVerificationState;
	finder: string;
	route: ModelReference[];
	thinking?: ModelRoute["thinking"];
	budget: { tokens: number; tools: number };
	decisionsAtBase?: string;
	designAtBase?: { sections: string; files: string };
	// What a lowering of any claim is checked against; absent from a candidate an older Melian stored.
	fence?: { coReported: boolean; silent: Severity[] };
	// The probe each claim of a probing level rests on, by `claimKey`, and what probes run under, so the task runs each
	// again before its verifier starts. Absent from a candidate of a level that does not probe.
	probes?: Record<string, ClaimProbe>;
	probing?: ProbingEnvironment;
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
		(await reader.snapshot(ReviewIndex, input.root, context))?.reviews[Revision.key(input.revision)]?.verification
			?.task !== task
	);
}

// Each candidate's claim probes, run again against the head, by candidate key and then by claim. A replay runs them again,
// before the commit that records what they printed in the verifier's instructions.
async function rerun(input: VerificationInput, sandbox: ProbeSandbox | undefined) {
	const reruns: Record<string, Record<string, ProbeRun>> = {};
	for (const candidate of input.candidates) {
		for (const [key, claim] of Object.entries(candidate.probes ?? {})) {
			const run =
				candidate.probing === undefined
					? { refused: "the candidate names no environment to probe in" }
					: await runHeadProbe(
							{ script: claim.probe.script, files: claim.probe.files },
							input.revision,
							candidate.probing,
							sandbox,
						);
			reruns[candidate.key] = { ...reruns[candidate.key], [key]: run };
		}
	}
	return reruns;
}

/**
 * The verification task, with probes run again under `sandbox`, sandbox-runtime when absent. A test passes its own
 * sandbox; every task of the name shares one definition otherwise.
 */
export function verificationTask(sandbox?: ProbeSandbox) {
	return defineTask<VerificationInput, Checkpoint, VerificationResult>({
		name: "melian.verification",
		// Version 3 lets a candidate carry its claims' probes; an older candidate carries none.
		version: 3,
		migrate: (input, checkpoint) => ({
			input: input as unknown as VerificationInput,
			checkpoint: checkpoint as Checkpoint,
		}),
		initial: () => ({ phase: "spawn" }),
		phases: {
			spawn: async (task, runtime, context) => {
				// A task a later review replaced runs no probe.
				const owns =
					(await runtime.snapshot(ReviewIndex, task.input.root, context))?.reviews[
						Revision.key(task.input.revision)
					]?.verification?.task === runtime.taskId;
				const reruns = owns ? await rerun(task.input, sandbox) : {};
				await runtime.commit(async (tx) => {
					if (
						(await tx.doc(ReviewIndex, task.input.root)).reviews[Revision.key(task.input.revision)]?.verification
							?.task !== runtime.taskId
					)
						return { status: "terminal", outcome: { status: "completed", result: {} } };
					// Read before any write. The severity each lens reported goes on the claim's label line, which Melian
					// writes outside the boundary: a lowering is one step from it, and the claim itself does not hold it.
					const findings = await tx.doc(FindingsDocument, task.input.root);
					const children: Record<string, ConversationId> = {};
					for (const candidate of task.input.candidates) {
						const child = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
						children[candidate.key] = child.id;
						const again = reruns[candidate.key] ?? {};
						const claims = candidate.state.claims.map(({ id, source }, index) => {
							const key = claimKey({ id, source });
							const run = again[key];
							return {
								label: `c${index + 1}`,
								id,
								source,
								...(candidate.fence === undefined ? {} : { fence: structuredClone(candidate.fence) }),
								// Confirmed only when the probe failed again, so a claim stands on what its probe shows now.
								...(candidate.probes?.[key] === undefined
									? {}
									: {
											probe: { reproduced: run !== undefined && "result" in run && probeFailed(run.result) },
										}),
							};
						});
						await configure(tx, child.id, {
							model: candidate.route[0],
							thinkingLevel: candidate.thinking,
							instructions: [
								verifierInstructions,
								...(candidate.decisionsAtBase === undefined
									? []
									: [
											`## Decisions at base\n${quoteUntrusted("listing", candidate.decisionsAtBase, task.input.revision.nonce)}`,
										]),
								...(candidate.designAtBase === undefined
									? []
									: [
											`## Design sections at base\n${quoteUntrusted("listing", candidate.designAtBase.sections, task.input.revision.nonce)}`,
											`## Design files at base\n${quoteUntrusted("listing", candidate.designAtBase.files, task.input.revision.nonce)}`,
										]),
								...claims.map(({ label, id, source }) => {
									const at = Revision.key(task.input.revision);
									const severity = sightingIn(findings, at, id, source)?.properties.severity;
									return `Claim ${label} finding ${id}${severity === undefined ? "" : `, reported at ${severity}`}`;
								}),
								...claims.flatMap(({ label, id, source }) => {
									const key = claimKey({ id, source });
									const probe = candidate.probes?.[key];
									return probe === undefined
										? []
										: [renderProbeEvidence(label, probe, again[key], task.input.revision.nonce)];
								}),
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
										Revision.key(task.input.revision),
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
								(await tx.doc(ReviewIndex, task.input.root)).reviews[Revision.key(task.input.revision)]
									?.verification?.task !== runtime.taskId
							)
								return undefined;
							await configure(tx, id, { model: next });
							(await tx.doc(LensDocument, id)).lens!.model = `${next.provider}/${next.modelId}`;
							const checkpoint = current.state.checkpoint as Extract<Checkpoint, { phase: "verify" }>;
							return {
								status: "running",
								checkpoint: {
									...checkpoint,
									attempts: { ...checkpoint.attempts, [candidate.key]: attempt + 1 },
								},
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
}

/** The verification task, with probes run again under sandbox-runtime. */
export const VerificationTask = verificationTask();

export async function startVerification(
	harness: Harness,
	input: VerificationInput,
	selection: readonly string[],
	rerun: boolean,
	context: Context,
	refused: (model: string) => boolean = () => false,
	unlockModels?: (providers: readonly string[]) => Promise<void>,
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
	if (unlockModels !== undefined) {
		// Live tasks were unlocked from their checkpoints before resume; finished tasks ask no model.
		const previous = (await harness.snapshot(ReviewIndex, root.id, context))?.reviews[Revision.key(input.revision)]
			?.verification;
		const record = previous === undefined ? undefined : await harness.getTask(previous.task as TaskId, context);
		const results =
			record?.state.status === "terminal" && record.state.outcome.status === "completed"
				? (record.state.outcome.result as VerificationResult)
				: undefined;
		const answered =
			results !== undefined && input.candidates.every((candidate) => results[candidate.key] !== undefined);
		const failed =
			results !== undefined &&
			input.candidates.some((candidate) => {
				const result = results[candidate.key];
				return result?.status !== "done" || refused(result.model);
			});
		const attaches =
			previous?.input === key &&
			record !== undefined &&
			(record.state.status !== "terminal" || (answered && (!failed || !rerun)));
		if (!attaches)
			await unlockModels(input.candidates.flatMap((candidate) => candidate.route.map((model) => model.provider)));
	}
	return root.commit(async (tx) => {
		const index = await tx.doc(ReviewIndex, root.id);
		const known = index.reviews[Revision.key(input.revision)];
		if (known !== undefined && known.lenses.join("\n") !== selection.join("\n")) return undefined;
		const previous = known?.verification;
		const record = previous === undefined ? undefined : await tx.task(previous.task as TaskId);
		const results =
			record?.state.status === "terminal" && record.state.outcome.status === "completed"
				? (record.state.outcome.result as VerificationResult)
				: undefined;
		const failed =
			results !== undefined &&
			input.candidates.some((candidate) => {
				const result = results[candidate.key];
				return result?.status !== "done" || refused(result.model);
			});
		if (previous?.input === key) {
			if (failed && !rerun && input.candidates.every((candidate) => results![candidate.key] !== undefined))
				return previous.task as TaskId<VerificationResult>;
			if (record !== undefined && (record.state.status !== "terminal" || (results !== undefined && !failed)))
				return previous.task as TaskId<VerificationResult>;
		}
		await clearVerifications(tx, input.root, Revision.key(input.revision));
		const created = await tx.createTask(VerificationTask, input, { ownership: { kind: "conversation" } });
		const { adjudication: __, ...entry } = known ?? { lenses: [...selection] };
		index.reviews[Revision.key(input.revision)] = {
			...entry,
			verification: { task: created, input: key },
		};
		return created;
	}, context);
}

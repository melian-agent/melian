import type {
	FindingEvidence,
	ModelReference,
	ModelRoute,
	Severity,
	StoredVerificationState,
} from "@melian-agent/core";
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
import { type ClaimProbe, ProbeReruns, probeClaimKey, probeFailed, renderProbeEvidence, rerunKey } from "./probing.ts";
import { lensExtension } from "./review.ts";
import { ReviewIndex, type ReviewIndexState } from "./review-index.ts";
import { quoteUntrusted } from "./untrusted.ts";
import { verifierInstructions } from "./verification-instructions.ts";
import {
	claimKey,
	VerificationWaves,
	VerificationWavesDocument,
	type VerificationWavesState,
} from "./verification-waves.ts";

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
	// The probe each claim of a probing level rests on, by `probeClaimKey`, with what its own run ran probes under. The review
	// runs each again into `ProbeReruns` before the task starts. Absent from a candidate of a level that does not probe.
	probes?: Record<string, ClaimProbe>;
	// The dismissed findings the verifier judges each claim against for sameness; absent when none qualifies, so a
	// candidate without them keeps the attach key it had before Melian asked.
	dismissed?: DismissedPredecessor[];
	// The identity of each dismissal in `dismissed` when the candidate formed, by root ID. Left out of the candidate's
	// identity, so a wave outcome a final step reuses links only the dismissals that wave's verifier was shown.
	dismissals?: Record<string, string>;
};
// A root dismissal a candidate may restate, as the verifier sees it: its claim, never its dismissal's reason.
export type DismissedPredecessor = { id: string; failureScenario?: string; evidence?: FindingEvidence };
export type VerificationInput = {
	root: ConversationId;
	revision: ReviewState;
	version: string;
	candidates: VerificationCandidate[];
	// Outcomes an earlier wave reached for candidates it verified with the same claims, by key; this task copies them
	// rather than ask again. Absent from a task an older Melian stored.
	reused?: Record<string, Outcome>;
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
	return !VerificationWaves.owns(
		await reader.snapshot(ReviewIndex, input.root, context),
		await reader.snapshot(VerificationWavesDocument, input.root, context),
		Revision.key(input.revision),
		task,
	);
}

export const VerificationTask = defineTask<VerificationInput, Checkpoint, VerificationResult>({
	name: "melian.verification",
	// Version 3, on main, lets a task reuse a wave's outcomes. Version 4 lets a candidate carry its claims' probes, so a
	// build that knows version 3 alone refuses a task whose verifier must hold probes to their reruns. Both fields are
	// optional, so a version 2 or 3 task reads unchanged.
	version: 4,
	migrate: (input, checkpoint) => ({
		input: input as unknown as VerificationInput,
		checkpoint: checkpoint as Checkpoint,
	}),
	initial: () => ({ phase: "spawn" }),
	phases: {
		spawn: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				if (
					!VerificationWaves.owns(
						await tx.doc(ReviewIndex, task.input.root),
						await tx.doc(VerificationWavesDocument, task.input.root),
						Revision.key(task.input.revision),
						runtime.taskId,
					)
				)
					return { status: "terminal", outcome: { status: "completed", result: {} } };
				// Read before any write. The severity each lens reported goes on the claim's label line, which Melian
				// writes outside the boundary: a lowering is one step from it, and the claim itself does not hold it.
				const findings = await tx.doc(FindingsDocument, task.input.root);
				const reruns = (await tx.doc(ProbeReruns, task.input.root)).runs[Revision.key(task.input.revision)] ?? {};
				const children: Record<string, ConversationId> = {};
				for (const candidate of task.input.candidates) {
					if (task.input.reused?.[candidate.key] !== undefined) continue;
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
					children[candidate.key] = child.id;
					const probed = (claim: { id: string; source: { check: string; version?: string } }) => {
						const probe = candidate.probes?.[probeClaimKey(claim)];
						return probe === undefined ? undefined : { probe, again: reruns[rerunKey(claim, probe)] };
					};
					const claims = candidate.state.claims.map(({ id, source }, index) => {
						const probe = probed({ id, source });
						return {
							label: `c${index + 1}`,
							id,
							source,
							...(candidate.fence === undefined ? {} : { fence: structuredClone(candidate.fence) }),
							// Confirmed only when the probe failed again, so a claim stands on what its probe shows now.
							...(probe === undefined
								? {}
								: {
										probe: {
											reproduced:
												probe.again !== undefined &&
												"result" in probe.again &&
												probeFailed(probe.again.result),
										},
									}),
						};
					});
					const dismissed = (candidate.dismissed ?? []).map(({ id }, index) => ({ label: `d${index + 1}`, id }));
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
							...dismissed.map(({ label, id }) => `Dismissed ${label} finding ${id}`),
							...claims.flatMap(({ label, id, source }) => {
								const probe = probed({ id, source });
								return probe === undefined
									? []
									: [renderProbeEvidence(label, probe.probe, probe.again, task.input.revision.nonce)];
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
						...(dismissed.length === 0 ? {} : { dismissed }),
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
			const result: VerificationResult = { ...task.input.reused };
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
									.concat(
										(candidate.dismissed ?? []).map(
											({ id: _, ...claim }, index) =>
												`Dismissed d${index + 1}\n${quoteUntrusted("findings", JSON.stringify(claim), task.input.revision.nonce)}`,
										),
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
							!VerificationWaves.owns(
								await tx.doc(ReviewIndex, task.input.root),
								await tx.doc(VerificationWavesDocument, task.input.root),
								Revision.key(task.input.revision),
								runtime.taskId,
							)
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
						if (task.input.reused?.[candidate.key] !== undefined) continue;
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
	refused: (model: string) => boolean = () => false,
	unlockModels?: (providers: readonly string[]) => Promise<void>,
	// The identities of the candidates the caller's own waves verified.
	own: ReadonlySet<string> = new Set(),
): Promise<TaskId<VerificationResult> | undefined> {
	const root = await harness.root(context);
	const { nonce: _, ...revision } = input.revision;
	// A rerun the sandbox refused runs again on a repeat review, so a verification attaches only to the reruns it read.
	// A review with none keeps the key it had before reruns joined it, so its stored verifications still attach. The
	// reruns document exists: a review starts verification only after its rerun task, and stops if another replaced it.
	const reruns = (await harness.snapshot(ProbeReruns, input.root, context))!.runs[Revision.key(input.revision)] ?? {};
	const key = JSON.stringify({
		root: input.root,
		revision,
		version: input.version,
		candidates: input.candidates.map(candidateIdentity),
		...(Object.keys(reruns).length === 0 ? {} : { reruns }),
	});
	const asking = input.candidates.filter((candidate) => input.reused?.[candidate.key] === undefined);
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
		if (!attaches && asking.length > 0)
			await unlockModels(asking.flatMap((candidate) => candidate.route.map((model) => model.provider)));
	}
	// A reused outcome's claims keep the verdicts the wave that reached it stored.
	const kept = new Set(
		input.candidates.flatMap((candidate) =>
			input.reused?.[candidate.key] === undefined ? [] : candidate.state.claims.map(claimKey),
		),
	);
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
		// Another review's final task may have retired a wave this input reuses, or one the caller ran for a candidate it
		// holds; that review then decides those claims.
		const standing = VerificationWaves.of(
			await tx.doc(VerificationWavesDocument, input.root),
			Revision.key(input.revision),
			known?.task,
		);
		for (const candidate of input.candidates)
			if (
				(input.reused?.[candidate.key] !== undefined || own.has(JSON.stringify(candidateIdentity(candidate)))) &&
				standing.standing(
					JSON.stringify(candidateIdentity(candidate)),
					candidate.state.claims.map(claimKey),
					input.version,
				) === undefined
			)
				return undefined;
		await clearVerifications(tx, input.root, Revision.key(input.revision), (claim) => !kept.has(claim));
		// This task now decides every claim it clears, so no earlier wave stands for one, whatever route ran it, and a
		// wave that has not finished, which another review's watcher may have started, loses its authority to write.
		const waves = (await tx.doc(VerificationWavesDocument, input.root)).reviews[Revision.key(input.revision)];
		if (waves !== undefined) {
			const finished = [];
			for (const wave of waves.waves)
				if ((await tx.task(wave.task as TaskId))!.state.status === "terminal") finished.push(wave);
			for (const wave of finished)
				wave.candidates = wave.candidates.filter((candidate) => candidate.claims.every((claim) => kept.has(claim)));
			waves.waves = finished;
		}
		const created = await tx.createTask(VerificationTask, input, { ownership: { kind: "conversation" } });
		const { adjudication: __, ...entry } = known ?? { lenses: [...selection] };
		index.reviews[Revision.key(input.revision)] = {
			...entry,
			verification: { task: created, input: key },
		};
		return created;
	}, context);
}

/** What identifies a candidate's verification: the candidate less its claims' stored verdicts and speaker. */
export function candidateIdentity({ dismissals: _, ...candidate }: VerificationCandidate) {
	return {
		...candidate,
		state: {
			speaker: candidate.state.speaker.properties.id,
			claims: candidate.state.claims.map(({ verification: _, ...claim }) => claim),
		},
	};
}

/**
 * Starts a wave for `lensTask` at the input's revision: a verification task over candidates some lenses' ends formed
 * while others still run. Clears their claims' earlier verdicts, so the wave's own decide them. Returns nothing when the
 * index no longer names `lensTask`.
 */
export async function startWave(
	harness: Harness,
	input: VerificationInput,
	lensTask: number,
	context: Context,
	unlockModels?: (providers: readonly string[]) => Promise<void>,
): Promise<TaskId<VerificationResult> | undefined> {
	const root = await harness.root(context);
	const revision = Revision.key(input.revision);
	// Once the final verification owns the revision, a wave would clear what it decided.
	const freshOf = (index: ReviewIndexState | undefined, state: VerificationWavesState | undefined) => {
		const indexed = index?.reviews[revision];
		if (indexed?.task !== lensTask || indexed.verification !== undefined) return [];
		const waves = VerificationWaves.of(state, revision, lensTask);
		return input.candidates.filter(
			(candidate) =>
				waves.standing(
					JSON.stringify(candidateIdentity(candidate)),
					candidate.state.claims.map(claimKey),
					input.version,
				) === undefined,
		);
	};
	// Only a wave that would start unlocks its route; the commit decides again, and asks nothing the read ruled out.
	const unlocked = freshOf(
		await harness.snapshot(ReviewIndex, root.id, context),
		await harness.snapshot(VerificationWavesDocument, root.id, context),
	);
	if (unlocked.length === 0) return undefined;
	await unlockModels?.(unlocked.flatMap((candidate) => candidate.route.map((model) => model.provider)));
	return root.commit(async (tx) => {
		const fresh = freshOf(
			await tx.doc(ReviewIndex, root.id),
			await tx.doc(VerificationWavesDocument, root.id),
		).filter((candidate) => unlocked.includes(candidate));
		if (fresh.length === 0) return undefined;
		const entry = await VerificationWaves.open(tx, root.id, revision, lensTask);
		// Another review watching the same lens task may have started a wave since this one read the document, so the
		// one-wave rule and freshness are decided here, in the commit that adds the wave.
		const running = entry.waves.at(-1);
		if (running !== undefined && (await tx.task(running.task as TaskId))!.state.status !== "terminal")
			return undefined;
		const claims = new Set(fresh.flatMap((candidate) => candidate.state.claims.map(claimKey)));
		await clearVerifications(tx, input.root, revision, (claim) => claims.has(claim));
		const created = await tx.createTask(
			VerificationTask,
			{ ...input, candidates: fresh },
			{ ownership: { kind: "conversation" } },
		);
		entry.waves.push({
			task: created,
			version: input.version,
			candidates: fresh.map((candidate) => ({
				key: JSON.stringify(candidateIdentity(candidate)),
				claims: candidate.state.claims.map(claimKey),
			})),
		});
		return created;
	}, context);
}

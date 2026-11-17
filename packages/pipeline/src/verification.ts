import type {
	FindingEvidence,
	ModelReference,
	ModelRoute,
	Severity,
	StoredVerificationState,
} from "@melian-agent/core";
import { KeyedRequest, type RecordJson, Revision, requestJson } from "@melian-agent/core";
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
	type Tx,
} from "./harness.ts";
import {
	budgetEnded,
	LensDocument,
	lensReadTools,
	type ReviewState,
	reportVerdict,
	type StoredBudgetEnd,
	verifierInjectionPolicy,
} from "./lens-tools.ts";
import {
	boundProbeEvidence,
	type ClaimProbe,
	evidenceWordingOf,
	type ProbeEvidence,
	ProbeReruns,
	type ProbeRun,
	probeClaimKey,
	probeEvidenceBudget,
	probeFailed,
	probingWording,
	renderProbeEvidence,
	rerunKey,
	type StoredProbeResult,
} from "./probing.ts";
import { lensExtension } from "./review.ts";
import { ReviewIndex, type ReviewIndexState, stillOwns } from "./review-index.ts";
import { identityNonce, quoteUntrusted } from "./untrusted.ts";
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
	// The severity each claim's lens reported, by claim key, read when the candidate formed; absent from a candidate an
	// older Melian stored, whose verifier reads it from the findings at spawn.
	reportedAt?: Record<string, Severity>;
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
					const probed = (claim: { id: string; source: { check: string; version?: string } }) => {
						const probe = candidate.probes?.[probeClaimKey(claim)];
						return probe === undefined ? undefined : { probe, again: reruns[rerunKey(claim, probe)] };
					};
					const claims = candidate.state.claims.map((claim, index) => {
						const { id, source } = claim;
						const probe = probed({ id, source });
						return {
							label: `c${index + 1}`,
							id,
							source,
							severity:
								candidate.reportedAt === undefined
									? sightingIn(findings, Revision.key(task.input.revision), id, source)?.properties.severity
									: candidate.reportedAt[claimKey(claim)],
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
					const instructions = verifierPrompt(
						candidate,
						claims,
						dismissed,
						candidateEvidence(candidate, reruns),
						task.input.revision.nonce,
					);
					// A candidate with no conversation is one whose evidence no verifier may be shown; it ends unasked.
					if (instructions === undefined) continue;
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
					children[candidate.key] = child.id;
					await configure(tx, child.id, {
						model: candidate.route[0],
						thinkingLevel: candidate.thinking,
						instructions,
						tools: [...Object.values(lensReadTools), reportVerdict],
						extensions: [lensExtension],
					});
					(await tx.doc(LensDocument, child.id)).lens = {
						name: "verifier",
						version: task.input.version,
						role: "verifier",
						model: `${candidate.route[0]!.provider}/${candidate.route[0]!.modelId}`,
						claims: claims.map(({ severity: _, ...claim }) => claim),
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
				const id = started.children[candidate.key];
				if (id === undefined) return { status: "unanswered", reason: unshown(candidate) };
				const child = (await runtime.conversation(id, context))!;
				for (let attempt = started.attempts[candidate.key] ?? 0; ; attempt++) {
					if (await replaced(runtime, task.input, runtime.taskId, context))
						return { status: "unanswered", reason: "superseded" };
					const content =
						attempt === 0
							? verifierInput(
									candidate.state.claims.map(({ verification: _, ...claim }) => claim),
									(candidate.dismissed ?? []).map(({ id: _, ...claim }) => claim),
									task.input.revision.nonce,
								)
							: continueJudging;
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
	// The lens task whose findings these are; a review whose lens task another replaced starts no verification.
	lensTask?: number,
): Promise<TaskId<VerificationResult> | undefined> {
	const root = await harness.root(context);
	// A rerun the sandbox refused runs again on a repeat review, so a verification attaches only to the reruns it read.
	// The reruns document exists: a review starts verification only after its rerun task, and stops if another replaced it.
	const reruns = (await harness.snapshot(ProbeReruns, input.root, context))!.runs[Revision.key(input.revision)] ?? {};
	const { key } = verificationRequest(input, reruns);
	const asking = input.candidates.filter((candidate) => input.reused?.[candidate.key] === undefined);
	// A candidate whose evidence no verifier may be shown is asked nothing, so its route needs no credential.
	const providers = asking
		.filter(
			(candidate) => boundProbeEvidence(candidateEvidence(candidate, reruns), input.revision.nonce) !== undefined,
		)
		.flatMap((candidate) => candidate.route.map((model) => model.provider));
	// The task the read below found to attach to without unlocking. The commit acts on that alone: any other outcome
	// writes nothing, and the commit runs again with every asking candidate's route unlocked, since another review can
	// commit between the read and the commit.
	let attachesTo: number | undefined;
	if (unlockModels !== undefined && asking.length > 0) {
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
		if (attaches) attachesTo = previous.task;
		else await unlockModels(providers);
	}
	// A reused outcome's claims keep the verdicts the wave that reached it stored.
	const kept = new Set(
		input.candidates.flatMap((candidate) =>
			input.reused?.[candidate.key] === undefined ? [] : candidate.state.claims.map(claimKey),
		),
	);
	const unlockFirst = Symbol("unlock first");
	const decide = async (tx: Tx): Promise<TaskId<VerificationResult> | typeof unlockFirst | undefined> => {
		const index = await tx.doc(ReviewIndex, root.id);
		const known = index.reviews[Revision.key(input.revision)];
		if (known !== undefined && known.lenses.join("\n") !== selection.join("\n")) return undefined;
		if (!stillOwns(known, lensTask)) return undefined;
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
		if (attachesTo !== undefined && previous?.task !== attachesTo) return unlockFirst;
		if (previous?.input === key) {
			if (failed && !rerun && input.candidates.every((candidate) => results![candidate.key] !== undefined))
				return previous.task as TaskId<VerificationResult>;
			if (record !== undefined && (record.state.status !== "terminal" || (results !== undefined && !failed)))
				return previous.task as TaskId<VerificationResult>;
		}
		if (attachesTo !== undefined) return unlockFirst;
		// Another review's final task may have retired a wave this input reuses, or one the caller ran for a candidate it
		// holds; that review then decides those claims.
		const standing = VerificationWaves.of(
			await tx.doc(VerificationWavesDocument, input.root),
			Revision.key(input.revision),
			known?.task,
		);
		for (const candidate of input.candidates)
			if (
				(input.reused?.[candidate.key] !== undefined || own.has(candidateKey(candidate))) &&
				standing.standing(
					candidateKey(candidate),
					candidate.state.claims.map(claimKey),
					waveVersion(input.version),
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
	};
	const committed = await root.commit(decide, context);
	if (committed !== unlockFirst) return committed;
	await unlockModels!(providers);
	attachesTo = undefined;
	return (await root.commit(decide, context)) as TaskId<VerificationResult> | undefined;
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

/** The key of a candidate's verification, through core's key function, which a wave outcome stands for. */
export function candidateKey(candidate: VerificationCandidate): string {
	return KeyedRequest.of("verification.candidate", requestJson(candidateIdentity(candidate))).key;
}

const continueJudging =
	"Continue judging the labelled claims. Already recorded verdicts remain; answer every claim still missing.";

function claimLine(label: string, id: string, severity: Severity | undefined): string {
	return `Claim ${label} finding ${id}${severity === undefined ? "" : `, reported at ${severity}`}`;
}

function dismissedLine(label: string, id: string): string {
	return `Dismissed ${label} finding ${id}`;
}

function verifierPrompt(
	{ decisionsAtBase, designAtBase }: Pick<VerificationCandidate, "decisionsAtBase" | "designAtBase">,
	claims: readonly { label: string; id: string; severity: Severity | undefined }[],
	dismissed: readonly { label: string; id: string }[],
	evidence: readonly ProbeEvidence[],
	nonce: string,
): string | undefined {
	const bound = boundProbeEvidence(evidence, nonce);
	if (bound === undefined) return undefined;
	return [
		verifierInstructions,
		...(decisionsAtBase === undefined
			? []
			: [`## Decisions at base\n${quoteUntrusted("listing", decisionsAtBase, nonce)}`]),
		...(designAtBase === undefined
			? []
			: [
					`## Design sections at base\n${quoteUntrusted("listing", designAtBase.sections, nonce)}`,
					`## Design files at base\n${quoteUntrusted("listing", designAtBase.files, nonce)}`,
				]),
		...claims.map(({ label, id, severity }) => claimLine(label, id, severity)),
		...dismissed.map(({ label, id }) => dismissedLine(label, id)),
		...bound,
	].join("\n\n");
}

// The probe evidence a candidate's verifier is shown, a block for each probing claim, labelled as its claim's line is.
function candidateEvidence(candidate: VerificationCandidate, reruns: Record<string, ProbeRun>): ProbeEvidence[] {
	return candidate.state.claims.flatMap((claim, index) => {
		const probe = candidate.probes?.[probeClaimKey(claim)];
		return probe === undefined
			? []
			: [
					{
						label: `c${index + 1}`,
						wording: evidenceWordingOf(probe.probesAs ?? lensOf(claim.source)),
						probe,
						again: reruns[rerunKey(claim, probe)],
					},
				];
	});
}

// What a cut candidate's verifier is shown, or why it is asked nothing; nothing for evidence that fits, which its probes
// and the reruns already key. It cuts under the review's nonce, as the prompt does, since quoting replaces the nonce in
// the head's text and so changes its size, and then names the boundary by the key's fixed nonce.
function cutEvidence(
	candidate: VerificationCandidate,
	reruns: Record<string, ProbeRun>,
	nonce: string,
): string | undefined {
	const evidence = candidateEvidence(candidate, reruns);
	const shown = boundProbeEvidence(evidence, nonce);
	if (shown === undefined) return unshown(candidate);
	const whole = evidence.map(({ label, wording, probe, again }) =>
		renderProbeEvidence(wording, label, probe, again, nonce),
	);
	if (shown.join("\n\n") === whole.join("\n\n")) return undefined;
	return shown.join("\n\n").replaceAll(`untrusted-${nonce}`, `untrusted-${identityNonce}`);
}

function unshown(candidate: VerificationCandidate): string {
	const probing = candidate.state.claims.filter(
		(claim) => candidate.probes?.[probeClaimKey(claim)] !== undefined,
	).length;
	return `Melian did not ask the verifier: the probe evidence of the candidate's ${probing} probing claim${probing === 1 ? "" : "s"} passes the ${probeEvidenceBudget} bytes a verifier is shown even with every part cut, so judge fewer claims of one defect together or raise the budget`;
}

function verifierInput(claims: readonly unknown[], dismissed: readonly unknown[], nonce: string): string {
	return claims
		.map((claim, index) => `Claim c${index + 1}\n${quoteUntrusted("findings", JSON.stringify(claim), nonce)}`)
		.concat(
			dismissed.map(
				(claim, index) => `Dismissed d${index + 1}\n${quoteUntrusted("findings", JSON.stringify(claim), nonce)}`,
			),
		)
		.join("\n\n");
}

function placeholderResult(exitCode: number): StoredProbeResult {
	return { exitCode, signal: null, output: "<output>", truncated: false, timedOut: false };
}

function placeholderProbe(exitCode: number): Omit<ClaimProbe, "environment"> {
	return {
		id: "<probe>",
		attack: 1,
		plan: [{ target: "<target>", reason: "<reason>", passing: "<passing>", failing: "<failing>" }],
		probe: {
			attack: 1,
			script: "<script>",
			files: [{ path: "<path>", text: "<text>" }],
			result: placeholderResult(exitCode),
			milliseconds: 0,
		},
	};
}

// The lens a claim's source names, whose judgement of a probe its verifier reads.
function lensOf(source: { readonly check: string }): string {
	return source.check.startsWith("lens.") ? source.check.slice("lens.".length) : source.check;
}

// The text a verifier is given that its version does not hash, rendered by the task's own functions with placeholders
// for what varies, so every fixed fragment it is shown reaches the key. The probe evidence renders under the
// trust-boundary lens's wording, as the version does; a request whose claims carry probes keys their own lenses'.
function verifierText(): unknown {
	const nonce = identityNonce;
	const wording = evidenceWordingOf("trust-boundary");
	return {
		tools: [...Object.values(lensReadTools), reportVerdict].map(({ name, description, parameters }) => ({
			name,
			description,
			parameters,
		})),
		policy: verifierInjectionPolicy(nonce),
		prompt: verifierPrompt(
			{ decisionsAtBase: "<decisions>", designAtBase: { sections: "<sections>", files: "<files>" } },
			[
				{ label: "c1", id: "<id>", severity: "P1" },
				{ label: "c2", id: "<id>", severity: undefined },
			],
			[{ label: "d1", id: "<id>" }],
			[
				{ label: "c1", wording, probe: placeholderProbe(1), again: undefined },
				{ label: "c2", wording, probe: placeholderProbe(1), again: { refused: "<refused>" } },
				{
					label: "c3",
					wording,
					probe: placeholderProbe(0),
					again: { result: placeholderResult(1), milliseconds: 0 },
				},
			],
			nonce,
		)!,
		wording,
		planRow: probingWording.planRow,
		input: verifierInput(["<claim>"], ["<dismissed>"], nonce),
		continue: continueJudging,
	};
}

/**
 * What a wave's outcome was judged under beyond its candidate: the verifier's version and the fixed text it is given. No
 * probe reruns: a wave never starts for a level that probes.
 */
export function waveIdentity(version: string): RecordJson {
	return requestJson({ version, text: verifierText(), reruns: {} });
}

/** The version a wave records and is compared under, so a wave stands only while the verifier's text is unchanged too. */
export function waveVersion(version: string): string {
	return KeyedRequest.of("verification.wave", waveIdentity(version)).key;
}

/**
 * A verification task's request, keyed by its input less the root and checkout, which name the host, the revision's
 * nonce, which is drawn afresh on every review, and the outcomes it reuses. It holds each candidate by its identity, the
 * fixed text the verifier is given beyond its version, `judges`, the own judgement of a probe of each lens whose claims
 * carry probe evidence, `cuts`, the probe evidence each candidate cut to fit is shown, or why it is asked nothing, and
 * `reruns`, the probe reruns this review read, which the verifier is shown.
 */
export function verificationRequest(
	{
		// A storage-local conversation ID and a checkout path name the host; the index the key is compared in is the root's own.
		root: _root,
		revision: { nonce, repoRoot: _repoRoot, ...revision },
		candidates,
		// Outcomes standing waves already reached for these candidates' identities; the commit checks each still stands.
		reused: _,
		...input
	}: VerificationInput,
	reruns: Record<string, ProbeRun> = {},
): KeyedRequest<RecordJson> {
	// The lenses whose claims carry probe evidence, whose verifier reads each one's own judgement of a probe.
	const judged = candidates.flatMap((candidate) =>
		candidate.state.claims
			.filter((claim) => candidate.probes?.[probeClaimKey(claim)] !== undefined)
			.map((claim) => candidate.probes![probeClaimKey(claim)]!.probesAs ?? lensOf(claim.source)),
	);
	const cuts = Object.fromEntries(
		candidates.flatMap((candidate) => {
			const cut = cutEvidence(candidate, reruns, nonce);
			return cut === undefined ? [] : [[candidate.key, cut]];
		}),
	);
	return KeyedRequest.of(
		"verification",
		requestJson({
			...input,
			revision,
			candidates: candidates.map(candidateIdentity),
			text: verifierText(),
			...(judged.length === 0
				? {}
				: { judges: Object.fromEntries(judged.map((lens) => [lens, evidenceWordingOf(lens).judge])) }),
			// A request with no cut candidate keeps the key it had before cuts.
			...(Object.keys(cuts).length === 0 ? {} : { cuts }),
			reruns,
		}),
		{ nonce },
	);
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
		if (!stillOwns(indexed, lensTask) || indexed?.verification !== undefined) return [];
		const waves = VerificationWaves.of(state, revision, lensTask);
		return input.candidates.filter(
			(candidate) =>
				waves.standing(
					candidateKey(candidate),
					candidate.state.claims.map(claimKey),
					waveVersion(input.version),
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
			version: waveVersion(input.version),
			candidates: fresh.map((candidate) => ({
				key: candidateKey(candidate),
				claims: candidate.state.claims.map(claimKey),
			})),
		});
		return created;
	}, context);
}

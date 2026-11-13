import type { StoredVerificationState } from "@melian-agent/core";
import { type ConversationId, defineDoc, type JsonObject, type Tx } from "./harness.ts";
import type { ReviewIndexState } from "./review-index.ts";

// `version` is the verifier version the wave ran under; a later version never reuses its outcome.
type Wave = { task: number; version: string; candidates: { key: string; claims: string[] }[] };
// What one lens task's ended lenses started: the outcome of each run by key, as the task recorded it when its lens
// ended, and the verification tasks the review started from them, oldest first.
type WaveEntry = { lensTask: number; ended: Record<string, JsonObject>; waves: Wave[] };
export type VerificationWavesState = { reviews: Record<string, WaveEntry> };

// Verification started while a review's lens task still ran, keyed by `Revision.key`. A lens task that replaces
// another starts its entry afresh, so a wave of the replaced run is named nowhere and the sweep aborts it.
export const VerificationWavesDocument = defineDoc<VerificationWavesState>({
	kind: "melian.verification-waves",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ reviews: {} }),
});

/** A claim's identity across waves: its finding and the producer that sighted it. */
export function claimKey(claim: StoredVerificationState["claims"][number]): string {
	return `${claim.id} ${claim.source.check}@${claim.source.version ?? ""}`;
}

/** The verification a review started for one revision while its lens task ran. */
export class VerificationWaves {
	readonly #entry: WaveEntry | undefined;

	private constructor(entry: WaveEntry | undefined) {
		this.#entry = entry;
	}

	/** The waves `lensTask` started at `revision`; none when the entry belongs to another lens task. */
	static of(
		state: Readonly<VerificationWavesState> | null | undefined,
		revision: string,
		lensTask: number | undefined,
	) {
		const entry = state?.reviews[revision];
		return new VerificationWaves(entry !== undefined && entry.lensTask === lensTask ? entry : undefined);
	}

	/** Starts `lensTask`'s entry at `revision`, unless it has one, and returns it. */
	static async open(tx: Tx, root: ConversationId, revision: string, lensTask: number): Promise<WaveEntry> {
		const state = await tx.doc(VerificationWavesDocument, root);
		if (state.reviews[revision]?.lensTask !== lensTask) state.reviews[revision] = { lensTask, ended: {}, waves: [] };
		return state.reviews[revision]!;
	}

	/**
	 * Whether the index names `task` as `revision`'s verification, or as a wave of the lens task it names that no later
	 * wave superseded by verifying any of its claims.
	 */
	static owns(
		index: Readonly<ReviewIndexState> | null | undefined,
		state: Readonly<VerificationWavesState> | null | undefined,
		revision: string,
		task: number | undefined,
	): boolean {
		// A verifier an older Melian created names no task, and an index with no verification would match it.
		if (task === undefined) return false;
		const entry = index?.reviews[revision];
		if (entry?.verification?.task === task) return true;
		const waves = VerificationWaves.of(state, revision, entry?.task).#entry?.waves ?? [];
		const at = waves.findIndex((wave) => wave.task === task);
		if (at < 0) return false;
		const claims = new Set(waves[at]!.candidates.flatMap((candidate) => candidate.claims));
		return waves
			.slice(at + 1)
			.every((later) =>
				later.candidates.every((candidate) => candidate.claims.every((claim) => !claims.has(claim))),
			);
	}

	ended(): Readonly<Record<string, JsonObject>> {
		return this.#entry?.ended ?? {};
	}

	tasks(): number[] {
		return (this.#entry?.waves ?? []).map((wave) => wave.task);
	}

	/**
	 * The wave whose verification of the candidate `key` still stands under verifier `version`: the latest wave that
	 * verified it, when it ran under that version and no later wave verified any of its claims as part of another
	 * candidate.
	 */
	standing(key: string, claims: readonly string[], version: string): number | undefined {
		const waves = this.#entry?.waves ?? [];
		for (let index = waves.length - 1; index >= 0; index--) {
			const wave = waves[index]!;
			if (wave.candidates.some((candidate) => candidate.key === key))
				return wave.version === version ? wave.task : undefined;
			if (wave.candidates.some((candidate) => candidate.claims.some((claim) => claims.includes(claim))))
				return undefined;
		}
		return undefined;
	}
}

import {
	type Defect,
	injectionAttemptRuleId,
	LineMap,
	type LineSpan,
	type ProvingHunk,
	Revision,
	snippetHash,
	VerificationState,
} from "@melian-agent/core";
import {
	type DismissedRoot,
	dismissedRoots,
	FindingsDocument,
	overlapsSite,
	proofAt,
	type Restating,
	readsProof,
} from "./findings.ts";
import type { Context, ConversationId, Harness } from "./harness.ts";
import { provingHunk, type ReviewState } from "./lens-tools.ts";
import type { DismissedPredecessor } from "./verification.ts";

/**
 * The dismissed findings a live lens defect at one revision may restate, by every condition Melian answers itself: the
 * root's rule and file, its dismissal standing at the revision, its region unchanged by git between the head that last
 * showed it and this one, and its proof holding the defect's. The verifier then judges sameness.
 */
export class Predecessors {
	readonly #roots: readonly DismissedRoot[];
	readonly #proof: (ids: readonly string[]) => ProvingHunk[];
	readonly #review: ReviewState;
	readonly #maps = new Map<string, Promise<LineMap>>();

	private constructor(
		roots: readonly DismissedRoot[],
		proof: (ids: readonly string[]) => ProvingHunk[],
		review: ReviewState,
	) {
		this.#roots = roots;
		this.#proof = proof;
		this.#review = review;
	}

	/** Reads the roots the findings document holds now, for a review of `review`, stored under `revision`. */
	static async open(
		reader: Pick<Harness, "snapshot">,
		root: ConversationId,
		revision: string,
		review: ReviewState,
		context: Context,
	): Promise<Predecessors> {
		const state = (await reader.snapshot(FindingsDocument, root, context)) ?? FindingsDocument.definition.initial();
		// A root sighted at a revision whose review began after this one's would carry a later ruling backwards.
		const at = state.revisions.indexOf(revision);
		const roots = dismissedRoots(state).filter((each) => state.revisions.indexOf(each.revision) <= at);
		return new Predecessors(roots, (ids) => proofAt(state, ids, revision), review);
	}

	/**
	 * The roots `defect` may restate, as the verifier is shown them, in ID order, with what `recordInheritances` reads of
	 * the defect; `undefined` when it has none.
	 */
	async of(defect: Defect): Promise<{ dismissed: DismissedPredecessor[]; restating: Restating } | undefined> {
		const found = await this.#find(defect);
		if (found.length === 0) return undefined;
		const { claims } = VerificationState.from(defect.speaker);
		return {
			dismissed: found.map((root) => structuredClone(root.claim)),
			restating: {
				members: Predecessors.#members(defect),
				claims: claims.map(({ id, source, ruleId }) => ({ id, source, ruleId })),
				dismissed: found.map(({ id, dismissal }) => ({ id, dismissal })),
			},
		};
	}

	static #members(defect: Defect): string[] {
		return [defect.speaker.id, ...defect.members.map((member) => member.id)];
	}

	async #find(defect: Defect): Promise<DismissedRoot[]> {
		const { speaker } = defect;
		if (!defect.lensOnly()) return [];
		const { claims } = VerificationState.from(speaker);
		const [first] = claims;
		if (first === undefined || claims.some((claim) => claim.ruleId !== first.ruleId)) return [];
		if (first.ruleId === injectionAttemptRuleId) return [];
		const members = Predecessors.#members(defect);
		const [line, endLine] = speaker.lines();
		const current = { startLine: line, endLine };
		const path = speaker.properties.path;
		const proof = this.#proof(members);
		const found: DismissedRoot[] = [];
		for (const root of this.#roots) {
			if (members.includes(root.id) || root.ruleId !== first.ruleId || root.path !== path) continue;
			if (!this.#stands(root)) continue;
			if (!proof.every((hunk) => root.accepted.some((each) => each.file === hunk.file && each.hash === hunk.hash)))
				continue;
			const old = { startLine: root.line, endLine: root.endLine };
			const map = await this.#map(root);
			const mapped = map?.map(old);
			if (map === undefined || mapped === undefined || !map.untouched(old, current)) continue;
			const at = (span: LineSpan) => ({ path, ruleId: first.ruleId, line: span.startLine, endLine: span.endLine });
			if (!overlapsSite(at(mapped), at(current))) continue;
			found.push(root);
		}
		return found;
	}

	// Whether the root's dismissal still stands at this revision, by the reopen rule its own sighting here would meet:
	// every hunk a root's proof accepted is here, whatever cause its latest sighting cites, and otherwise an introduced
	// root's accepted trigger is a hunk of its file here. A pre-existing root with no proof names no hunk, so the region
	// alone decides.
	#stands(root: DismissedRoot): boolean {
		const hunks = this.#review.files.flatMap((file) => file.hunks);
		if (readsProof(root.proof, root.cause))
			return root.proof.every((each) =>
				hunks.some((hunk) => provingHunk(hunk).file === each.file && provingHunk(hunk).hash === each.hash),
			);
		if (root.cause === "introduced")
			return hunks.some((hunk) => hunk.file === root.path && snippetHash(hunk.added) === root.hash);
		return true;
	}

	#map(root: DismissedRoot): Promise<LineMap> | undefined {
		const from = Revision.parseKey(root.revision)?.head;
		if (from === undefined) return undefined;
		const key = `${from}\0${root.path}`;
		let map = this.#maps.get(key);
		if (map === undefined) {
			map = LineMap.between(this.#review.repoRoot, {
				from,
				to: this.#review.head,
				path: root.path,
				attributesFrom: this.#review.base,
			});
			this.#maps.set(key, map);
		}
		return map;
	}
}

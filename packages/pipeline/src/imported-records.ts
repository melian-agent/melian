import {
	type CheckPayload,
	canonicalJson,
	Decision,
	type DecisionRequest,
	KeyedRequest,
	type RecordEnvelope,
	type RecordJson,
	RecordSet,
	reviewPayloads,
	type SharedRecord,
	type StoredDecision,
	type StoredFinding,
	type TriagePayload,
	type Verification,
	type VerificationPayload,
	type Walkthrough,
	type WalkthroughPayload,
} from "@melian-agent/core";
import type { CheckRunRecord } from "./checks.ts";

// The kinds a review reuses, each with the one payload version this build reads. A round, an account and the kinds a
// command writes, a dismissal among them, answer no request a producer asks.
const reusedKinds: Readonly<Record<string, number>> = { check: 1, lens: 1, verification: 1, walkthrough: 1, triage: 1 };

// A payload of a later version than this build reads is a newer build's, so it is set aside and its producer runs,
// rather than failing the set and stopping every older build's review of the changeset.
function newer(record: SharedRecord): boolean {
	const payload = record.payload as { readonly v?: unknown } | null;
	const v = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload.v : undefined;
	return Number.isSafeInteger(v) && (v as number) > reusedKinds[record.kind]!;
}

/**
 * The records of one changeset that a review may reuse, imported from a store whose writers the base trusts. A record
 * counts only when it names this changeset and is of a kind a review reuses, in a payload version this build reads;
 * every other is set aside before its payload is checked. A counted record whose payload its check refuses fails the
 * set, by {@link RecordSet.of}. No record carries a decision: a match only answers a request whose key it shares.
 */
export class ImportedRecords {
	readonly changeset: string;
	readonly #set: RecordSet;

	private constructor(changeset: string, set: RecordSet) {
		this.changeset = changeset;
		this.#set = set;
	}

	/** The records of `changeset` among `envelopes` that a review may reuse. */
	static from(changeset: string, envelopes: Iterable<RecordEnvelope>): ImportedRecords {
		const set = RecordSet.of(envelopes, {
			counts: (record) =>
				record.changeset === changeset && Object.hasOwn(reusedKinds, record.kind) && !newer(record),
			payloads: reviewPayloads,
		});
		return new ImportedRecords(changeset, set);
	}

	/** Every record that counts, in ID order. */
	records(): readonly SharedRecord[] {
		return this.#set.records();
	}

	/**
	 * The record of `kind` at `revision` under `key` that a producer may stand on, or `undefined` when there is none, or
	 * when two records there disagree on anything but the check a review decided for them, so a clean record never hides
	 * one with findings and the producer runs instead.
	 */
	match(kind: string, revision: string, key: string): SharedRecord | undefined {
		const found = this.#set
			.records()
			.filter((record) => record.kind === kind && record.revision === revision && record.key === key);
		const [first] = found;
		if (first === undefined) return undefined;
		const facts = (record: SharedRecord) => {
			const { check: _, ...rest } = record.payload as { [field: string]: RecordJson };
			return canonicalJson(rest);
		};
		return found.every((record) => facts(record) === facts(first)) ? first : undefined;
	}

	/**
	 * The result of check `name` that the run of `request` at `base..head` stands on, and the findings it reported there;
	 * `undefined` when no record answers it. Only a check that ran answers: one that failed or skipped runs again, and so
	 * does `static.mutation`, whose record is never reused, and a run that left caller snapshots, which a record cannot
	 * restore.
	 */
	check(
		request: string,
		sides: { readonly base: string; readonly head: string },
		name: string,
	): { readonly result: CheckRunRecord; readonly sightings: readonly StoredFinding[] } | undefined {
		if (name === "static.mutation") return undefined;
		const key = KeyedRequest.of("check.record", { request, base: sides.base, head: sides.head, name }).key;
		const record = this.match("check", `${sides.base}..${sides.head}`, key);
		if (record === undefined) return undefined;
		const { result, sightings } = record.payload as unknown as CheckPayload;
		if (result.name !== name || result.status !== "ran" || result.snapshots !== null) return undefined;
		const { version, findings, notes } = result;
		return {
			result: { name, status: "ran", ...(version === null ? {} : { version }), findings, notes: [...notes] },
			sightings: sightings as unknown as StoredFinding[],
		};
	}

	/**
	 * The outcomes and claim verdicts that answer the verification of `request` at `revision`, or `undefined` unless one
	 * record answers it whole: every candidate done, by a model `refused` does not refuse, and every claim judged. Short of
	 * that, the verifier runs for every candidate.
	 */
	verification(
		request: string,
		revision: string,
		candidates: readonly { readonly key: string; readonly claims: readonly string[] }[],
		refused: (model: string) => boolean,
	):
		| {
				readonly outcomes: Readonly<Record<string, { readonly status: "done"; readonly model: string }>>;
				readonly claims: readonly {
					readonly id: string;
					readonly source: { readonly check: string; readonly version?: string };
					readonly verification: Verification;
				}[];
		  }
		| undefined {
		const record = this.match("verification", revision, request);
		if (record === undefined) return undefined;
		const payload = record.payload as unknown as VerificationPayload;
		const outcomes: Record<string, { status: "done"; model: string }> = {};
		for (const { candidate, outcome } of payload.outcomes)
			if (outcome.status === "done" && !refused(outcome.model))
				outcomes[candidate] = { status: "done", model: outcome.model };
		const judged = new Map(
			payload.claims.map(({ id, source, verification }) => [
				`${id} ${source.check}@${source.version ?? ""}`,
				{
					id,
					source:
						source.version === null ? { check: source.check } : { check: source.check, version: source.version },
					verification: verification as Verification,
				},
			]),
		);
		const claims = [];
		for (const candidate of candidates) {
			if (outcomes[candidate.key] === undefined) return undefined;
			for (const claim of candidate.claims) {
				const verdict = judged.get(claim);
				if (verdict === undefined) return undefined;
				claims.push(verdict);
			}
		}
		return {
			outcomes: Object.fromEntries(candidates.map(({ key }) => [key, outcomes[key]!])),
			claims,
		};
	}

	/**
	 * The decision that answers triage's `request`, keyed `key` at `revision`, or `undefined` when no record holds one
	 * whose answers still parse against the request's questions and choose as the record says. A record of a decider that
	 * failed answers nothing, and the decider is asked.
	 */
	triage(key: string, revision: string, request: DecisionRequest): StoredDecision | undefined {
		const decision = (this.match("triage", revision, key)?.payload as unknown as TriagePayload | undefined)?.decision;
		if (decision === undefined || decision === null) return undefined;
		const answers = decision.answers.map(({ question, distribution, chosen }) => ({
			question,
			distribution: Object.fromEntries(
				Object.entries(distribution).map(([option, weight]) => [option, weight / 1_000_000]),
			),
			chosen,
		}));
		const parsed = (() => {
			try {
				return Decision.parse(request, { answers }, { name: decision.decider, calibrated: decision.calibrated });
			} catch {
				return undefined;
			}
		})();
		if (parsed === undefined || answers.some(({ question, chosen }) => parsed.chosen(question) !== chosen))
			return undefined;
		return {
			questionSet: { ...decision.questionSet },
			decider: decision.decider,
			calibrated: decision.calibrated,
			...(decision.model === null ? {} : { model: decision.model }),
			answers,
		};
	}

	/**
	 * The walkthrough that answers the request keyed `key` at `revision` on light route `route`, or `undefined` when no
	 * record holds one that route wrote.
	 */
	walkthrough(key: string, revision: string, route: string): Walkthrough | undefined {
		const payload = this.match("walkthrough", revision, key)?.payload as unknown as WalkthroughPayload | undefined;
		if (payload === undefined || payload.route !== route) return undefined;
		return {
			summary: payload.summary,
			files: payload.files.map(({ path, summary }) => ({ path, summary })),
			...(payload.diagram === null ? {} : { diagram: payload.diagram }),
			...(payload.note === null ? {} : { note: payload.note }),
		};
	}
}

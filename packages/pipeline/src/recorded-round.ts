import {
	type AccountPayload,
	Adjudication,
	type CheckPayload,
	type CheckRecord,
	type ConfigFor,
	type DismissalPayload,
	type FindingSource,
	type LensPayload,
	type MelianConfig,
	type PolicyAt,
	type RecordEnvelope,
	RecordError,
	RecordSet,
	type RepositorySource,
	type Revision,
	reviewPayloads,
	type SharedRecord,
	type StoredFinding,
	type Verdict,
	type VerificationPayload,
} from "@melian-agent/core";
import { configsFor } from "./configurations.ts";
import { mergeSightings, type Producer, type SharedDismissal, type VerificationClaim } from "./findings.ts";
import { provingHunk, reviewFiles } from "./lens-tools.ts";
import { accountKey, inManifestOrder } from "./review-records.ts";

/** What a recorded round's verdict is decided under, which its records do not hold. */
export type RecordedRoundContext = {
	/** The revision the round reviewed, whose hunks let lens reports that one hunk caused merge. */
	readonly revision: Revision;
	/** The configuration for every path, used where no policy source is given. */
	readonly config: Pick<MelianConfig, "resolution" | "ruleAliases">;
	/** The checkout and the source per-path configuration is read from, as the review that wrote the round read it. */
	readonly repoRoot?: string;
	readonly policy?: RepositorySource;
	/** The IDs of findings an earlier revision sighted. Without them every finding reads as new. */
	readonly seenBefore?: readonly string[];
};

// The decided pieces a round's records hold, or why they cannot stand for the round.
type Pieces =
	| {
			readonly account: AccountPayload;
			readonly checks: CheckRecord[];
			readonly sightings: StoredFinding[];
			readonly claims: VerificationClaim[];
			readonly dismissals: ReadonlyMap<string, SharedDismissal>;
	  }
	| { readonly refused: string };

/**
 * One round of a changeset as its shared records hold it, read without the store of the review that wrote them. Its
 * verdict is decided from the records the round names by ID and nothing else, so it never passes a round the review
 * that wrote it would not. A round whose records are missing, refused, or do not account for every check reads as
 * not reviewed. A finding reads as dismissed when a dismissal record of the changeset that counts, the latest for its
 * ID, still meets every sighting by the host's reopen rule, and as new otherwise. A finding the host holds dismissed by
 * inheritance from another finding's dismissal reads as new here, so it blocks where the host's verdict would not.
 */
export class RecordedRound {
	readonly id: string;
	readonly #pieces: Pieces;

	private constructor(id: string, pieces: Pieces) {
		this.id = id;
		this.#pieces = pieces;
	}

	/**
	 * The round `id` among `records`, each checked by its kind's payload check. `counts` says whose records count, as
	 * `RecordSet.of` requires. A set that fails its checks reads as not reviewed rather than throwing.
	 */
	static of(records: Iterable<RecordEnvelope>, id: string, counts: (record: SharedRecord) => boolean): RecordedRound {
		let set: RecordSet;
		try {
			set = RecordSet.of(records, { counts, payloads: reviewPayloads });
		} catch (error) {
			if (!(error instanceof RecordError)) throw error;
			return new RecordedRound(id, { refused: `its records fail their checks: ${error.message}` });
		}
		return new RecordedRound(id, piecesOf(set, id));
	}

	/** Why the records cannot stand for the round, or `undefined` when they can. */
	refusal(): string | undefined {
		return "refused" in this.#pieces ? this.#pieces.refused : undefined;
	}

	/** The verdict the round's records decide under `context`, as the review's adjudication would decide it. */
	async verdict(context: RecordedRoundContext): Promise<Verdict> {
		const pieces = this.#pieces;
		if ("refused" in pieces) return notReviewed(this.id, pieces.refused, context);
		const producers: Producer[] = pieces.account.producers.map(({ check, version, ids }) => ({
			check,
			...(version === null ? {} : { version }),
			...(ids === null ? {} : { ids }),
		}));
		const hunks = reviewFiles(context.revision.files).flatMap((file) => file.hunks.map(provingHunk));
		const findings = mergeSightings(pieces.sightings, pieces.claims, producers, pieces.dismissals, hunks);
		const { repoRoot, policy } = context;
		const policies =
			repoRoot === undefined || policy === undefined ? undefined : await configsFor(repoRoot, policy, findings);
		const decidedUnder = pieces.account.resolutionPolicy;
		const readsUnder = policies?.fingerprint ?? null;
		if (decidedUnder !== readsUnder)
			return notReviewed(
				this.id,
				`was decided under ${decidedUnder === null ? "no resolution policy" : `resolution policy ${decidedUnder}`}, and ${readsUnder === null ? "the reader reads none" : `this checkout's reads ${readsUnder}`}`,
				context,
			);
		const config: PolicyAt | ConfigFor = policies ?? (() => context.config as ReturnType<ConfigFor>);
		return new Adjudication({
			findings,
			manifest: pieces.account.checks,
			checks: pieces.checks,
			config,
			allowSkip: pieces.account.allowSkip,
			// The host's round runs no verifier when every finding is dismissed, and its records then carry no claim of an
			// earlier round's verification, so a finding whose dismissal does not count here stays uncapped.
			verificationRan: pieces.account.checks.includes("verifier"),
			...(context.seenBefore === undefined ? {} : { seenBefore: context.seenBefore }),
			revision: context.revision,
		}).adjudicate();
	}
}

// A verdict of not reviewed that says why the round's records cannot stand for it.
function notReviewed(id: string, reason: string, context: RecordedRoundContext): Verdict {
	return new Adjudication({
		findings: [],
		manifest: ["records"],
		checks: [{ name: "records", status: "failed", reason: `round ${id} ${reason}` }],
		config: () => context.config as ReturnType<ConfigFor>,
	}).adjudicate();
}

function piecesOf(set: RecordSet, id: string): Pieces {
	const round = set.records().find((record) => record.id === id && record.kind === "round");
	if (round === undefined) return { refused: "is not among the records, or does not count" };
	const missing = set.missing(round);
	if (missing.length > 0)
		return { refused: `names records the set does not hold: ${missing.map((each) => each.id).join(", ")}` };
	const accountRecord = set.account(round);
	if (accountRecord === undefined) return { refused: "names no account, or more than one" };
	const account = accountRecord.payload as AccountPayload;
	const named = round.manifest()!.read.filter((entry) => entry.kind !== "account");
	const ids = named.map((entry) => entry.id).sort();
	if (accountRecord.key !== accountKey(round.revision ?? null, account) || account.records.join() !== ids.join())
		return { refused: "names an account of other records than its own" };
	const byId = new Map(set.records().map((record) => [record.id, record]));
	// A run that stands for its lens counts every finding; an escalated run's kept quick run counts only those it names.
	const producers = new Set(
		account.producers.filter(({ ids }) => ids === null).map(({ check, version }) => `${check}@${version ?? ""}`),
	);
	const checks: CheckRecord[] = [];
	let verifier: CheckRecord | undefined;
	const sightings: StoredFinding[] = [];
	const claims: VerificationClaim[] = [];
	for (const entry of named) {
		const record = byId.get(entry.id)!;
		if (record.kind === "check") {
			const { result, sightings: seen } = record.payload as CheckPayload;
			checks.push(present(result) as unknown as CheckRecord);
			sightings.push(...(seen as unknown as StoredFinding[]));
		} else if (record.kind === "lens") {
			const { name, version, level, check, sightings: seen } = record.payload as LensPayload;
			// A run that stands for its lens is a producer, and its record holds what adjudication decided of it.
			if (check === null && producers.has(`lens.${name}@${version}@${level}`))
				return { refused: `names the record of lens.${name} at ${level} without the check its run decided` };
			if (check !== null) checks.push(present(check) as unknown as CheckRecord);
			sightings.push(...(seen as unknown as StoredFinding[]));
		} else if (record.kind === "verification") {
			const { check, claims: judged } = record.payload as VerificationPayload;
			if (check === null) return { refused: "names a verification without the verifier's check" };
			verifier = present(check) as unknown as CheckRecord;
			claims.push(...(judged as unknown as VerificationClaim[]));
		}
	}
	// The host keeps one sighting, and one latest verdict, of a finding for each producer, so a round with two of either
	// stands for no review, and merging would let whichever came last decide.
	if (!once(sightings.map(({ properties }) => properties)))
		return { refused: "names one finding twice from one producer" };
	if (!once(claims)) return { refused: "judges one finding twice for one producer" };
	checks.push(...account.filled.map((each) => present(each) as unknown as CheckRecord));
	// The verifier's record follows every other check's, as the review appends it after the lenses.
	const ordered = [...inManifestOrder(account.checks, checks), ...(verifier === undefined ? [] : [verifier])];
	return { account, checks: ordered, sightings, claims, dismissals: dismissalsOf(set, round.changeset) };
}

// The latest dismissal of each finding among the set's dismissal records of `changeset`. A dismissal record names no
// round, so every round of the changeset reads it.
function dismissalsOf(set: RecordSet, changeset: string): Map<string, SharedDismissal> {
	const latest = new Map<string, SharedDismissal>();
	// Records come in ID order, so of two made at one time the greater ID stands.
	for (const record of set.records()) {
		if (record.kind !== "dismissal" || record.changeset !== changeset) continue;
		const { by, reason, at, trigger } = record.payload as DismissalPayload;
		const held = latest.get(record.key);
		if (held === undefined || held.at <= at) latest.set(record.key, { by, reason, at, trigger });
	}
	return latest;
}

function once(values: readonly { readonly id: string; readonly source: FindingSource }[]): boolean {
	return (
		new Set(values.map(({ id, source }) => `${id} ${source.check}@${source.version ?? ""}`)).size === values.length
	);
}

// A stored value with each `null` field left out, as the check record it was written from left it out.
function present(value: object): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, field]) => field !== null)
			.map(([name, field]) => [
				name,
				typeof field === "object" && !Array.isArray(field) ? present(field as object) : field,
			]),
	);
}

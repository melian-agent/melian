import {
	type AccountPayload,
	Adjudication,
	type ChangedFile,
	type CheckPayload,
	type CheckRecord,
	type ConfigFor,
	type DismissalPayload,
	type Finding,
	type FindingSource,
	Lens,
	LensError,
	type LensPayload,
	loadConfig,
	type MelianConfig,
	type ProvingHunk,
	type RecordEnvelope,
	RecordError,
	RecordSet,
	type RepositorySource,
	Revision,
	reviewPayloads,
	type SharedRecord,
	type StoredFinding,
	scrutinyLevels,
	type Verdict,
	type VerificationPayload,
} from "@melian-agent/core";
import { configsFor } from "./configurations.ts";
import {
	mergeSightings,
	type Producer,
	type SharedDismissal,
	sharedDismissalHolds,
	type VerificationClaim,
} from "./findings.ts";
import { lensSource, provingHunk, reviewFiles } from "./lens-tools.ts";
import { accountKey, inManifestOrder } from "./review-records.ts";

/** What a recorded round's verdict is decided under, which its records do not hold. */
export type RecordedRoundContext = {
	/** The revision the round reviewed, whose hunks let lens reports that one hunk caused merge. */
	readonly revision: Revision;
	/** The configuration a refusal is decided under. A round is decided only under the policy source its account names. */
	readonly config: Pick<MelianConfig, "resolution" | "ruleAliases">;
	/**
	 * The checkout and the source per-path configuration is read from, as the review that wrote the round read it.
	 * Without both, the round reads as not reviewed.
	 */
	readonly repoRoot?: string;
	readonly policy?: RepositorySource;
	/** The IDs of findings an earlier revision sighted. Without them every finding reads as new. */
	readonly seenBefore?: readonly string[];
};

/** A dismissal record of a round's changeset, as a reader hands it over. */
export type SharedDismissalRecord = SharedDismissal & {
	/** The dismissal record's ID. */
	readonly record: string;
	/** The ID of the finding it dismisses. */
	readonly finding: string;
	/** The revision the dismissed sighting was seen at. */
	readonly revision: string;
	/** The IDs of the dismissal records this one names as superseded. */
	readonly supersedes: readonly string[];
};

/** What a round's records hold, for a caller that decides each sighting itself. */
export type RecordedRoundContents = {
	/** The revision the round reviewed, as its round record names it. */
	readonly revision: string;
	/** Every sighting the round's records hold, as each producer stored it. */
	readonly sightings: readonly StoredFinding[];
	/** The proving hunks of the revision, which a dismissal's trigger is met against. */
	readonly hunks: readonly ProvingHunk[];
	/**
	 * Every dismissal record of the round's changeset that counts, that no other supersedes, and that still holds, in
	 * record ID order.
	 */
	readonly dismissals: readonly SharedDismissalRecord[];
	/** Every such dismissal a round at another revision than the one it was made at ended, in record ID order. */
	readonly ended: readonly EndedDismissal[];
	/**
	 * Every such dismissal that counts for nothing because a round of the changeset names a record or an earlier round
	 * that neither the set nor the dismissal's frontier holds, so what that round cited is unknown, in record ID order.
	 * Its finding reads as live, as for a dismissal that no longer holds.
	 */
	readonly unjudged: readonly UnjudgedDismissal[];
};

/** A shared dismissal no reader can judge, since a round of its changeset names what the store does not hold. */
export type UnjudgedDismissal = {
	/** The ID of the finding it dismissed. */
	readonly finding: string;
	/** The dismissal record's ID. */
	readonly record: string;
	/** The round that names a record or round the store does not hold. */
	readonly round: string;
};

/** A shared dismissal that a round at another revision ended, until someone dismisses again. */
export type EndedDismissal = {
	/** The ID of the finding it dismissed. */
	readonly finding: string;
	/** The dismissal record's ID. */
	readonly record: string;
	/** The revision it was made at, the only one it holds for. */
	readonly madeAt: string;
	/** The round that reviewed another revision. */
	readonly round: string;
	/** The revision that round reviewed. */
	readonly at: string;
};

// The decided pieces a round's records hold, or why they cannot stand for the round.
type Pieces =
	| {
			readonly revision: string | undefined;
			readonly account: AccountPayload;
			readonly checks: CheckRecord[];
			readonly sightings: StoredFinding[];
			readonly claims: VerificationClaim[];
			// The findings the round asked its verifier about, by the ID of the finding that speaks for each.
			readonly asked: ReadonlySet<string>;
			readonly dismissals: readonly PendingDismissal[];
	  }
	| { readonly refused: string };

type Decided = Exclude<Pieces, { readonly refused: string }>;

// A dismissal record with every sighting of its finding in the rounds since it, all at the revision it was made at, or
// the round since it that reviewed another revision and so ended it.
type PendingDismissal =
	| { readonly dismissal: SharedDismissalRecord; readonly sightings: readonly StoredFinding[] }
	| { readonly ended: EndedDismissal }
	| { readonly unjudged: UnjudgedDismissal };

/**
 * One round of a changeset as its shared records hold it, read without the store of the review that wrote them. Its
 * verdict is decided from the records the round names by ID and nothing else, so it never passes a round the review
 * that wrote it would not. A round whose records are missing, refused, or do not account for every check reads as
 * not reviewed. A finding reads as dismissed when a dismissal record of the changeset that counts, and that no other
 * record of its finding supersedes, was made at the revision the round reviewed, no round since it reviewed another,
 * and every sighting since meets it by the host's reopen rule; it reads as new otherwise. A finding the host holds dismissed by
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

	/**
	 * What the round's records hold at `revision`, or why they cannot stand for the round there: a round is read only at
	 * the revision it reviewed, since a dismissal's trigger is met against that revision's hunks. A dismissal holds only
	 * for a round at the revision it was made at, and only while every round since it reviewed that revision and sighted
	 * its finding as the host's reopen rule keeps it, so a reader reads no other revision and needs no history.
	 */
	contents(revision: Revision): RecordedRoundContents | { readonly refused: string } {
		const pieces = this.#pieces;
		if ("refused" in pieces) return pieces;
		const asked = Revision.key(revision);
		if (asked !== pieces.revision) return { refused: `reviewed ${pieces.revision}, not ${asked}` };
		const hunks = hunksOf(revision.files);
		const dismissals: SharedDismissalRecord[] = [];
		const ended: EndedDismissal[] = [];
		const unjudged: UnjudgedDismissal[] = [];
		for (const pending of pieces.dismissals)
			if ("ended" in pending) ended.push(pending.ended);
			else if ("unjudged" in pending) unjudged.push(pending.unjudged);
			else if (sharedDismissalHolds(pending.dismissal, pending.sightings, hunks)) dismissals.push(pending.dismissal);
		return { revision: asked, sightings: pieces.sightings, hunks, dismissals, ended, unjudged };
	}

	/** The verdict the round's records decide under `context`, as the review's adjudication would decide it. */
	async verdict(context: RecordedRoundContext): Promise<Verdict> {
		const reviewed = await this.reviewed(context);
		return "refused" in reviewed ? notReviewed(this.id, reviewed.refused, context) : reviewed;
	}

	/**
	 * The verdict {@link verdict} gives when the round's records can stand for a review under `context`, or why they
	 * cannot, where {@link verdict} gives a verdict of not reviewed that says it.
	 */
	async reviewed(context: RecordedRoundContext): Promise<Verdict | { readonly refused: string }> {
		const decided = await this.#decided(context);
		if ("refused" in decided) return decided;
		const { pieces, policies } = decided;
		// A null fingerprint stands for no policy, never for any policy, so it matches nothing on either side.
		const decidedUnder = pieces.account.resolutionPolicy;
		if (decidedUnder === null)
			return { refused: "was decided under no resolution policy, so no reader can decide it" };
		if (policies === undefined) return { refused: "is read with no resolution policy to decide under" };
		if (decidedUnder !== policies.fingerprint)
			return {
				refused: `was decided under resolution policy ${decidedUnder}, and this checkout's reads ${policies.fingerprint}`,
			};
		return adjudicated(decided, policies, context);
	}

	/**
	 * The round's findings decided under the policy `context` reads, whatever policy the round's account names, or why
	 * its records cannot stand for it. A reader that counts a round's findings under its own policy takes them from here,
	 * and takes the round as reviewed only from {@link verdict}. With `unjudged: "uncapped"`, a finding the round's
	 * verifier was asked about and never judged keeps the resolution it would have without the advisory cap a host sets
	 * on it. A host sets that cap only on a round it reads as not reviewed, since a claim left unjudged fails the verifier.
	 */
	async findingsUnder(
		context: RecordedRoundContext,
		options: { readonly unjudged?: "capped" | "uncapped" } = {},
	): Promise<Verdict | { readonly refused: string }> {
		const decided = await this.#decided(context);
		if ("refused" in decided) return decided;
		if (decided.policies === undefined) return { refused: "is read with no resolution policy to decide under" };
		return adjudicated(decided, decided.policies, context, options.unjudged === "uncapped");
	}

	async #decided(context: RecordedRoundContext): Promise<Merged | { readonly refused: string }> {
		const contents = this.contents(context.revision);
		if ("refused" in contents) return contents;
		// `contents` refuses whatever the pieces refuse.
		const pieces = this.#pieces as Decided;
		const producers: Producer[] = pieces.account.producers.map(({ check, version, ids }) => ({
			check,
			...(version === null ? {} : { version }),
			...(ids === null ? {} : { ids }),
		}));
		const findings = mergeSightings(
			contents.sightings,
			pieces.claims,
			producers,
			byFinding(contents.dismissals),
			contents.hunks,
		);
		const { repoRoot, policy } = context;
		const policies =
			repoRoot === undefined || policy === undefined ? undefined : await configsFor(repoRoot, policy, findings);
		const verifies = repoRoot === undefined || policy === undefined ? undefined : await verifyingAt(repoRoot, policy);
		return { pieces, findings, policies, verifies: verifies ?? new Map() };
	}
}

// A round's findings merged from its records, with the policy the reader's checkout reads for them, if any, and which
// lens levels that policy verifies at.
type Merged = {
	readonly pieces: Decided;
	readonly findings: ReturnType<typeof mergeSightings>;
	readonly policies: Policies | undefined;
	readonly verifies: ReadonlyMap<string, boolean>;
};

type Policies = Awaited<ReturnType<typeof configsFor>>;

function adjudicated(
	{ pieces, findings, verifies }: Merged,
	policies: Policies,
	context: RecordedRoundContext,
	uncapAsked = false,
): Verdict {
	return new Adjudication({
		findings,
		manifest: pieces.account.checks,
		checks: pieces.checks,
		config: policies,
		allowSkip: pieces.account.allowSkip,
		// The host caps a finding no verifier judged when it asked about it, or when its lens ran only at levels that do
		// not verify. A finding it dismissed is neither, so a dismissal that does not count here leaves it uncapped.
		verificationRan: (report, defect) =>
			(!uncapAsked && pieces.asked.has(defect.id)) || unverifiedAt(verifies, report),
		...(context.seenBefore === undefined ? {} : { seenBefore: context.seenBefore }),
		revision: context.revision,
	}).adjudicate();
}

// The lenses the policy defines for the revision's paths, as the host's review loaded them; none when they fail to load,
// so no finding is capped.
// Whether each declared level of every lens the policy defines verifies, keyed by the source a run at that level
// reports under, as the lens loads and as the root's settings tune it, which `configsFor` lists the same way.
async function verifyingAt(repoRoot: string, policy: RepositorySource): Promise<ReadonlyMap<string, boolean>> {
	let lenses: Lens[];
	try {
		lenses = await Lens.everywhere(repoRoot, policy);
	} catch (error) {
		if (error instanceof LensError) return new Map();
		throw error;
	}
	const tuning = (await loadConfig(repoRoot, policy, ".")).config.lenses;
	const verifies = new Map<string, boolean>();
	for (const loaded of lenses) {
		const settings = Object.hasOwn(tuning, loaded.name) ? tuning[loaded.name] : undefined;
		for (const lens of [loaded, loaded.configured(settings)])
			for (const level of scrutinyLevels) {
				const declared = lens.levels[level];
				if (declared === undefined) continue;
				const { check, version } = lensSource(lens.name, lens.version, level);
				verifies.set(`${check}@${version}`, declared.verify);
			}
	}
	return verifies;
}

// A report no verifier judged is capped only when every source it was reported by is a level that does not verify. A
// source no lens of the policy matches by name, version and declared level leaves it uncapped.
function unverifiedAt(verifies: ReadonlyMap<string, boolean>, report: Finding): boolean {
	const { source, reportedBy = [source] } = report.properties;
	return reportedBy.every(({ check, version }) => verifies.get(`${check}@${version}`) === false);
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
	// Slots and supersession go by a dismissal's key and reopening reads its sighting, so a record whose two name other
	// findings could dismiss one finding with another's evidence.
	for (const record of set.records()) {
		if (record.kind !== "dismissal") continue;
		const sighted = ((record.payload as DismissalPayload).sighting.finding as unknown as StoredFinding).properties.id;
		if (record.key !== sighted)
			return { refused: `holds a dismissal record keyed ${record.key} whose sighting is of finding ${sighted}` };
	}
	const missing = set.missing(round);
	if (missing.length > 0)
		return { refused: `names records the set does not hold: ${missing.map((each) => each.id).join(", ")}` };
	const accountRecord = set.account(round);
	if (accountRecord === undefined) return { refused: "names no account, or more than one" };
	if ((accountRecord.payload as { v: number }).v === 1)
		return { refused: "names an account written before accounts named their resolution policy" };
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
	const asked = new Set<string>();
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
			const { check, claims: judged, outcomes } = record.payload as VerificationPayload;
			if (check === null) return { refused: "names a verification without the verifier's check" };
			verifier = present(check) as unknown as CheckRecord;
			claims.push(...(judged as unknown as VerificationClaim[]));
			for (const { candidate } of outcomes) asked.add(candidate);
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
	return {
		revision: round.revision,
		account,
		checks: ordered,
		sightings,
		claims,
		asked,
		dismissals: dismissalsOf(set, round),
	};
}

// The set's dismissal records of `round`'s changeset that no other supersedes, in ID order. A dismissal record names
// no round to apply to, so every round of the changeset reads it. Superseding only removes a dismissal, so it can only
// make a round stricter. A dismissal holds only for the revision it was made at: `round`, or any round since it, at
// another revision ends it, as a push does, whatever that round sighted, so no host's memory of another revision is
// needed. A dismissal whose rounds since cannot be known counts for nothing, which leaves its finding live, and so does
// one whose record names no frontier: no record written before the field held one, and no shared store holds such a
// record yet.
function dismissalsOf(set: RecordSet, round: SharedRecord): PendingDismissal[] {
	return set
		.unsuperseded()
		.filter((record) => record.kind === "dismissal" && record.changeset === round.changeset)
		.flatMap((record): PendingDismissal[] => {
			const { by, reason, at, trigger, sighting, frontier } = record.payload as DismissalPayload;
			if (frontier === undefined) return [];
			const since = roundsSince(set, round, frontier);
			const { id, key, supersedes } = record;
			if ("unknown" in since) return [{ unjudged: { finding: key, record: id, round: since.unknown } }];
			// A round always names its revision, as the record's own check requires.
			const moved = [round, ...since].find((each) => each.revision !== sighting.revision);
			if (moved !== undefined)
				return [
					{
						ended: { finding: key, record: id, madeAt: sighting.revision, round: moved.id, at: moved.revision! },
					},
				];
			const dismissal = {
				record: id,
				finding: key,
				revision: sighting.revision,
				supersedes,
				by,
				reason,
				at,
				trigger,
			};
			const sightings = since
				.flatMap((each) => sightingsOf(set, each))
				.filter(({ properties }) => properties.id === key);
			return [{ dismissal, sightings }];
		});
}

// The rounds of `round`'s changeset whose sightings test a dismissal whose writer held `frontier`, `round` among them
// unless the writer held it: every round of the changeset in the set outside `frontier`, in the set's ID order and
// whatever its place, so a round another host wrote, which the writer never met, ends or reopens it on time.
// `unknown` names the first of `round` and the tested rounds that names a record the set does not hold, or follows a
// round that neither the set nor the writer held, since what that round cited is unknown. That is the one thing
// `before` still decides.
function roundsSince(
	set: RecordSet,
	round: SharedRecord,
	frontier: readonly string[],
): SharedRecord[] | { readonly unknown: string } {
	const rounds = new Map(
		set
			.records()
			.filter((record) => record.kind === "round" && record.changeset === round.changeset)
			.map((record) => [record.id, record]),
	);
	const held = new Set(frontier);
	const tested = [...rounds.values()].filter((each) => !held.has(each.id));
	const unknown = [round, ...tested].find(
		(each) => set.missing(each).length > 0 || !each.manifest()!.before.every((id) => held.has(id) || rounds.has(id)),
	);
	return unknown === undefined ? tested : { unknown: unknown.id };
}

// The proving hunks of a revision that changes `files`, as a lens cites them.
function hunksOf(files: readonly ChangedFile[]): ProvingHunk[] {
	return reviewFiles(files).flatMap((file) => file.hunks.map(provingHunk));
}

// The sightings of the lens and check records `round` names. A dismissal record's own sighting adds none: its trigger's
// proof already holds every hunk that sighting cites.
function sightingsOf(set: RecordSet, round: SharedRecord): StoredFinding[] {
	const named = new Set(round.manifest()!.read.map(({ id }) => id));
	return set
		.records()
		.filter((record) => named.has(record.id) && (record.kind === "lens" || record.kind === "check"))
		.flatMap((record) => (record.payload as { sightings: unknown[] }).sightings as StoredFinding[]);
}

// The standing dismissals of each finding, in ID order, so of two made at one time the greater ID stands.
function byFinding(dismissals: readonly SharedDismissalRecord[]): Map<string, SharedDismissal[]> {
	const standing = new Map<string, SharedDismissal[]>();
	for (const { finding, by, reason, at, trigger } of dismissals)
		standing.set(finding, [...(standing.get(finding) ?? []), { by, reason, at, trigger }]);
	return standing;
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

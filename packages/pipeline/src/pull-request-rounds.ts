import {
	type MembershipCandidate,
	MembershipError,
	type PullRequestRoundHeads,
	type RoundMembership,
} from "@melian-agent/core";
import { CompareError } from "./compare.ts";
import {
	backgroundContext,
	type Context,
	defineDoc,
	type JsonObject,
	ROOT_CONVERSATION_ID,
	type Storage,
} from "./harness.ts";
import { PublisherDocument } from "./publish.ts";
import { legacyKey, RoundReader } from "./rounds.ts";

/** A numbered round, retaining its number when its commit or storage becomes unreachable. */
export type PullRequestRoundMember = RoundMembership & { number: number };
/** One complete, numbered membership answer. Earlier versions remain in the root document. */
export type PullRequestRoundSnapshot = {
	version: number;
	at: string;
	answer: PullRequestRoundHeads;
	members: PullRequestRoundMember[];
	foreign: RoundMembership[];
	ambiguous: RoundMembership[];
	unattributed: RoundMembership[];
	warnings: string[];
	audit: { round: string; by: string; at: string; reason: string }[];
};
type SnapshotState = { versions: PullRequestRoundSnapshot[] };

export const PullRequestRoundsDocument = defineDoc<SnapshotState>({
	kind: "melian.pull-request-rounds",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ versions: [] }),
});

/** Builds the next membership version without mutating the saved answer on a refusal. */
export class PullRequestRoundHistory {
	readonly versions: PullRequestRoundSnapshot[];

	private constructor(versions: PullRequestRoundSnapshot[]) {
		this.versions = structuredClone(versions);
	}
	/** Wraps stored snapshot versions. */
	static from(versions: PullRequestRoundSnapshot[]): PullRequestRoundHistory {
		return new PullRequestRoundHistory(versions);
	}
	/** The current answer, absent before the first refresh. */
	current(): PullRequestRoundSnapshot | undefined {
		return this.versions.at(-1);
	}
	/** Creates an audited new version; newly rejected members require explicit acceptance. */
	refresh(
		answer: PullRequestRoundHeads,
		classified: RoundMembership[],
		by: string,
		at: string,
		accept: boolean,
	): PullRequestRoundSnapshot {
		const prior = this.current();
		const previous = prior?.members ?? [];
		const members = classified.filter((round) => round.status === "member");
		const rejected: RoundMembership[] = [];
		for (const old of previous) {
			const now = classified.find((round) => round.id === old.id);
			if (now === undefined || now.missingCommit !== undefined || now.status === "unreachable") {
				members.push({ ...old, status: "unreachable", reason: now?.reason ?? "storage or round is missing" });
			} else if (now.status !== "member") rejected.push(now);
		}
		if (rejected.length > 0 && !accept)
			throw new MembershipError(
				`refresh rejects earlier members: ${rejected.map((round) => `${round.id}: ${round.reason}`).join("; ")}; old snapshot kept; run melian compare refresh "#${answer.number}" --accept`,
			);
		const reserved = new Set(
			members
				.filter((round) => round.status === "unreachable")
				.map((round) => previous.find((old) => old.id === round.id)!.number),
		);
		let number = 0;
		members.sort((left, right) => {
			if (left.mintedAt === undefined && right.mintedAt !== undefined) return -1;
			if (left.mintedAt !== undefined && right.mintedAt === undefined) return 1;
			const a = left.mintedAt === undefined ? (left.date ?? Number.MAX_SAFE_INTEGER) : Date.parse(left.mintedAt);
			const b = right.mintedAt === undefined ? (right.date ?? Number.MAX_SAFE_INTEGER) : Date.parse(right.mintedAt);
			return a - b || left.id.localeCompare(right.id);
		});
		const numbered = members
			.map((round) => {
				if (round.status === "unreachable")
					return { ...round, number: previous.find((old) => old.id === round.id)!.number };
				do {
					number++;
				} while (reserved.has(number));
				return { ...round, number };
			})
			.sort((left, right) => left.number - right.number);
		const stores = new Set(numbered.map((round) => round.id.split(".")[0]));
		const memberIds = new Set(numbered.map((round) => round.id));
		const snapshot: PullRequestRoundSnapshot = {
			version: (prior?.version ?? 0) + 1,
			at,
			answer: structuredClone(answer),
			members: numbered,
			foreign: classified
				.filter(
					(round) =>
						!memberIds.has(round.id) &&
						(round.status === "foreign" || rejected.some((old) => old.id === round.id)),
				)
				.map((round) => ({ ...round, status: "foreign" })),
			ambiguous: classified.filter(
				(round) => round.status === "ambiguous" && !rejected.some((old) => old.id === round.id),
			),
			unattributed: classified.filter(
				(round) =>
					round.status === "unattributed" &&
					stores.has(round.id.split(".")[0]) &&
					!rejected.some((old) => old.id === round.id),
			),
			warnings: answer.forcePushes.some((push) => push.before === null)
				? ["A force push has no before commit; rounds at that head may be absent."]
				: [],
			audit: [
				...(prior?.audit ?? []),
				...rejected.map((round) => ({ round: round.id, by, at, reason: round.reason })),
			],
		};
		this.versions.push(snapshot);
		return structuredClone(snapshot);
	}
}

/** Reads round ownership and membership snapshots without opening a harness or resuming pending tasks. */
export class MembershipReader {
	private readonly storage: Storage;
	private constructor(storage: Storage) {
		this.storage = storage;
	}
	/** The caller retains and closes the storage. */
	static open(storage: Storage): MembershipReader {
		return new MembershipReader(storage);
	}
	/** Reads all saved snapshot versions, rejecting a document from newer code. */
	async history(context: Context = backgroundContext): Promise<PullRequestRoundHistory> {
		const state = await this.read<SnapshotState>(PullRequestRoundsDocument.definition, context);
		return PullRequestRoundHistory.from(state?.versions ?? []);
	}
	/** Reads every round and its publication target, including a legacy target's revision. */
	async candidates(
		changeset: string,
		ownership?: MembershipCandidate["publication"],
		context: Context = backgroundContext,
	): Promise<MembershipCandidate[]> {
		const rounds = await new RoundReader(this.storage).read(changeset, context);
		const publisher = await this.read<ReturnType<typeof PublisherDocument.definition.initial>>(
			PublisherDocument.definition,
			context,
		);
		const targets = publisher?.target === undefined ? [] : [publisher.target];
		let page = await this.storage.scanTasks({ kind: "melian.publish" }, 200, undefined, context);
		for (;;) {
			for (const task of page.items) {
				const target = (
					task.input as { target?: NonNullable<ReturnType<typeof PublisherDocument.definition.initial>["target"]> }
				).target;
				if (target !== undefined) targets.push(target);
			}
			if (page.next === undefined) break;
			page = await this.storage.scanTasks({ kind: "melian.publish" }, 200, page.next, context);
		}
		return rounds.map((round) => {
			const { base, head, mintedAt, provenance } = round.stored;
			const matching = targets.filter(
				(target) => `${changeset}.${target.roundId ?? legacyKey(target.revision)}` === round.id,
			);
			const target =
				matching.find(
					(target) =>
						ownership !== undefined &&
						target.repository.toLowerCase() ===
							`${ownership.repository.owner}/${ownership.repository.name}`.toLowerCase() &&
						target.pullRequest === ownership.pullRequest,
				) ?? matching[0];
			const repository = target?.repository.split("/");
			return {
				id: round.id,
				base,
				head,
				...(mintedAt === undefined ? {} : { mintedAt }),
				...(provenance === undefined ? {} : { provenance }),
				...(target !== undefined
					? {
							publication: {
								repository: { owner: repository![0]!, name: repository![1]! },
								pullRequest: target.pullRequest,
							},
						}
					: {}),
			};
		});
	}
	private async read<T>(
		definition: { kind: string; version: number; migrate?: (value: JsonObject, from: number) => T },
		context: Context,
	): Promise<T | undefined> {
		const record = await this.storage.findDocument(
			{ kind: definition.kind, scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } },
			"current",
			context,
		);
		if (record === undefined) return undefined;
		const stored = await this.storage.document(record.id, "current", context);
		if (stored === undefined) return undefined;
		if (stored.version > definition.version)
			throw new CompareError("unreadable", `${definition.kind} has newer version ${stored.version}`);
		return stored.version === definition.version
			? (stored.value as T)
			: definition.migrate!(stored.value, stored.version);
	}
}

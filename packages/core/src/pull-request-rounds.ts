import { git, gitOutput } from "./git.ts";

/** GitHub's complete answer about a pull request's commits and historical heads. */
export type PullRequestRoundHeads = {
	repository: { owner: string; name: string };
	number: number;
	base: string;
	head: string;
	merge: string | null;
	commits: string[];
	forcePushes: { before: string | null; after: string | null }[];
	associated: Record<string, number[]>;
};

/** The stored facts needed to attribute a round, independent of a storage backend. */
export type MembershipCandidate = {
	id: string;
	base: string;
	head: string;
	mintedAt?: string;
	provenance?: { kind: "range" | "pull-request"; repository?: { owner: string; name: string }; pullRequest?: number };
	publication?: { repository: { owner: string; name: string }; pullRequest: number };
};

/** A member or rejected round, with the first applicable membership rule. */
export type RoundMembership = MembershipCandidate & {
	status: "member" | "ambiguous" | "foreign" | "unattributed" | "unreachable";
	reason: string;
	otherPullRequests?: number[];
	date?: number;
	missingCommit?: string;
};

/** A pull request cannot be attributed safely from the available GitHub and Git facts. */
export class MembershipError extends Error {
	readonly code = "membership";
	constructor(message: string) {
		super(message);
		this.name = "MembershipError";
	}
}

/** Attributes rounds by ownership first, then the exact diff GitHub showed at a historical head. */
export class PullRequestMembership {
	readonly answer: PullRequestRoundHeads;
	private readonly repoRoot: string;
	private readonly base: string;
	private readonly heads: Set<string>;

	private constructor(repoRoot: string, answer: PullRequestRoundHeads, base: string) {
		this.repoRoot = repoRoot;
		this.answer = answer;
		this.base = base;
		this.heads = new Set([
			answer.head,
			...answer.commits,
			...answer.forcePushes.flatMap(({ before, after }) =>
				[before, after].filter((oid): oid is string => oid !== null),
			),
		]);
	}

	/** Resolves a merged pull request's first parent and refuses truncated lists or fast-forward merges. */
	static async open(repoRoot: string, answer: PullRequestRoundHeads): Promise<PullRequestMembership> {
		if (answer.commits.length >= 250)
			throw new MembershipError(
				"GitHub caps pull request commits at 250; membership is incomplete; an explicit range --round write remains available",
			);
		let base = answer.base;
		if (answer.merge !== null) {
			if ((await git(repoRoot, ["cat-file", "-e", `${answer.merge}^{commit}`])).code !== 0)
				await git(repoRoot, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", answer.merge]);
			const parents = (await gitOutput(repoRoot, ["show", "-s", "--format=%P", answer.merge])).trim().split(" ");
			base = parents[0]!;
			if (!base || answer.commits.includes(base))
				throw new MembershipError(
					"fast-forward merge cannot establish the pull request diff; an explicit range --round write remains available",
				);
		}
		return new PullRequestMembership(repoRoot, answer, base);
	}

	/** Classifies one detached round, fetching a missing candidate commit once before rejecting it. */
	async classify(candidate: MembershipCandidate): Promise<RoundMembership> {
		const owned = candidate.provenance?.kind === "pull-request" ? candidate.provenance : candidate.publication;
		if (owned !== undefined) {
			const repository = owned.repository;
			const stamp = await git(this.repoRoot, ["show", "-s", "--format=%ct", candidate.head]).catch(() => undefined);
			const member =
				repository !== undefined &&
				repository.owner.toLowerCase() === this.answer.repository.owner.toLowerCase() &&
				repository.name.toLowerCase() === this.answer.repository.name.toLowerCase() &&
				owned.pullRequest === this.answer.number;
			return {
				...candidate,
				status: member ? "member" : "foreign",
				reason: member ? "stored pull request ownership" : "stored ownership names another pull request",
				...(stamp === undefined || stamp.code !== 0 ? {} : { date: Number(stamp.stdout.trim()) * 1000 }),
			};
		}
		if (!this.heads.has(candidate.head))
			return { ...candidate, status: "unattributed", reason: "GitHub no longer names this head" };
		for (const oid of [candidate.head, candidate.base, this.base]) {
			let present = await git(this.repoRoot, ["cat-file", "-e", `${oid}^{commit}`]);
			if (present.code !== 0) {
				await git(this.repoRoot, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", oid]);
				present = await git(this.repoRoot, ["cat-file", "-e", `${oid}^{commit}`]);
			}
			if (present.code !== 0)
				return {
					...candidate,
					status: "foreign",
					reason: `commit ${oid} is missing after fetch`,
					missingCommit: oid,
				};
		}
		const result = await git(this.repoRoot, ["merge-base", "--all", this.base, candidate.head]);
		if (result.code !== 0)
			return { ...candidate, status: "foreign", reason: "head has no merge base with the pull request base" };
		const bases = result.stdout.trim().split("\n");
		const trees = await Promise.all(bases.map((base) => gitOutput(this.repoRoot, ["rev-parse", `${base}^{tree}`])));
		if (new Set(trees).size !== 1)
			throw new MembershipError(
				`round ${candidate.id} has merge bases with different trees; GitHub's diff is ambiguous; an explicit range --round write remains available`,
			);
		if (!bases.includes(candidate.base))
			return { ...candidate, status: "foreign", reason: "stored base is not an exact pull request merge base" };
		const others = (this.answer.associated[candidate.head] ?? []).filter((number) => number !== this.answer.number);
		const date =
			Number((await gitOutput(this.repoRoot, ["show", "-s", "--format=%ct", candidate.head])).trim()) * 1000;
		return {
			...candidate,
			status: others.length === 0 ? "member" : "ambiguous",
			reason: others.length === 0 ? "exact pull request merge base" : "head is associated with other pull requests",
			date,
			...(others.length === 0 ? {} : { otherPullRequests: others }),
		};
	}
	/** Checks availability for a previously accepted head, without changing its ownership attribution. */
	async headAvailable(head: string): Promise<boolean> {
		if ((await git(this.repoRoot, ["cat-file", "-e", `${head}^{commit}`])).code === 0) return true;
		await git(this.repoRoot, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", head]);
		return (await git(this.repoRoot, ["cat-file", "-e", `${head}^{commit}`])).code === 0;
	}
}

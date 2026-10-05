import { createHash } from "node:crypto";
import type { StoredVerdict, Verdict } from "./adjudication.ts";
import type { Finding, FindingDismissal } from "./findings.ts";

/** A pull request as its provider reports it. Commit hashes are full. */
export interface PullRequest {
	/** The repository the pull request belongs to, as the provider names it. */
	readonly repository: { readonly owner: string; readonly name: string };
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly state: "open" | "closed";
	/** The branch the pull request merges into, and its commit as the provider last saw it. */
	readonly base: { readonly ref: string; readonly sha: string };
	readonly head: { readonly ref: string; readonly sha: string };
	/** A git URL the pull request's commits can be fetched from, and the ref there that holds its head. */
	readonly fetch: { readonly url: string; readonly headRef: string };
}

/**
 * The lines a revision adds or changes, by repository-relative path: inclusive `[first, last]` ranges at head, in line
 * order. Only these lines take an inline comment that is sure to land.
 */
export type DiffLines = Readonly<Record<string, readonly (readonly [number, number])[]>>;

/**
 * Where a finding is posted.
 *
 * - `lines`: on the changed lines it covers, from `startLine` to `line`.
 * - `nearest`: outside the diff in a file the change touches, so on the changed line nearest its location, with a link
 *   to where it is.
 * - `body`: in a file the change does not touch, so in the review's body, which has no line to anchor to.
 */
export type Placement =
	| { readonly kind: "lines"; readonly startLine: number; readonly line: number }
	| { readonly kind: "nearest"; readonly line: number }
	| { readonly kind: "body" };

/** A finding posted with its placement. */
export interface PlacedFinding {
	readonly finding: Finding;
	readonly placement: Placement;
}

/** A finding as a pull request carries it once posted: enough to name it, and the thread it started, if any. */
export interface PublishedFinding {
	readonly ruleId: string;
	readonly path: string;
	readonly line: number;
	/** The head commit of the revision that posted it. */
	readonly revision: string;
	/** The provider's ID of the comment that starts its thread. A finding posted in a review's body has none. */
	readonly thread?: string;
}

/**
 * A finding an earlier revision published that this revision no longer reports, or that someone dismissed, in which
 * case `dismissal` says who, when, and why.
 */
export interface ClosedFinding extends PublishedFinding {
	readonly id: string;
	readonly dismissal?: FindingDismissal;
	/** The head that first recorded this resolution, kept when a later publication carries it. */
	readonly addressedIn?: string;
}

/**
 * A dismissal's version: the first 16 hex digits of a SHA-256 over its reason, dismisser, and time. A reply giving a
 * dismissal names it, so a dismissal whose reason changed is answered again rather than taken as answered.
 */
export function dismissalVersion({ by, reason, at }: FindingDismissal): string {
	return createHash("sha256")
		.update(JSON.stringify([reason, by, at]))
		.digest("hex")
		.slice(0, 16);
}

/**
 * The key a reply in a finding's thread is recorded and found under: the finding's ID, the thread, and, for a reply
 * giving a dismissal, its {@link dismissalVersion}. A finding reposted in a new thread, or dismissed again with another
 * reason, takes a reply of its own.
 */
export function replyKey(id: string, thread: string, dismissal?: string): string {
	return [id, thread, ...(dismissal === undefined ? [] : [dismissal])].join(" ");
}

/** What one revision's publication posts, as `Verdict.publication` decides it. */
export interface PublicationPlan {
	/** Findings that need attention and were not open before, each with its placement. */
	readonly post: readonly PlacedFinding[];
	/** Findings an earlier revision posted that still need attention. They are not posted again. */
	readonly stillOpen: readonly string[];
	/** Findings an earlier revision posted that this revision no longer reports, or that were dismissed since. */
	readonly resolved: readonly ClosedFinding[];
	/**
	 * Every finding with a thread or a place on the pull request once this revision is published, by ID, quiet ones
	 * included. Threads for the findings this revision posts come from the post.
	 */
	readonly open: Readonly<Record<string, PublishedFinding>>;
	/**
	 * Each dismissal in the verdict by the ID of every report it dismissed: the dismissed finding's own and each one
	 * adjudication merged into it, so a finding posted under a report's ID that now speaks through another is answered
	 * with the dismissal, not as though the revision no longer reported it. A merged report dismissed on its own maps to
	 * its own dismissal, and only one without maps to the finding's.
	 */
	readonly dismissals: Readonly<Record<string, FindingDismissal>>;
}

/** A commit status: `success`, `failure`, or `error`, with a description for the author. */
export interface ReviewStatus {
	readonly state: "success" | "failure" | "error";
	readonly description: string;
}

/** One revision's review, ready for a provider to post. */
export interface ReviewDraft {
	readonly pullRequest: number;
	/** The head commit reviewed. */
	readonly revision: string;
	/** The base commit the review diffed from, where evidence on lines the change deleted is read. */
	readonly base: string;
	/**
	 * Names the verdict this review posts. A second review of one head can change its verdict, and each verdict
	 * published at a head is its own review, so the marker that finds a review names the verdict as well as the head.
	 */
	readonly fingerprint: string;
	/**
	 * The review's round at this head, counting from 1 and never reused. A verdict can recur, A then B then A, and only
	 * the round tells the third review from the first.
	 */
	readonly round: number;
	readonly verdict: Verdict;
	/** The findings to post, each with its placement. */
	readonly findings: readonly PlacedFinding[];
	/** How many findings an earlier revision posted that still need attention. */
	readonly stillOpen: number;
	/** Resolved and dismissed findings that have no thread to reply in, so the body names them. */
	readonly resolved: readonly ClosedFinding[];
	/** The changeset's publisher secret, as hex, which signs every marker the review carries. Never printed. */
	readonly secret: string;
}

/** A review a provider posted. */
export interface PostedReview {
	readonly id: string;
	/** The comment that starts each inline finding's thread, by finding ID. A finding in the body has none. */
	readonly threads: Readonly<Record<string, string>>;
}

/** What a pull request already shows of one revision's publication, read from Melian's markers. */
export interface PublishedMarkers {
	/** The review posted for the revision's verdict in the round asked about. */
	readonly review?: string;
	/** The comment that starts each finding's thread, by finding ID. */
	readonly threads: Readonly<Record<string, string>>;
	/** The reply marking each finding resolved or dismissed at the revision, by {@link replyKey}. */
	readonly replies: Readonly<Record<string, string>>;
}

/**
 * A code host that reviews arrive on, such as GitHub. Publication reaches the host only through this port, so a second
 * host is a new implementation, not a change to the pipeline.
 *
 * Every post carries a marker naming its revision and finding, signed with the changeset's publisher secret, and
 * {@link ReviewProvider.findPublished} reads back only markers whose signature verifies. The host accepts no
 * idempotency key, so the markers are how a publication interrupted after a post and before its record finds what it
 * already posted, whoever the host says posted it.
 */
export interface ReviewProvider {
	/** The host's name, such as `github`, for messages. */
	readonly name: string;
	/** Clears per-publication provider caches. */
	beginPublish?(): void;
	/** A pull request's base, head, and metadata. */
	pullRequest(number: number): Promise<PullRequest>;
	/** Posts one review for a revision, never approving or requesting changes. */
	postReview(draft: ReviewDraft): Promise<PostedReview>;
	/**
	 * Edits an addressed finding and resolves its thread, or replies with a dismissal's reason. Returns the edited
	 * comment or reply ID, or `undefined` when the thread is gone.
	 */
	replyResolved(
		pullRequest: number,
		finding: ClosedFinding & { readonly thread: string },
		revision: string,
		secret: string,
	): Promise<string | undefined>;
	/** Finds the one signed ledger across all heads; refuses an orphaned marker. */
	findLedger(pullRequest: number, secret: string, recorded?: PostedLedger): Promise<PostedLedger | undefined>;
	/** Creates or edits the ledger, reading its stamp before a write. */
	writeLedger(draft: LedgerDraft): Promise<PostedLedger>;
	/** Sets the review's status on a commit. Setting it again replaces it. */
	setStatus(revision: string, status: ReviewStatus, ledgerUrl?: string): Promise<void>;
	/**
	 * What the pull request already shows of `revision`'s publication, from posts that carry Melian's markers signed
	 * with `secret`: the review of `review`'s round, posting the verdict its fingerprint names, and every thread and
	 * reply at `revision`.
	 */
	findPublished(
		pullRequest: number,
		revision: string,
		review: { readonly fingerprint: string; readonly round: number },
		secret: string,
	): Promise<PublishedMarkers>;
}

/** The summarise task's bounded, untrusted description of a revision. */
export type Walkthrough = {
	summary: string;
	files: { path: string; summary: string }[];
	diagram?: string;
	note?: string;
};

/** The routes and limits fixed when a review started, without credentials. */
export type PublicationDetails = {
	policy: string;
	manifest: string[];
	lenses: {
		name: string;
		version: string;
		level: string;
		models: string[];
		usage?: { models: string[]; tokens: number; cost: number };
		budget: { findings: number; tokens?: number; tools?: number };
	}[];
	standards: string[];
};

/** One posted round, kept across heads for the ledger's history. */
export type LedgerRound = {
	base: string;
	head: string;
	round: number;
	verdict: StoredVerdict;
	details?: PublicationDetails;
	walkthrough?: Walkthrough;
	walkthroughNote?: string;
	resolved: { id: string; ruleId: string; path: string; line: number; commit: string; reason?: string }[];
};

/** The one-line history retained after a later round posts. */
export type LedgerHistory = { base: string; head: string; round: number; status: StoredVerdict["status"] };

/** The public stamp attached to the ledger. No git identity or secret enters it. */
export type LedgerStamp = {
	version: 1;
	base: string;
	head: string;
	round: number;
	verdict: string;
	counts: { open: number; blocking: number; dismissed: number };
	lenses: string[];
	plan: string | null;
	projection: string;
};

/** The ledger comment found or written on the host. */
export type PostedLedger = { id: string; url: string; stamp: LedgerStamp; author?: string };

/** The durable publication history projected through the current verdict. */
export interface LedgerDraft {
	readonly pullRequest: number;
	readonly verdict: Verdict;
	readonly publication: { readonly rounds: readonly (LedgerRound | LedgerHistory)[] };
	readonly walkthrough: { readonly enabled: boolean; readonly collapsed: boolean; readonly diagrams: boolean };
	readonly secret: string;
	readonly recorded?: PostedLedger;
}

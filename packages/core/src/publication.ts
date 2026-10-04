import { createHash } from "node:crypto";
import type { Verdict } from "./adjudication.ts";
import type { ChangedFile } from "./diff.ts";
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

/** The lines each changed file adds at head. Deleted, binary, and percent-encoded files have none. */
export function diffLines(files: readonly ChangedFile[]): Record<string, [number, number][]> {
	const lines: Record<string, [number, number][]> = {};
	for (const file of files) {
		if (file.status === "deleted" || file.binary || file.percentEncoded) continue;
		const ranges = file.hunks
			.filter((hunk) => hunk.newLines > 0)
			.map((hunk): [number, number] => [hunk.newStart, hunk.newStart + hunk.newLines - 1]);
		if (ranges.length > 0) lines[file.path] = ranges;
	}
	return lines;
}

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

function span(finding: Finding): [number, number] {
	const { startLine, endLine = startLine } = finding.locations[0]!.physicalLocation.region;
	return [startLine, endLine];
}

/** Where `finding` is posted, given the lines its revision changes. */
export function placeFinding(finding: Finding, lines: DiffLines): Placement {
	const ranges = Object.hasOwn(lines, finding.properties.path) ? lines[finding.properties.path]! : [];
	if (ranges.length === 0) return { kind: "body" };
	const [start, end] = span(finding);
	const overlap = ranges.find(([first, last]) => first <= end && start <= last);
	if (overlap !== undefined) {
		return { kind: "lines", startLine: Math.max(start, overlap[0]), line: Math.min(end, overlap[1]) };
	}
	let nearest = ranges[0]![0];
	for (const [first, last] of ranges) {
		for (const candidate of [first, last]) {
			if (Math.abs(candidate - start) < Math.abs(nearest - start)) nearest = candidate;
		}
	}
	return { kind: "nearest", line: nearest };
}

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

/** What one revision's publication posts, decided by {@link planPublication}. */
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
}

/**
 * Decides what a revision's publication posts, given its verdict, the findings open on the pull request after the
 * previous revision's publication, and the lines the revision changes.
 *
 * Findings that resolve to `block`, `acknowledge`, or `advisory` need attention. One not already open is posted; one
 * already open is not posted again. An open finding the verdict no longer holds in any group, silent and dismissed
 * included, is resolved. An open finding the verdict holds as dismissed is resolved with its dismissal, so its thread
 * says why, and leaves `open`: if a changed trigger reopens it, it is posted afresh. A dismissed finding is never
 * posted. An open finding that turned silent stays in `open`, so if it needs attention again it returns to its own
 * thread rather than starting a second one.
 */
export function planPublication(
	verdict: Verdict,
	previous: Readonly<Record<string, PublishedFinding>>,
	lines: DiffLines,
	revision: string,
): PublicationPlan {
	const attention = [...verdict.findings.block, ...verdict.findings.acknowledge, ...verdict.findings.advisory];
	const dismissed = new Map(verdict.dismissed.map((finding) => [finding.properties.id, finding.properties.dismissal]));
	const held = new Set([...attention, ...verdict.findings.silent].map((finding) => finding.properties.id));
	const post: PlacedFinding[] = [];
	const stillOpen: string[] = [];
	const open: Record<string, PublishedFinding> = {};
	for (const finding of attention) {
		const { id, path } = finding.properties;
		if (Object.hasOwn(previous, id)) {
			stillOpen.push(id);
			open[id] = previous[id]!;
			continue;
		}
		const placement = placeFinding(finding, lines);
		post.push({ finding, placement });
		open[id] = { ruleId: finding.ruleId, path, line: span(finding)[0], revision };
	}
	for (const id of held) {
		if (!Object.hasOwn(open, id) && Object.hasOwn(previous, id)) open[id] = previous[id]!;
	}
	const resolved = Object.keys(previous)
		.sort()
		.filter((id) => !held.has(id))
		.map((id): ClosedFinding => {
			const dismissal = dismissed.get(id);
			return { id, ...previous[id]!, ...(dismissal === undefined ? {} : { dismissal: { ...dismissal } }) };
		});
	return { post, stillOpen, resolved, open };
}

/** A commit status: `success`, `failure`, or `error`, with a description for the author. */
export interface ReviewStatus {
	readonly state: "success" | "failure" | "error";
	readonly description: string;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The status a pull request's check shows for `verdict`. A review that passed, or found nothing blocking, is `success`,
 * with the count of findings; one with a blocking finding is `failure`; one that did not complete is `error`, naming
 * what did not run. Melian never approves, so `success` means only that nothing blocks.
 */
export function reviewStatus(verdict: Verdict): ReviewStatus {
	if (verdict.status === "not-reviewed") {
		const reasons = verdict.notRun.map(
			({ name, status, reason }) => `${name} ${status}${reason === undefined ? "" : ` (${reason})`}`,
		);
		return { state: "error", description: `Not reviewed: ${reasons.join("; ") || "the review did not complete"}` };
	}
	const shown = verdict.findings.block.length + verdict.findings.acknowledge.length + verdict.findings.advisory.length;
	if (verdict.status === "passed" || shown === 0) return { state: "success", description: "Passed" };
	if (verdict.blocking) {
		return {
			state: "failure",
			description: `${plural(shown, "finding")}, ${verdict.findings.block.length} blocking`,
		};
	}
	return { state: "success", description: `${plural(shown, "finding")}, none blocking` };
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
	/** A pull request's base, head, and metadata. */
	pullRequest(number: number): Promise<PullRequest>;
	/** Posts one review for a revision, never approving or requesting changes. */
	postReview(draft: ReviewDraft): Promise<PostedReview>;
	/**
	 * Replies in a resolved finding's thread that `revision` resolved it, or, for a finding with a `dismissal`, that it
	 * was dismissed and why. Returns the reply's ID, or `undefined` when the thread is gone, such as a comment someone
	 * deleted, so there is nothing to reply to.
	 */
	replyResolved(
		pullRequest: number,
		finding: ClosedFinding & { readonly thread: string },
		revision: string,
		secret: string,
	): Promise<string | undefined>;
	/** Sets the review's status on a commit. Setting it again replaces it. */
	setStatus(revision: string, status: ReviewStatus): Promise<void>;
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

import { createHmac, timingSafeEqual } from "node:crypto";
import {
	type ClosedFinding,
	describeBudgetEnd,
	dismissalVersion,
	type Finding,
	type PlacedFinding,
	type ReviewDraft,
	type Verdict,
} from "@melian-agent/core";

/** Where a revision's posts link to: the repository's web address, such as `https://github.com/owner/repo`. */
export interface RepositoryLinks {
	readonly web: string;
}

/** What a marker carries: a finding's thread, a review's verdict, or a reply that resolves a finding. */
export type MarkerKind = "finding" | "verdict" | "resolved";

/** What a marker carries beyond its kind and ID. */
export interface MarkerDetail {
	/** On a review's body, the review's round at the revision. */
	readonly round?: number;
	/** On a reply giving a dismissal, the dismissal's version. */
	readonly dismissal?: string;
}

/** A marker parsed from a post: the revision it belongs to, what it carries, and its signature. */
export interface Marker extends MarkerDetail {
	readonly revision: string;
	readonly kind: MarkerKind;
	/** The finding's ID, or for `verdict` the verdict's fingerprint. */
	readonly id: string;
	readonly sig: string;
}

// What a marker says, as it is signed.
function claim(kind: MarkerKind, id: string, { round, dismissal }: MarkerDetail): string {
	return `${kind}=${id}${round === undefined ? "" : ` round=${round}`}${dismissal === undefined ? "" : ` dismissal=${dismissal}`}`;
}

function signature(secret: string, revision: string, carries: string): string {
	return createHmac("sha256", Buffer.from(secret, "hex")).update(`${revision}|${carries}`).digest("hex").slice(0, 32);
}

/**
 * The hidden marker that opens every post: `<!-- melian:revision=<sha> <kind>=<id> sig=<signature> -->`, where kind is
 * `finding` on a finding's comment, `verdict` on a review's body, and `resolved` on a reply. A review's marker also
 * carries its round, `verdict=<fingerprint> round=<n>`, since one verdict can recur at a head, and a reply giving a
 * dismissal carries the dismissal's version, `resolved=<id> dismissal=<version>`, since a reason can change. The signature is the
 * first 32 hex digits of HMAC-SHA256, keyed with the changeset's publisher secret, over `<sha>|` and everything between
 * the revision and `sig=`. A rerun reads markers back to find what it already posted, and trusts one only when its
 * signature verifies.
 */
export function marker(
	revision: string,
	kind: MarkerKind,
	id: string,
	secret: string,
	detail: MarkerDetail = {},
): string {
	const carries = claim(kind, id, detail);
	return `<!-- melian:revision=${revision} ${carries} sig=${signature(secret, revision, carries)} -->`;
}

const markerLine =
	/^<!-- melian:revision=([0-9a-f]{40,64}) (finding|verdict|resolved)=([0-9a-f]{16})(?: round=([1-9][0-9]{0,8}))?(?: dismissal=([0-9a-f]{16}))? sig=([0-9a-f]{32}) -->$/;

/**
 * The marker on a line of its own, or `undefined`. Untrusted text cannot start a line with one; see
 * {@link renderProse}. A parsed marker proves nothing until {@link verifyMarker} accepts it.
 */
export function parseMarker(line: string): Marker | undefined {
	const match = markerLine.exec(line.trim());
	if (match === null) return undefined;
	const round = match[4] === undefined ? {} : { round: Number(match[4]) };
	const dismissal = match[5] === undefined ? {} : { dismissal: match[5] };
	return { revision: match[1]!, kind: match[2] as MarkerKind, id: match[3]!, ...round, ...dismissal, sig: match[6]! };
}

/**
 * Whether `secret` signed `found`. Anyone who can read a post can copy its marker, but a copy names only what Melian
 * already posted, under the same kind and round, so it cannot hide anything Melian has yet to post.
 */
export function verifyMarker(found: Marker, secret: string): boolean {
	const expected = Buffer.from(signature(secret, found.revision, claim(found.kind, found.id, found)), "hex");
	return timingSafeEqual(expected, Buffer.from(found.sig, "hex"));
}

/** Every marker standing on a line of its own in `body`, in order. */
export function markersIn(body: string): Marker[] {
	return body.split(/\r?\n/).flatMap((line) => {
		const found = parseMarker(line);
		return found === undefined ? [] : [found];
	});
}

/**
 * Finding text as inert text: never live markdown or HTML. Finding text comes from a lens that read a change its author
 * controls, and Melian posts it from the maintainer's account, so a link, an image, a heading, a fence, a mention, or
 * an issue reference in it would render as the maintainer's own. HTML is escaped, so no marker can be forged; every
 * markdown control character is backslash-escaped, after runs of three or more backticks or tildes collapse to one; and
 * a word joiner (U+2060) follows `@` and precedes the digits of `#123` and `owner/repo#123`, so nobody is notified and
 * nothing is cross-referenced. Line breaks stay, since an explanation may run over several lines.
 */
export function renderProse(text: string): string {
	return text
		.replace(/(`{3,}|~{3,})/g, (run) => run[0]!)
		.replace(/\\/g, "\\\\")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/[*_[\]()#!|~`]/g, "\\$&")
		.replace(/@(?=[\p{L}\p{N}_-])/gu, "@\u2060")
		.replace(/\\#(?=\d)/g, "\\#\u2060");
}

const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// A code span, for paths and rule IDs. Control characters are shown as \uXXXX, so a path holding a line break cannot
// start a line of its own, and the fence is longer than any run of backticks inside.
function code(text: string): string {
	const visible = text.replace(controls, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
	const longest = Math.max(0, ...(visible.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	const pad = visible.startsWith("`") || visible.endsWith("`") ? " " : "";
	return `${fence}${pad}${visible}${pad}${fence}`;
}

function short(revision: string): string {
	return revision.slice(0, 12);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function lineSpan(start: number, end: number): string {
	return end === start ? `line ${start}` : `lines ${start}-${end}`;
}

function span(finding: Finding): [number, number] {
	const { startLine, endLine = startLine } = finding.locations[0]!.physicalLocation.region;
	return [startLine, endLine];
}

/** A link to `path` at `revision`, on lines `start` to `end`. */
export function blobUrl(links: RepositoryLinks, revision: string, path: string, start: number, end = start): string {
	// encodeURIComponent leaves `!'()*`, and a `)` ends a markdown link's destination; only unreserved characters stay.
	const segment = (part: string) =>
		encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	const encoded = path.split("/").map(segment).join("/");
	return `${links.web}/blob/${revision}/${encoded}#L${start}${end === start ? "" : `-L${end}`}`;
}

// The commits a finding's links point at: the head reviewed, and the base its deleted lines are read from.
interface Commits {
	readonly head: string;
	readonly base: string;
}

// Each evidence location links to its lines at the commit it was read from, rather than quoting the code. A base
// location says the change deleted its lines only when Melian found so when it read them.
function evidenceText(finding: Finding, commits: Commits, links: RepositoryLinks): string[] {
	const { evidence } = finding.properties;
	if (evidence === undefined) return [];
	const items = evidence.map(({ file, startLine, endLine = startLine, role, revision, deleted }) => {
		const at = revision === "base" ? commits.base : commits.head;
		const link = `[${code(file)} ${lineSpan(startLine, endLine)}](${blobUrl(links, at, file, startLine, endLine)})`;
		const where = revision === "base" ? (deleted === true ? ", deleted by this change" : ", at the base") : "";
		return `- ${role}: ${link}${where}`;
	});
	return ["", "**Evidence:**", "", ...items];
}

function findingText(finding: Finding, commits: Commits, links: RepositoryLinks): string[] {
	const { severity, cause, resolution, explanation, failureScenario } = finding.properties;
	return [
		`**${severity}** ${code(finding.ruleId)} (${cause}, ${resolution ?? "unresolved"})`,
		"",
		// A lens's message is its explanation's first part, which would otherwise print twice.
		...(finding.message.text === explanation.what ? [] : [renderProse(finding.message.text), ""]),
		`**What:** ${renderProse(explanation.what)}`,
		"",
		`**Why here:** ${renderProse(explanation.whyHere)}`,
		...(failureScenario === undefined ? [] : ["", `**Failure scenario:** ${renderProse(failureScenario)}`]),
		...evidenceText(finding, commits, links),
		"",
		`**What to do:** ${renderProse(explanation.whatToDo)}`,
	];
}

/**
 * The body of a finding's inline comment. A finding anchored to the nearest changed line links to where it is.
 * `revision` is the head reviewed, and `base` the commit evidence on deleted lines links to.
 */
export function renderComment(
	placed: PlacedFinding,
	revision: string,
	base: string,
	links: RepositoryLinks,
	secret: string,
): string {
	const { finding, placement } = placed;
	const [start, end] = span(finding);
	const where =
		placement.kind === "nearest"
			? [
					`This finding is at [${code(finding.properties.path)} ${lineSpan(start, end)}](${blobUrl(links, revision, finding.properties.path, start, end)}), outside the diff, so it is anchored to the nearest changed line.`,
					"",
				]
			: [];
	return [
		marker(revision, "finding", finding.properties.id, secret),
		...where,
		...findingText(finding, { head: revision, base }, links),
	].join("\n");
}

const statusWords: Readonly<Record<Verdict["status"], string>> = {
	passed: "passed",
	findings: "findings",
	"not-reviewed": "not reviewed",
};

/**
 * The body of a revision's review: the verdict, the checks that did not run, a lens its budget ended among them, any
 * lens its budget ended that its level counts as run, findings in files the change does not touch, each under its own
 * marker, and resolved and dismissed findings that had no thread to reply in, each dismissed one with its reason.
 */
export function renderReviewBody(draft: ReviewDraft, links: RepositoryLinks, options: ReviewBodyOptions = {}): string {
	const { verdict, revision, secret } = draft;
	const limit = options.limit ?? maxBodyLength;
	const status = `**${statusWords[verdict.status]}${verdict.blocking ? ", blocking" : ""}**`;
	const parts = [
		`${marker(revision, "verdict", draft.fingerprint, secret, { round: draft.round })}\nMelian reviewed ${code(short(revision))}: ${status}.`,
	];
	const counts = (["block", "acknowledge", "advisory"] as const)
		.filter((resolution) => verdict.findings[resolution].length > 0)
		.map((resolution) => `${verdict.findings[resolution].length} ${resolution}`);
	const shown = verdict.findings.block.length + verdict.findings.acknowledge.length + verdict.findings.advisory.length;
	const summary = [
		shown === 0
			? "No findings need attention."
			: `${plural(shown, "finding")} ${shown === 1 ? "needs" : "need"} attention: ${counts.join(", ")}.`,
		...(draft.stillOpen > 0
			? [`${draft.stillOpen} of them ${draft.stillOpen === 1 ? "was" : "were"} posted on an earlier revision.`]
			: []),
		...(verdict.dismissed.length > 0 ? [`${plural(verdict.dismissed.length, "dismissed finding")} not shown.`] : []),
	];
	parts.push(summary.join(" "));
	if (verdict.notRun.length > 0) {
		const checks = verdict.notRun.map(({ name, status: ran, reason, budgetEnded }) => {
			const why = reason ?? (budgetEnded === undefined ? undefined : describeBudgetEnd(budgetEnded));
			return `- ${code(name)} ${ran}${why === undefined ? "" : `: ${inline(why)}`}`;
		});
		parts.push(["Checks that did not run:", "", ...checks].join("\n"));
	}
	const counted = (verdict.ran ?? []).flatMap(({ name, budgetEnded }) =>
		budgetEnded === undefined ? [] : [`- ${code(name)}: ${describeBudgetEnd(budgetEnded)}`],
	);
	if (counted.length > 0) {
		parts.push(["Lenses a budget ended, counted with the findings they reported:", "", ...counted].join("\n"));
	}
	const named = (finding: ClosedFinding) => `- ${code(finding.ruleId)} in ${code(finding.path)} line ${finding.line}`;
	const resolved = draft.resolved.filter((finding) => finding.dismissal === undefined).map(named);
	if (resolved.length > 0) parts.push(["Resolved since the last review:", "", ...resolved].join("\n"));
	const dismissed = draft.resolved.flatMap((finding) =>
		finding.dismissal === undefined ? [] : [`${named(finding)}: ${inline(finding.dismissal.reason)}`],
	);
	if (dismissed.length > 0) parts.push(["Dismissed since the last review:", "", ...dismissed].join("\n"));
	const inBody = draft.findings.filter((placed) => placed.placement.kind === "body");
	const sections = inBody.map(({ finding }) => {
		const [start, end] = span(finding);
		const link = `[${code(finding.properties.path)} ${lineSpan(start, end)}](${blobUrl(links, revision, finding.properties.path, start, end)})`;
		return [
			marker(revision, "finding", finding.properties.id, secret),
			link,
			"",
			...findingText(finding, { head: revision, base: draft.base }, links),
		].join("\n");
	});
	const heading = options.inlineRefused
		? "### Findings\n\nGitHub refused this review's inline comments, so every finding is listed here."
		: "### In files this change does not touch";
	const assemble = (kept: number, note?: string) =>
		[
			...parts,
			...(kept > 0 ? [heading, ...sections.slice(0, kept)] : []),
			...(note === undefined ? [] : [note]),
		].join("\n\n");
	const whole = assemble(sections.length);
	if (whole.length <= limit) return whole;
	// GitHub refuses a body over its limit, and the summary and the marker matter more than the last findings.
	const all = `\`melian findings "#${draft.pullRequest}"\` lists them all.`;
	for (let kept = sections.length - 1; kept >= 0; kept--) {
		const cut = sections.length - kept;
		const body = assemble(kept, `${plural(cut, "finding")} did not fit in this review; ${all}`);
		if (body.length <= limit) return body;
	}
	const note = `This review was cut to fit GitHub's limit; ${all}`;
	const room = assemble(0).slice(0, limit - note.length - 2);
	return `${room.slice(0, Math.max(room.lastIndexOf("\n"), 0))}\n\n${note}`;
}

/** GitHub refuses a review body, or a comment, longer than this many characters. */
export const maxBodyLength = 65_536;

/** How {@link renderReviewBody} renders. */
export interface ReviewBodyOptions {
	/** GitHub refused the review's inline comments, so every finding is in the body. */
	readonly inlineRefused?: boolean;
	/** The longest body to render; GitHub's {@link maxBodyLength} by default. */
	readonly limit?: number;
}

/**
 * The reply in a resolved finding's thread: that the revision no longer reports it, or, for a dismissed finding, that it
 * was dismissed and why. The reason goes through {@link renderProse}, and the dismisser is left out: the reply is posted
 * from the publisher's account, and the dismisser Melian records is a git identity, whose email does not belong on a
 * pull request.
 */
export function renderResolvedReply(finding: ClosedFinding, revision: string, secret: string): string {
	const version = finding.dismissal === undefined ? {} : { dismissal: dismissalVersion(finding.dismissal) };
	const head = marker(revision, "resolved", finding.id, secret, version);
	if (finding.dismissal !== undefined) {
		return `${head}\nDismissed at ${code(short(revision))}: ${inline(finding.dismissal.reason)}`;
	}
	return `${head}\nResolved at ${code(short(revision))}: this revision no longer reports ${code(finding.ruleId)} here.`;
}

// Prose on one line, for a list item or a reply's single line.
function inline(text: string): string {
	return renderProse(text).replace(/\r\n?|\n/g, " ");
}

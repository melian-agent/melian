import { createHmac, timingSafeEqual } from "node:crypto";
import type { ClosedFinding, Finding, PlacedFinding, ReviewDraft, Verdict } from "@melian-agent/core";

/** Where a revision's posts link to: the repository's web address, such as `https://github.com/owner/repo`. */
export interface RepositoryLinks {
	readonly web: string;
}

/** What a marker carries: a finding's thread, a review's verdict, or a reply that resolves a finding. */
export type MarkerKind = "finding" | "verdict" | "resolved";

/** A marker parsed from a post: the revision it belongs to, what it carries, and its signature. */
export interface Marker {
	readonly revision: string;
	readonly kind: MarkerKind;
	/** The finding's ID, or for `verdict` the verdict's fingerprint. */
	readonly id: string;
	readonly sig: string;
}

function signature(secret: string, revision: string, kind: MarkerKind, id: string): string {
	return createHmac("sha256", Buffer.from(secret, "hex"))
		.update(`${revision}|${kind}=${id}`)
		.digest("hex")
		.slice(0, 32);
}

/**
 * The hidden marker that opens every post: `<!-- melian:revision=<sha> <kind>=<id> sig=<signature> -->`, where kind is
 * `finding` on a finding's comment, `verdict` on a review's body, and `resolved` on a reply. The signature is the first
 * 32 hex digits of HMAC-SHA256, keyed with the changeset's publisher secret, over `<sha>|<kind>=<id>`. A rerun reads
 * markers back to find what it already posted, and trusts one only when its signature verifies.
 */
export function marker(revision: string, kind: MarkerKind, id: string, secret: string): string {
	return `<!-- melian:revision=${revision} ${kind}=${id} sig=${signature(secret, revision, kind, id)} -->`;
}

const markerLine =
	/^<!-- melian:revision=([0-9a-f]{40,64}) (finding|verdict|resolved)=([0-9a-f]{16}) sig=([0-9a-f]{32}) -->$/;

/**
 * The marker on a line of its own, or `undefined`. Untrusted text cannot start a line with one; see {@link prose}. A
 * parsed marker proves nothing until {@link verifyMarker} accepts it.
 */
export function parseMarker(line: string): Marker | undefined {
	const match = markerLine.exec(line.trim());
	if (match === null) return undefined;
	return { revision: match[1]!, kind: match[2] as MarkerKind, id: match[3]!, sig: match[4]! };
}

/**
 * Whether `secret` signed `found`. Anyone who can read a post can copy its marker, but a copy names only what Melian
 * already posted, under the same kind, so it cannot hide anything Melian has yet to post.
 */
export function verifyMarker(found: Marker, secret: string): boolean {
	const expected = Buffer.from(signature(secret, found.revision, found.kind, found.id), "hex");
	return timingSafeEqual(expected, Buffer.from(found.sig, "hex"));
}

/** Every marker standing on a line of its own in `body`, in order. */
export function markersIn(body: string): Marker[] {
	return body.split(/\r?\n/).flatMap((line) => {
		const found = parseMarker(line);
		return found === undefined ? [] : [found];
	});
}

// Finding text and paths come from the change under review, which its author controls. Escaping `<` and `>` keeps any
// HTML, and so any forged marker, inert; a zero-width space after `@` keeps a lens from mentioning, and so notifying,
// anyone. Line breaks stay, since an explanation may run over several lines.
function prose(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/@(?=\w)/g, "@\u200b");
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
	const encoded = path.split("/").map(encodeURIComponent).join("/");
	return `${links.web}/blob/${revision}/${encoded}#L${start}${end === start ? "" : `-L${end}`}`;
}

// An affected finding's evidence is the changed code that breaks it, linked at the revision.
function evidenceText(finding: Finding, revision: string, links: RepositoryLinks): string[] {
	const { evidence } = finding.properties;
	if (evidence === undefined) return [];
	const { file, startLine, endLine = startLine } = evidence;
	const link = `[${code(file)} ${lineSpan(startLine, endLine)}](${blobUrl(links, revision, file, startLine, endLine)})`;
	return ["", `**Evidence:** the change at ${link} breaks it.`];
}

function findingText(finding: Finding, revision: string, links: RepositoryLinks): string[] {
	const { severity, cause, resolution, explanation } = finding.properties;
	return [
		`**${severity}** ${code(finding.ruleId)} (${cause}, ${resolution ?? "unresolved"})`,
		"",
		// A lens's message is its explanation's first part, which would otherwise print twice.
		...(finding.message.text === explanation.what ? [] : [prose(finding.message.text), ""]),
		`**What:** ${prose(explanation.what)}`,
		"",
		`**Why here:** ${prose(explanation.whyHere)}`,
		...evidenceText(finding, revision, links),
		"",
		`**What to do:** ${prose(explanation.whatToDo)}`,
	];
}

/** The body of a finding's inline comment. A finding anchored to the nearest changed line links to where it is. */
export function renderComment(placed: PlacedFinding, revision: string, links: RepositoryLinks, secret: string): string {
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
		...findingText(finding, revision, links),
	].join("\n");
}

const statusWords: Readonly<Record<Verdict["status"], string>> = {
	passed: "passed",
	findings: "findings",
	"not-reviewed": "not reviewed",
};

/**
 * The body of a revision's review: the verdict, the checks that did not run, findings in files the change does not
 * touch, each under its own marker, and resolved findings that had no thread to reply in.
 */
export function renderReviewBody(draft: ReviewDraft, links: RepositoryLinks, options: ReviewBodyOptions = {}): string {
	const { verdict, revision, secret } = draft;
	const limit = options.limit ?? maxBodyLength;
	const status = `**${statusWords[verdict.status]}${verdict.blocking ? ", blocking" : ""}**`;
	const parts = [
		`${marker(revision, "verdict", draft.fingerprint, secret)}\nMelian reviewed ${code(short(revision))}: ${status}.`,
	];
	const counts = (["block", "acknowledge", "advisory"] as const)
		.filter((resolution) => verdict.findings[resolution].length > 0)
		.map((resolution) => `${verdict.findings[resolution].length} ${resolution}`);
	const shown = verdict.findings.block.length + verdict.findings.acknowledge.length + verdict.findings.advisory.length;
	const summary = [
		shown === 0 ? "No findings need attention." : `${plural(shown, "finding")} need attention: ${counts.join(", ")}.`,
		...(draft.stillOpen > 0
			? [`${draft.stillOpen} of them ${draft.stillOpen === 1 ? "was" : "were"} posted on an earlier revision.`]
			: []),
		...(verdict.dismissed.length > 0 ? [`${plural(verdict.dismissed.length, "dismissed finding")} not shown.`] : []),
	];
	parts.push(summary.join(" "));
	if (verdict.notRun.length > 0) {
		const checks = verdict.notRun.map(
			({ name, status: ran, reason }) =>
				`- ${code(name)} ${ran}${reason === undefined ? "" : `: ${prose(reason).replace(/\r?\n/g, " ")}`}`,
		);
		parts.push(["Checks that did not run:", "", ...checks].join("\n"));
	}
	if (draft.resolved.length > 0) {
		const resolved = draft.resolved.map(
			(finding) => `- ${code(finding.ruleId)} in ${code(finding.path)} line ${finding.line}`,
		);
		parts.push(["Resolved since the last review:", "", ...resolved].join("\n"));
	}
	const inBody = draft.findings.filter((placed) => placed.placement.kind === "body");
	const sections = inBody.map(({ finding }) => {
		const [start, end] = span(finding);
		const link = `[${code(finding.properties.path)} ${lineSpan(start, end)}](${blobUrl(links, revision, finding.properties.path, start, end)})`;
		return [
			marker(revision, "finding", finding.properties.id, secret),
			link,
			"",
			...findingText(finding, revision, links),
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

/** The reply in a resolved finding's thread. */
export function renderResolvedReply(finding: ClosedFinding, revision: string, secret: string): string {
	return `${marker(revision, "resolved", finding.id, secret)}\nResolved at ${code(short(revision))}: this revision no longer reports ${code(finding.ruleId)} here.`;
}

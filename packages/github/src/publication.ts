import type { ClosedFinding, Finding, PlacedFinding, ReviewDraft, Verdict } from "@melian-agent/core";

/** Where a revision's posts link to: the repository's web address, such as `https://github.com/owner/repo`. */
export interface RepositoryLinks {
	readonly web: string;
}

/** A marker parsed from a post: the revision it belongs to, and the finding or the verdict it carries. */
export interface Marker {
	readonly revision: string;
	readonly finding?: string;
	readonly verdict?: string;
}

/**
 * The hidden marker that opens every post: `<!-- melian:revision=<sha> finding=<id> -->` on a comment, and
 * `<!-- melian:revision=<sha> verdict=<fingerprint> -->` on a review's body. A rerun reads it back to find what it
 * already posted.
 */
export function marker(revision: string, carries: { finding: string } | { verdict: string }): string {
	const extra = "finding" in carries ? `finding=${carries.finding}` : `verdict=${carries.verdict}`;
	return `<!-- melian:revision=${revision} ${extra} -->`;
}

const markerLine = /^<!-- melian:revision=([0-9a-f]{40,64}) (finding|verdict)=([0-9a-f]{16}) -->$/;

/** The marker on a line of its own, or `undefined`. Untrusted text cannot start a line with one; see {@link prose}. */
export function parseMarker(line: string): Marker | undefined {
	const match = markerLine.exec(line.trim());
	if (match === null) return undefined;
	return { revision: match[1]!, [match[2]!]: match[3]! };
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
export function renderComment(placed: PlacedFinding, revision: string, links: RepositoryLinks): string {
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
		marker(revision, { finding: finding.properties.id }),
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
export function renderReviewBody(draft: ReviewDraft, links: RepositoryLinks): string {
	const { verdict, revision } = draft;
	const status = `**${statusWords[verdict.status]}${verdict.blocking ? ", blocking" : ""}**`;
	const parts = [
		`${marker(revision, { verdict: draft.fingerprint })}\nMelian reviewed ${code(short(revision))}: ${status}.`,
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
	const inBody = draft.findings.filter((placed) => placed.placement.kind === "body");
	if (inBody.length > 0) {
		parts.push("### In files this change does not touch");
		for (const { finding } of inBody) {
			const [start, end] = span(finding);
			const link = `[${code(finding.properties.path)} ${lineSpan(start, end)}](${blobUrl(links, revision, finding.properties.path, start, end)})`;
			parts.push(
				[
					marker(revision, { finding: finding.properties.id }),
					link,
					"",
					...findingText(finding, revision, links),
				].join("\n"),
			);
		}
	}
	if (draft.resolved.length > 0) {
		const resolved = draft.resolved.map(
			(finding) => `- ${code(finding.ruleId)} in ${code(finding.path)} line ${finding.line}`,
		);
		parts.push(["Resolved since the last review:", "", ...resolved].join("\n"));
	}
	return parts.join("\n\n");
}

/** The reply in a resolved finding's thread. */
export function renderResolvedReply(finding: ClosedFinding, revision: string): string {
	return `${marker(revision, { finding: finding.id })}\nResolved at ${code(short(revision))}: this revision no longer reports ${code(finding.ruleId)} here.`;
}

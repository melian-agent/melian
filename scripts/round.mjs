// What the melian-round workflow does beside running melian: find whose code the head is, take the Codex access token
// from a Codex login, and turn a round's output into a pull request comment it posts once. round-writer.mjs,
// round-codex-token.mjs, round-comment.mjs and round-own-comment.mjs are its commands.
import { readFileSync } from "node:fs";
import { describeBudgetEnd, describeLineage, visibleText } from "../packages/core/src/render.ts";

// The access token of a Codex login, `~/.codex/auth.json` base64-encoded as this repository's `CODEX_AUTH_B64` holds
// it. Only the access token leaves: a refresh would rotate the refresh token and break the login's other copies. Each
// error names what is missing and never quotes the login, as a `JSON.parse` error would.
export function codexAccessToken(encoded) {
	if (encoded === undefined || encoded === "") throw new Error("CODEX_AUTH_B64 is unset");
	let token;
	try {
		token = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).tokens.access_token;
	} catch {
		throw new Error("CODEX_AUTH_B64 is not a Codex login");
	}
	if (typeof token !== "string" || token === "")
		throw new Error("the Codex login in CODEX_AUTH_B64 has no access token");
	return token;
}

// Whose code the head is, by the rule of the head-writer decision as Melian's GitHub provider applies it: the first
// push event, newest first, for exactly this SHA on exactly this branch names the pusher; with none, the pull request's
// author stands in. `events` are JSON lines of `{ actor, head, ref }`, one per push event. An event that names no actor,
// or a line that is not one, is refused rather than passed over.
export function headWriter(events, { sha, branch, author }) {
	for (const line of events.split("\n").filter((each) => each.trim() !== "")) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			throw new Error("a push event could not be read");
		}
		if (event.head !== sha || event.ref !== `refs/heads/${branch}`) continue;
		if (typeof event.actor !== "string" || event.actor === "")
			throw new Error("the head's push event names no pushing identity");
		return event.actor;
	}
	if (typeof author !== "string" || author === "")
		throw new Error("no push event names the head, and the pull request names no author");
	return author;
}

// Each run's comment opens with its own marker, so a rerun of the report job finds and updates that comment.
export function marker(runId) {
	return `<!-- melian-round run:${/^\d+$/.test(runId) ? runId : "unknown"} -->`;
}

// The ID of the comment this run already posted, or undefined when it posted none. `comments` are JSON lines of
// `{ id, login, body }`, one per comment on the pull request. Only a comment `author` wrote counts, so no one else can
// claim a run's marker; a line that is not a comment is refused rather than passed over.
export function ownComment(comments, { runId, author }) {
	if (!/^\d+$/.test(runId)) throw new Error("the run has no ID to find its comment by");
	const opening = `${marker(runId)}\n`;
	for (const line of comments.split("\n").filter((each) => each.trim() !== "")) {
		let comment;
		try {
			comment = JSON.parse(line);
		} catch {
			throw new Error("a comment could not be read");
		}
		if (comment.login === author && typeof comment.body === "string" && comment.body.startsWith(opening))
			return comment.id;
	}
	return undefined;
}
// GitHub refuses a comment over 65,536 characters.
export const maxLength = 60_000;
const aboveAdvisory = ["block", "acknowledge"];

const statuses = { passed: "passed", findings: "findings", "not-reviewed": "not reviewed" };

// What `melian review` exits with for a verdict, as the CLI's reviewExitCodes and ReviewOutcome decide it.
function exitFor({ status, blocking }) {
	if (status === "not-reviewed") return "2";
	if (blocking) return "1";
	return status === "passed" ? "0" : "3";
}

function oneLine(text) {
	return visibleText(String(text).replace(/\r?\n/g, " "));
}

// Why `value` is not a verdict this comment can render, or undefined when it is one.
function verdictProblem(value) {
	if (typeof value !== "object" || value === null) return "melian wrote no verdict";
	if (!Object.hasOwn(statuses, value.status)) return "the verdict names no known status";
	if (typeof value.blocking !== "boolean") return "the verdict does not say whether it blocks";
	const { findings } = value;
	if (typeof findings !== "object" || findings === null) return "the verdict holds no findings";
	if (!aboveAdvisory.every((resolution) => Array.isArray(findings[resolution])))
		return "the verdict holds no block or acknowledge findings";
	if (!Array.isArray(value.notRun)) return "the verdict does not list the checks that did not run";
	return undefined;
}

function checkLines({ name, status, level, reason, error, budgetEnded }) {
	const ended = budgetEnded === undefined ? [] : [describeBudgetEnd(budgetEnded)];
	const why = [...ended, ...(reason === undefined ? [] : [reason])].join("; ");
	return [
		oneLine(`  ${name}  ${status}${level === undefined ? "" : ` at ${level}`}${why === "" ? "" : `: ${why}`}`),
		...(error === undefined ? [] : [oneLine(`    Error: ${error}`)]),
	];
}

function lineageLine({ name, lineage }) {
	return oneLine(`  ${name}  ${describeLineage(lineage)}`);
}

function commit(sha) {
	return /^[0-9a-f]{40}$/.test(sha) ? `\`${sha.slice(0, 12)}\`` : "an unreadable commit";
}

function plural(count, noun) {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function findingLine(finding) {
	const { id, severity, resolution, path, source } = finding.properties;
	const region = finding.locations[0]?.physicalLocation.region ?? {};
	const start = region.startLine;
	const end = region.endLine ?? start;
	const where = start === undefined ? path : `${path}:${start}${end === start ? "" : `-${end}`}`;
	return oneLine(
		`${severity} ${resolution}  ${where}  ${source.check}  ${finding.ruleId}  ${id}  ${finding.message.text}`,
	);
}

// The base and head of the last round `melian findings --rounds --json` lists, or undefined when there is none to read.
function lastRound(text) {
	let rounds;
	try {
		rounds = JSON.parse(text);
	} catch {
		return undefined;
	}
	const round = Array.isArray(rounds) ? rounds.at(-1) : undefined;
	return typeof round?.base === "string" && typeof round.head === "string"
		? { base: round.base, head: round.head }
		: undefined;
}

function readOr(path, fallback) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return fallback;
	}
}

// The comment for one round, from the verdict JSON `melian review --json` wrote and nothing it printed. `base` and
// `head` are what the gate approved, and `mergeBase` their merge base, which a round of them reviews from. `reviewed`
// is the base and head the round itself records, and `current` the pull request's, read again just before posting;
// either is undefined when its read failed. Finding text comes from models that read the head, so everything after
// the link sits inside one code fence that no backtick run in it can close.
export class RoundComment {
	constructor({ verdict, exitCode, runUrl, runId, base, head, mergeBase, reviewed, current }) {
		this.verdict = verdict;
		this.runId = runId;
		this.exitCode = exitCode;
		this.runUrl = runUrl;
		this.base = base;
		this.head = head;
		this.mergeBase = mergeBase;
		this.reviewed = reviewed;
		this.current = current;
	}

	static read({ verdict, rounds, exitCode, runUrl, runId, base, head, mergeBase, current }) {
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(verdict, "utf8"));
		} catch {
			parsed = undefined;
		}
		const reviewed = lastRound(readOr(rounds, ""));
		return new RoundComment({ verdict: parsed, exitCode, runUrl, runId, base, head, mergeBase, reviewed, current });
	}

	body() {
		// The exit code and commits sit outside the fence.
		const exit = /^(\d{1,3}|none)$/.test(this.exitCode) ? this.exitCode : "unknown";
		const header = `${marker(this.runId)}\nMelian round on ${commit(this.base)}...${commit(this.head)}, exit ${exit}: [run](${this.runUrl})`;
		if (this.current === undefined)
			return `${header}\n\nThe pull request could not be read again before posting, so this round posts no findings. Start a new round.\n`;
		if (this.current.base !== this.base || this.current.head !== this.head) {
			const moved = `${commit(this.current.base)}...${commit(this.current.head)}`;
			return `${header}\n\nThe pull request moved to ${moved} during the round, so this round posts no findings. Start a new round.\n`;
		}
		if (this.reviewed === undefined)
			return `${header}\n\nThe round's own record of what it reviewed could not be read, so this round posts no findings. Start a new round.\n`;
		if (this.reviewed.head !== this.head || this.reviewed.base !== this.mergeBase) {
			const other = `${commit(this.reviewed.base)}...${commit(this.reviewed.head)}`;
			return `${header}\n\nMelian reviewed ${other}, not the pull request the gate approved, so this round posts no findings. Start a new round.\n`;
		}
		const verdict = this.verdict;
		const problem =
			verdictProblem(verdict) ??
			(exitFor(verdict) === this.exitCode
				? undefined
				: `melian exited ${exit}, which does not match a verdict that reads ${statuses[verdict.status]}${verdict.blocking ? ", blocking" : ""}`);
		if (problem !== undefined) {
			return `${header}\n\n${fenced(["Verdict: not reviewed", "", `${problem}; the run's log and artefact say why.`])}`;
		}
		const quoted = [`Verdict: ${statuses[verdict.status]}${verdict.blocking ? ", blocking" : ""}`];
		const provisional = verdict.notRun.filter((check) => check.status === "provisional");
		const notRun = verdict.notRun.filter((check) => check.status !== "provisional");
		if (provisional.length > 0) quoted.push("", "Provisional:", ...provisional.flatMap(checkLines));
		if (notRun.length > 0)
			quoted.push("", `${plural(notRun.length, "check")} did not run:`, ...notRun.flatMap(checkLines));
		const lineage = [...(verdict.ran ?? []), ...verdict.notRun].filter((check) => check.lineage !== undefined);
		if (lineage.length > 0)
			quoted.push("", `${plural(lineage.length, "check")} left the committed routes:`, ...lineage.map(lineageLine));
		const findings = aboveAdvisory.flatMap((resolution) => verdict.findings[resolution]);
		quoted.push("", findings.length === 0 ? "No findings above advisory." : `Above advisory: ${findings.length}`);
		quoted.push(...findings.map((finding) => `  ${findingLine(finding)}`));
		return `${header}\n\n${fenced(quoted, maxLength - header.length - 2)}`;
	}
}

// `lines` in a `text` code fence longer than any backtick run inside, at most `budget` characters long. Past the budget
// it keeps the lines that fit and ends with one naming how many it cut.
export function fenced(lines, budget = Number.POSITIVE_INFINITY) {
	const longest = lines.reduce((most, line) => {
		for (const run of line.match(/`+/g) ?? []) most = Math.max(most, run.length);
		return most;
	}, 0);
	const fence = "`".repeat(Math.max(3, longest + 1));
	const render = (body) => `${fence}text\n${body.join("\n")}\n${fence}\n`;
	// Two fences, "text" and three newlines frame the body; each line costs its length and one newline less in all.
	const frame = 2 * fence.length + 7;
	const sizes = [0];
	for (const line of lines) sizes.push(sizes.at(-1) + line.length + 1);
	if (frame + sizes[lines.length] - 1 <= budget) return render(lines);
	const note = (kept) => `... ${lines.length - kept} more lines; the run's artefact has them all.`;
	let kept = lines.length - 1;
	while (kept > 0 && frame + sizes[kept] + note(kept).length > budget) kept--;
	return render([...lines.slice(0, kept), note(kept)]);
}

// What the melian-round workflow does beside running melian: find whose code the head is, take the Codex access token
// from a Codex login, and turn a round's output into a pull request comment. round-writer.mjs, round-codex-token.mjs
// and round-comment.mjs are its commands.
import { readFileSync } from "node:fs";
import { describeBudgetEnd, describeLineage, visibleText } from "../packages/core/src/render.ts";

/**
 * The access token of a Codex login, `~/.codex/auth.json` base64-encoded as this repository's `CODEX_AUTH_B64` holds
 * it. Only the access token leaves: a refresh would rotate the refresh token and break the login's other copies. Each
 * error names what is missing and never quotes the login, as a `JSON.parse` error would.
 */
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

/**
 * Whose code the head is, by the rule of the head-writer decision as Melian's GitHub provider applies it: the first
 * push event, newest first, for exactly this SHA on exactly this branch names the pusher; with none, the pull request's
 * author stands in. `events` are JSON lines of `{ actor, head, ref }`, one per push event. An event that names no actor,
 * or a line that is not one, is refused rather than passed over.
 */
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

export const marker = "<!-- melian-round -->";
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

/** Why `value` is not a verdict this comment can render, or undefined when it is one. */
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

/**
 * The comment for one round, from the verdict JSON `melian review --json` wrote and nothing it printed: the run's link,
 * the verdict, the checks that did not run or left the committed routes, and every finding above advisory. A verdict
 * that is missing, malformed, or disagrees with the exit code reads as not reviewed. Finding text comes from models
 * that read the head, so everything after the link sits inside one code fence that no backtick run in it can close.
 */
export class RoundComment {
	/**
	 * `base` and `head` are what the round reviewed; `current` is the pull request's base and head, read again just
	 * before posting, or undefined when that read failed.
	 */
	constructor({ verdict, exitCode, runUrl, base, head, current }) {
		this.verdict = verdict;
		this.exitCode = exitCode;
		this.runUrl = runUrl;
		this.base = base;
		this.head = head;
		this.current = current;
	}

	static read(verdictPath, exitCode, runUrl, base, head, current) {
		let verdict;
		try {
			verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
		} catch {
			verdict = undefined;
		}
		return new RoundComment({ verdict, exitCode, runUrl, base, head, current });
	}

	body() {
		// The exit code and commits sit outside the fence.
		const exit = /^(\d{1,3}|none)$/.test(this.exitCode) ? this.exitCode : "unknown";
		const header = `${marker}\nMelian round on ${commit(this.base)}...${commit(this.head)}, exit ${exit}: [run](${this.runUrl})`;
		if (this.current === undefined)
			return `${header}\n\nThe pull request could not be read again before posting, so this round posts no findings. Start a new round.\n`;
		if (this.current.base !== this.base || this.current.head !== this.head) {
			const moved = `${commit(this.current.base)}...${commit(this.current.head)}`;
			return `${header}\n\nThe pull request moved to ${moved} during the round, so this round posts no findings. Start a new round.\n`;
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

/**
 * `lines` in a `text` code fence longer than any backtick run inside, at most `budget` characters long. Past the budget
 * it keeps the lines that fit and ends with one naming how many it cut.
 */
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

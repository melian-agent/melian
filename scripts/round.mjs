// What the melian-round workflow does beside running melian: find whose code the head is, take the Codex access token
// from a Codex login, and turn a round's output into a pull request comment it posts once. round-writer.mjs,
// round-codex-token.mjs, round-comment.mjs and round-own-comment.mjs are its commands.
import { readFileSync } from "node:fs";
import { describeLineage, visibleText } from "../packages/core/src/render.ts";

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

// Each run's comment opens with a marker naming the run and a nonce its round job drew and uploaded, so a rerun of the
// report job finds and updates that comment, and a builder can tie the comment to its run. The nonce guards against
// nothing that can read the run's artefact: a workflow that does can post a matching marker first, and the report then
// overwrites that comment with the round's own body.
export function marker(runId, nonce) {
	const id = /^\d+$/.test(runId) ? runId : "unknown";
	return `<!-- melian-round run:${id} nonce:${/^[0-9a-f]{32}$/.test(nonce) ? nonce : "unknown"} -->`;
}

// The ID of the comment this run already posted, or undefined when it posted none. `comments` are JSON lines of
// `{ id, login, body }`, one per comment on the pull request, oldest first. Only a comment `author` wrote under this
// run's whole marker counts; a line that is not a comment is refused rather than passed over.
export function ownComment(comments, { runId, nonce, author }) {
	if (!/^\d+$/.test(runId)) throw new Error("the run has no ID to find its comment by");
	if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("the run has no nonce to find its comment by");
	const opening = `${marker(runId, nonce)}\n`;
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

function checkLine({ name, status }) {
	return oneLine(`  ${name}  ${status}`);
}

const localRun = "A local run of melian review shows why each check did not run.";

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

// What a builder needs to fix a finding, as the lines under its headline, labelled as the terminal labels them.
function details({ properties: { explanation, failureScenario } }) {
	return [
		["Why here", explanation?.whyHere],
		["Failure scenario", failureScenario],
		["What to do", explanation?.whatToDo],
	].filter(([, text]) => typeof text === "string");
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

// What of a verdict may leave the job: the fields the comment renders, and nothing a static tool printed. A head's
// tool configuration can reach outside the checkout, as a biome.json that extends /proc/<pid>/environ does, and the
// tool's error then quotes that file. So a check keeps its name, status and route, and a static finding its rule and
// place but not its text. Null for anything that is not a verdict, which the comment reads as no verdict.
export function publicVerdict(text) {
	try {
		const verdict = JSON.parse(text);
		const check = ({ name, status, lineage }) => ({ name, status, lineage });
		const finding = ({ ruleId, message, locations, properties }) => {
			const { id, severity, resolution, path, source, explanation, failureScenario } = properties;
			const region = locations[0]?.physicalLocation.region;
			const lens = !source.check.startsWith("static.");
			return {
				ruleId,
				message: { text: lens ? message.text : staticText },
				locations:
					region === undefined
						? []
						: [{ physicalLocation: { region: { startLine: region.startLine, endLine: region.endLine } } }],
				properties: {
					id,
					severity,
					resolution,
					path,
					source: { check: source.check },
					// A lens wrote these about files it read from git; it never sees a static tool's text, so they may leave.
					...(lens
						? {
								explanation: explanation && { whyHere: explanation.whyHere, whatToDo: explanation.whatToDo },
								failureScenario,
							}
						: {}),
				},
			};
		};
		const { findings } = verdict;
		return {
			status: Object.hasOwn(statuses, verdict.status) ? verdict.status : undefined,
			blocking: typeof verdict.blocking === "boolean" ? verdict.blocking : undefined,
			findings: Object.fromEntries(
				aboveAdvisory.map((resolution) => [
					resolution,
					Array.isArray(findings[resolution]) ? findings[resolution].map(finding) : undefined,
				]),
			),
			notRun: Array.isArray(verdict.notRun) ? verdict.notRun.map(check) : undefined,
			...(Array.isArray(verdict.ran) ? { ran: verdict.ran.map(check) } : {}),
		};
	} catch {
		return null;
	}
}

const staticText = "A static check's finding; a local run shows its text.";

// The comment for one round, from the verdict JSON `melian review --json` wrote and nothing it printed. `base` and
// `head` are what the gate approved, and `mergeBase` their merge base, which a round of them reviews from. `reviewed`
// is the base and head the round itself records, and `current` the pull request's, read again just before posting;
// either is undefined when its read failed. Finding text comes from models that read the head, so everything after
// the link sits inside one code fence that no backtick run in it can close.
export class RoundComment {
	constructor({ verdict, exitCode, runUrl, runId, nonce, base, head, mergeBase, reviewed, current }) {
		this.verdict = verdict;
		this.runId = runId;
		this.nonce = nonce;
		this.exitCode = exitCode;
		this.runUrl = runUrl;
		this.base = base;
		this.head = head;
		this.mergeBase = mergeBase;
		this.reviewed = reviewed;
		this.current = current;
	}

	static read({ verdict, rounds, exitCode, runUrl, runId, nonce, base, head, mergeBase, current }) {
		let parsed;
		try {
			parsed = publicVerdict(readFileSync(verdict, "utf8"));
		} catch {
			parsed = undefined;
		}
		const reviewed = lastRound(readOr(rounds, ""));
		return new RoundComment({
			verdict: parsed,
			exitCode,
			runUrl,
			runId,
			nonce,
			base,
			head,
			mergeBase,
			reviewed,
			current,
		});
	}

	body() {
		// The exit code and commits sit outside the fence.
		const exit = /^(\d{1,3}|none)$/.test(this.exitCode) ? this.exitCode : "unknown";
		const header = `${marker(this.runId, this.nonce)}\nMelian round on ${commit(this.base)}...${commit(this.head)}, exit ${exit}: [run](${this.runUrl})`;
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
			return `${header}\n\n${fenced(["Verdict: not reviewed", "", `${problem}; a local run of melian review says why.`])}`;
		}
		const quoted = [`Verdict: ${statuses[verdict.status]}${verdict.blocking ? ", blocking" : ""}`];
		const provisional = verdict.notRun.filter((check) => check.status === "provisional");
		const notRun = verdict.notRun.filter((check) => check.status !== "provisional");
		if (provisional.length > 0) quoted.push("", "Provisional:", ...provisional.map(checkLine), localRun);
		if (notRun.length > 0)
			quoted.push("", `${plural(notRun.length, "check")} did not run:`, ...notRun.map(checkLine), localRun);
		const lineage = [...(verdict.ran ?? []), ...verdict.notRun].filter((check) => check.lineage !== undefined);
		if (lineage.length > 0)
			quoted.push("", `${plural(lineage.length, "check")} left the committed routes:`, ...lineage.map(lineageLine));
		const findings = aboveAdvisory.flatMap((resolution) => verdict.findings[resolution]);
		quoted.push("", findings.length === 0 ? "No findings above advisory." : `Above advisory: ${findings.length}`);
		const cuttable = [];
		for (const finding of findings) {
			quoted.push(`  ${findingLine(finding)}`);
			for (const [label, text] of details(finding)) {
				cuttable.push({ at: quoted.length, label });
				quoted.push(oneLine(`    ${label}: ${text}`));
			}
		}
		// Past the limit, the longest detail goes first, and its line says so; fenced cuts whole lines only after that.
		const budget = maxLength - header.length - 2;
		while (fenced(quoted).length > budget && cuttable.length > 0) {
			const longest = cuttable.reduce((most, each) =>
				quoted[each.at].length > quoted[most.at].length ? each : most,
			);
			quoted[longest.at] = `    ${longest.label}: cut to fit the comment's limit; a local run shows it.`;
			cuttable.splice(cuttable.indexOf(longest), 1);
		}
		return `${header}\n\n${fenced(quoted, budget)}`;
	}
}

// `lines` in a three-backtick `text` code fence, at most `budget` characters long. A run of three or more backticks
// inside is written as `\u0060`s, as core's agent prompt writes backticks, so no line can close the fence and the fence
// never grows with the text. Past the budget it keeps the lines that fit and ends with one naming how many it cut.
export function fenced(text, budget = Number.POSITIVE_INFINITY) {
	const lines = text.map((line) => line.replace(/`{3,}/g, (run) => "\\u0060".repeat(run.length)));
	const render = (body) => `\`\`\`text\n${body.join("\n")}\n\`\`\`\n`;
	// Two fences, "text" and three newlines frame the body; each line costs its length and one newline less in all.
	const frame = 13;
	const sizes = [0];
	for (const line of lines) sizes.push(sizes.at(-1) + line.length + 1);
	if (frame + sizes[lines.length] - 1 <= budget) return render(lines);
	const note = (kept) => `... ${lines.length - kept} more lines; a local run shows them all.`;
	let kept = lines.length - 1;
	while (kept > 0 && frame + sizes[kept] + note(kept).length > budget) kept--;
	return render([...lines.slice(0, kept), note(kept)]);
}

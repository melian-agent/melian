// What the melian-round workflow does beside running melian: raise the lens budgets to a round's, take the Codex
// access token from a Codex login, and turn a round's output into a pull request comment. round-budgets.mjs,
// round-codex-token.mjs and round-comment.mjs are its commands.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The round budget AGENTS.md's "Three reviews before ready" sets. */
export const roundBudget = "budget: { findings: 8, tokens: 600000, tools: 90 }";
// The design lens's committed budget already exceeds the round's.
const kept = new Set(["design"]);

// Only the top-level line: a level's own budget stays, as the coordinator's rounds leave it.
export function withBudget(text, budget) {
	const lines = text.split("\n");
	if (lines[0] !== "---") throw new Error("a LENS.md must open with front matter");
	const end = lines.indexOf("---", 1);
	if (end === -1) throw new Error("a LENS.md front matter has no closing ---");
	const at = lines.slice(1, end).findIndex((line) => line.startsWith("budget:"));
	if (at === -1) lines.splice(end, 0, budget);
	else if (lines[at + 1].slice("budget:".length).trimStart().startsWith("{")) lines[at + 1] = budget;
	else throw new Error("a top-level budget must be one flow mapping on one line");
	return lines.join("\n");
}

export function raiseBudgets(directory) {
	const raised = [];
	if (!existsSync(directory)) return raised;
	for (const name of readdirSync(directory)) {
		const path = join(directory, name, "LENS.md");
		if (kept.has(name) || !existsSync(path)) continue;
		writeFileSync(path, withBudget(readFileSync(path, "utf8"), roundBudget));
		raised.push(name);
	}
	return raised;
}

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

export const marker = "<!-- melian-round -->";
// GitHub refuses a comment over 65,536 characters.
export const maxLength = 60_000;
const aboveAdvisory = ["block", "acknowledge"];

// Control characters, zero-width and bidi controls, and the line and paragraph separators. Keep them as escapes: a
// literal separator reads as a line break.
const invisible = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

export function visible(text) {
	return text.replace(invisible, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// A block of the rendered verdict: its heading line and the lines under it, up to the next line at the margin. The
// renderer indents every continuation, and a blank line inside an indented error reads as empty once trimmed.
function section(lines, heading) {
	const start = lines.findIndex(heading);
	if (start === -1) return [];
	const block = [lines[start]];
	for (const line of lines.slice(start + 1)) {
		if (line !== "" && !line.startsWith(" ")) break;
		block.push(line);
	}
	return block.slice(0, block.findLastIndex((line) => line !== "") + 1);
}

function findingLine(finding) {
	const { id, severity, resolution, path, source } = finding.properties;
	const region = finding.locations[0]?.physicalLocation.region ?? {};
	const start = region.startLine;
	const end = region.endLine ?? start;
	const where = start === undefined ? path : `${path}:${start}${end === start ? "" : `-${end}`}`;
	const line = `${severity} ${resolution}  ${where}  ${source.check}  ${finding.ruleId}  ${id}  ${finding.message.text}`;
	return visible(line.replace(/\r?\n/g, " "));
}

/**
 * The comment for one round: the run's link, the verdict line, the checks that did not run, and every finding above
 * advisory. Everything after the link comes from the round, and so from the head under review, so it sits inside one
 * code fence that no backtick run in it can close.
 */
export class RoundComment {
	constructor({ text, verdict, exitCode, runUrl, head }) {
		this.text = text;
		this.verdict = verdict;
		this.exitCode = exitCode;
		this.runUrl = runUrl;
		this.head = head;
	}

	static read(textPath, verdictPath, exitCode, runUrl, head) {
		const text = existsSync(textPath) ? readFileSync(textPath, "utf8") : "";
		const verdict = existsSync(verdictPath) ? JSON.parse(readFileSync(verdictPath, "utf8")) : undefined;
		return new RoundComment({ text, verdict, exitCode, runUrl, head });
	}

	body() {
		const lines = this.text.split("\n").map((line) => line.trimEnd());
		const verdictLine = lines.find((line) => line.startsWith("Verdict: "));
		// The exit code sits outside the fence, and the head's code could have written the file it came from.
		const exit = /^(\d{1,3}|none)$/.test(this.exitCode) ? this.exitCode : "unknown";
		const header = `${marker}\nMelian round on \`${this.head.slice(0, 12)}\`, exit ${exit}: [run](${this.runUrl})`;
		if (verdictLine === undefined) {
			return `${header}\n\nThe round ended before it decided a verdict. The run's log and summary say why.\n`;
		}
		const quoted = [visible(verdictLine)];
		const headings = [
			(line) => line === "Provisional:",
			(line) => /^\S.* did not run:$/.test(line),
			(line) => /^\S.* left the committed routes:$/.test(line),
		];
		for (const heading of headings) {
			const block = section(lines, heading);
			if (block.length > 0) quoted.push("", ...block.map(visible));
		}
		if (this.verdict === undefined) {
			quoted.push("", "The findings could not be read; the run's artefact holds the whole output.");
		} else {
			const findings = aboveAdvisory.flatMap((resolution) => this.verdict.findings[resolution]);
			quoted.push("", findings.length === 0 ? "No findings above advisory." : `Above advisory: ${findings.length}`);
			quoted.push(...findings.map((finding) => `  ${findingLine(finding)}`));
		}
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

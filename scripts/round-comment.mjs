// Writes the pull request comment for a Melian round the melian-round workflow ran: the run's link, the verdict line,
// the checks that did not run, and every finding above advisory. Everything after the link comes from the round, and
// so from the head under review, so it sits inside one code fence that no backtick run in it can close.
// Usage: node scripts/round-comment.mjs <round.txt> <verdict.json> <exit code> <run URL> <head SHA>
//        node scripts/round-comment.mjs --fence <file>, which prints the file fenced, for the job summary
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const marker = "<!-- melian-round -->";
export const maxLength = 60_000;
const aboveAdvisory = ["block", "acknowledge"];

// Control characters, zero-width and bidi controls, and the line and paragraph separators.
const invisible = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

function visible(text) {
	return text.replace(invisible, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function oneLine(text) {
	return visible(text.replace(/\r?\n/g, " "));
}

// A block of the rendered verdict: its heading line and the indented lines under it, up to the blank line that ends it.
function section(lines, heading) {
	const start = lines.findIndex(heading);
	if (start === -1) return [];
	const end = lines.indexOf("", start);
	return lines.slice(start, end === -1 ? undefined : end);
}

function findingLine(finding) {
	const { id, severity, resolution, path, source } = finding.properties;
	const region = finding.locations?.[0]?.physicalLocation?.region ?? {};
	const start = region.startLine;
	const end = region.endLine ?? start;
	const where = start === undefined ? path : `${path}:${start}${end === start ? "" : `-${end}`}`;
	return oneLine(
		`${severity} ${resolution}  ${where}  ${source.check}  ${finding.ruleId}  ${id}  ${finding.message.text}`,
	);
}

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
		const header = `${marker}\nMelian round on \`${this.head.slice(0, 12)}\`, exit ${this.exitCode}: [run](${this.runUrl})`;
		if (verdictLine === undefined) {
			return `${header}\n\nThe round ended before it decided a verdict. The run's log and summary say why.\n`;
		}
		const quoted = [visible(verdictLine)];
		for (const heading of [(line) => line === "Provisional:", (line) => /^\S.* did not run:$/.test(line)]) {
			const block = section(lines, heading);
			if (block.length > 0) quoted.push("", ...block.map(visible));
		}
		const findings = aboveAdvisory.flatMap((resolution) => this.verdict?.findings?.[resolution] ?? []);
		quoted.push("", findings.length === 0 ? "No findings above advisory." : `Above advisory: ${findings.length}`);
		quoted.push(...findings.map((finding) => `  ${findingLine(finding)}`));
		return `${header}\n\n${fenced(quoted, maxLength - header.length - 2)}`;
	}
}

// Keeps whole lines while they fit `budget`, names how many it cut, and fences the rest with a fence longer than any
// backtick run inside.
export function fenced(lines, budget = Number.POSITIVE_INFINITY) {
	const longest = lines.reduce((most, line) => {
		for (const run of line.match(/`+/g) ?? []) most = Math.max(most, run.length);
		return most;
	}, 0);
	const fence = "`".repeat(Math.max(3, longest + 1));
	const room = budget - 2 * fence.length - 100;
	let used = 0;
	let kept = 0;
	for (const line of lines) {
		if (used + line.length + 1 > room) break;
		used += line.length + 1;
		kept++;
	}
	const body =
		kept === lines.length
			? lines
			: [...lines.slice(0, kept), `... ${lines.length - kept} more lines; the run's artefact has them all.`];
	return `${fence}text\n${body.join("\n")}\n${fence}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--fence") {
	const path = process.argv[3];
	const text = path !== undefined && existsSync(path) ? readFileSync(path, "utf8").trimEnd() : "";
	process.stdout.write(text === "" ? "Nothing was written.\n" : fenced(text.split("\n").map(visible), 300_000));
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [textPath, verdictPath, exitCode, runUrl, head] = process.argv.slice(2);
	if (head === undefined) {
		process.stderr.write(
			"usage: node scripts/round-comment.mjs <round.txt> <verdict.json> <exit> <run URL> <head>\n",
		);
		process.exit(64);
	}
	process.stdout.write(RoundComment.read(textPath, verdictPath, exitCode, runUrl, head).body());
}

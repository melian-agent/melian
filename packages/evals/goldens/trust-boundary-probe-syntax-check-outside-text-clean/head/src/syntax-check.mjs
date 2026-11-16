// Runs `node --check` on every JavaScript module of a checkout and turns each syntax error into a finding, which the
// review stores and publishes on the pull request. Node quotes the source line it failed on, and a committed link can
// point it at a file outside the checkout, so a finding keeps the rule and the place, never Node's text.
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

function modules(root, directory = root) {
	const found = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...modules(root, path));
		else if (/\.[cm]?js$/.test(entry.name)) found.push(path);
	}
	return found.sort();
}

// Node prints the module's real path, a link's target, with the failing line, the source line with a caret under it, a
// blank line, then the error. A file name can hold a newline and the source line can look like an error, so the place
// is read after the known path, and the rule after the blank line, only from Node's own error names.
const errorNames = ["SyntaxError", "ReferenceError", "TypeError", "RangeError", "Error"];

export function parseCheck(output, path) {
	if (!output.startsWith(`${path}:`)) return undefined;
	const lines = output.slice(path.length).split("\n");
	const place = /^:(\d+)$/.exec(lines[0]);
	const blank = lines.indexOf("");
	const name = blank === -1 ? undefined : lines[blank + 1]?.split(": ")[0];
	if (place === null || !errorNames.includes(name)) return undefined;
	return { line: Number(place[1]), rule: name };
}

// A file name is the head's, and can hold a terminal's control characters.
function visible(text) {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function withheld(file) {
	return `node --check failed on ${file}; run it there to see why, since the check keeps none of its output`;
}

export function checkFindings(root) {
	const findings = [];
	for (const path of modules(root)) {
		const run = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
		if (run.status === 0) continue;
		const parsed = parseCheck(run.stderr, realpathSync(path));
		const file = relative(root, path);
		if (parsed === undefined) {
			findings.push({ file, line: 1, rule: "node/check-failed", message: withheld(file) });
			continue;
		}
		findings.push({ file, line: parsed.line, rule: `node/${parsed.rule}`, message: withheld(file) });
	}
	return findings;
}

export function render(findings) {
	if (findings.length === 0) return "No findings.\n";
	return `${findings.map(({ file, line, rule, message }) => `P1 ${visible(file)}:${line} ${rule}\n  ${visible(message)}`).join("\n")}\n`;
}

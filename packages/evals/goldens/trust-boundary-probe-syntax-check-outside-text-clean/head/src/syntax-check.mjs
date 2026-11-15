// Runs `node --check` on every JavaScript module of a checkout and turns each syntax error into a finding, which the
// review stores and publishes on the pull request. Node quotes the source line it failed on, and a committed link can
// point it at a file outside the checkout, so a finding keeps the rule and the place, never Node's text.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

function modules(root, directory = root) {
	const found = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...modules(root, path));
		else if (/\.m?js$/.test(entry.name)) found.push(path);
	}
	return found.sort();
}

// Node prints the failing file and line, the source line with a caret under it, a blank line, then the error.
export function parseCheck(output) {
	const lines = output.split("\n");
	const place = /:(\d+)$/.exec(lines[0] ?? "");
	const error = lines.findIndex((line) => /^\w*Error: /.test(line));
	if (place === null || error === -1) return undefined;
	return { line: Number(place[1]), rule: lines[error].split(": ")[0] };
}

function withheld(file) {
	return `node --check failed on ${file}; run it there to see why, since the check keeps none of its output`;
}

export function checkFindings(root) {
	const findings = [];
	for (const path of modules(root)) {
		const run = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
		if (run.status === 0) continue;
		const parsed = parseCheck(run.stderr);
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
	return `${findings.map(({ file, line, rule, message }) => `P1 ${file}:${line} ${rule}\n  ${message.replaceAll("\n", "\n  ")}`).join("\n")}\n`;
}

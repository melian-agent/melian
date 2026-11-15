// Runs `node --check` on every JavaScript module of a checkout and turns each syntax error into a finding, which the
// review stores and publishes on the pull request.
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
	const [name, ...rest] = lines[error].split(": ");
	const quoted = lines.slice(1, error).filter((line) => line.trim() !== "");
	return { line: Number(place[1]), rule: name, text: [rest.join(": "), ...quoted].join("\n") };
}

export function checkFindings(root) {
	const findings = [];
	for (const path of modules(root)) {
		const run = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
		if (run.status === 0) continue;
		const parsed = parseCheck(run.stderr);
		const file = relative(root, path);
		if (parsed === undefined) {
			findings.push({ file, line: 1, rule: "node/check-failed", message: `node --check failed: ${run.stderr}` });
			continue;
		}
		findings.push({ file, line: parsed.line, rule: `node/${parsed.rule}`, message: parsed.text });
	}
	return findings;
}

export function render(findings) {
	if (findings.length === 0) return "No findings.\n";
	return `${findings.map(({ file, line, rule, message }) => `P1 ${file}:${line} ${rule}\n  ${message.replaceAll("\n", "\n  ")}`).join("\n")}\n`;
}

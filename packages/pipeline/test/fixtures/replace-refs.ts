import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A `git` that first asks the real git, with the options and environment it was given, what `core.useReplaceRefs`
// reads, and logs the answer. Git 2.40 and 2.41 let that setting outrank GIT_NO_REPLACE_OBJECTS, so a call that reads
// `true` there sees replacements; later versions hide the gap, so the setting itself is what a test can see.
export function replaceRefsProbe(): { readonly bin: string; readonly answers: () => string[] } {
	const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const bin = mkdtempSync(join(tmpdir(), "melian-replace-refs-"));
	const log = join(bin, "answers.log");
	writeFileSync(log, "");
	writeFileSync(
		join(bin, "git"),
		[
			"#!/bin/bash",
			"pre=()",
			'while [ $# -gt 0 ]; do case "$1" in -C|-c) pre+=("$1" "$2"); shift 2;; *) break;; esac; done',
			`answer=$('${real}' "\${pre[@]}" config --get core.useReplaceRefs) || answer=unset`,
			`echo "$answer" >> '${log}'`,
			`exec '${real}' "\${pre[@]}" "$@"`,
			"",
		].join("\n"),
	);
	chmodSync(join(bin, "git"), 0o755);
	return { bin, answers: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

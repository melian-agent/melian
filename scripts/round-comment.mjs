// Writes the pull request comment for a round the melian-round workflow ran, or with --fence prints a file fenced for
// the job summary.
// Usage: node scripts/round-comment.mjs <verdict.json> <exit code> <run URL> <base SHA> <head SHA> [<current base> <current head>]
//        A missing current base or head means the pull request could not be read again.
//        node scripts/round-comment.mjs --fence <file>
import { existsSync, readFileSync } from "node:fs";
import { visibleText } from "../packages/core/src/render.ts";
import { fenced, RoundComment } from "./round.mjs";

// A step summary holds 1 MiB; the summary fences two files.
const summaryBudget = 300_000;

if (process.argv[2] === "--fence") {
	const path = process.argv[3];
	const text = existsSync(path) ? readFileSync(path, "utf8").trimEnd() : "";
	process.stdout.write(
		text === "" ? "Nothing was written.\n" : fenced(text.split("\n").map(visibleText), summaryBudget),
	);
} else {
	const [verdictPath, exitCode, runUrl, base, head, currentBase, currentHead] = process.argv.slice(2);
	if (head === undefined) {
		process.stderr.write(
			"usage: node scripts/round-comment.mjs <verdict.json> <exit> <run URL> <base> <head> [<base> <head>]\n",
		);
		process.exit(64);
	}
	const current = currentHead === undefined ? undefined : { base: currentBase, head: currentHead };
	process.stdout.write(RoundComment.read(verdictPath, exitCode, runUrl, base, head, current).body());
}

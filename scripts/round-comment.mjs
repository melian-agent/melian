// Writes the pull request comment for a round the melian-round workflow ran, or with --fence prints a file fenced for
// the job summary.
// Usage: node scripts/round-comment.mjs <round.txt> <verdict.json> <exit code> <run URL> <head SHA>
//        node scripts/round-comment.mjs --fence <file>
import { existsSync, readFileSync } from "node:fs";
import { fenced, RoundComment, visible } from "./round.mjs";

// A step summary holds 1 MiB; the summary fences two files.
const summaryBudget = 300_000;

if (process.argv[2] === "--fence") {
	const path = process.argv[3];
	const text = existsSync(path) ? readFileSync(path, "utf8").trimEnd() : "";
	process.stdout.write(text === "" ? "Nothing was written.\n" : fenced(text.split("\n").map(visible), summaryBudget));
} else {
	const [textPath, verdictPath, exitCode, runUrl, head] = process.argv.slice(2);
	if (head === undefined) {
		process.stderr.write(
			"usage: node scripts/round-comment.mjs <round.txt> <verdict.json> <exit> <run URL> <head>\n",
		);
		process.exit(64);
	}
	process.stdout.write(RoundComment.read(textPath, verdictPath, exitCode, runUrl, head).body());
}

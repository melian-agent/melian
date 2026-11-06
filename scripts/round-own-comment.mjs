// Prints the ID of the comment this run of the melian-round workflow already posted, or nothing when it posted none.
// Exits 1 when the comments cannot be read, so a rerun never posts a second comment.
// Usage: node scripts/round-own-comment.mjs <comments, JSON lines> <run ID> <author>
import { readFileSync } from "node:fs";
import { ownComment } from "./round.mjs";

const [commentsPath, runId, author] = process.argv.slice(2);
if (author === undefined) {
	process.stderr.write("usage: node scripts/round-own-comment.mjs <comments.jsonl> <run ID> <author>\n");
	process.exit(64);
}
try {
	process.stdout.write(String(ownComment(readFileSync(commentsPath, "utf8"), { runId, author }) ?? ""));
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
}

// Prints the login whose write permission decides whether the melian-round workflow may run a pull request's head.
// Exits 1, printing nothing to standard output, when the push events cannot say.
// Usage: node scripts/round-writer.mjs <push events, JSON lines> <head SHA> <head branch> <pull request author>
import { readFileSync } from "node:fs";
import { headWriter } from "./round.mjs";

const [eventsPath, sha, branch, author] = process.argv.slice(2);
if (branch === undefined) {
	process.stderr.write("usage: node scripts/round-writer.mjs <events.jsonl> <head SHA> <head branch> <author>\n");
	process.exit(64);
}
try {
	process.stdout.write(headWriter(readFileSync(eventsPath, "utf8"), { sha, branch, author }));
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
}

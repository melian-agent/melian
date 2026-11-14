// Prints the commit status that records the body of the comment the melian-round workflow just posted or edited, as
// the JSON GitHub's statuses API takes. Exits 1 when GitHub's answer cannot be read, so no record names a wrong body.
// Usage: node scripts/round-record.mjs <GitHub's answer to the post or edit> <run ID> <pull request number>
import { readFileSync } from "node:fs";
import { commentRecord } from "./round.mjs";

const [postedPath, runId, pull] = process.argv.slice(2);
if (pull === undefined) {
	process.stderr.write("usage: node scripts/round-record.mjs <posted.json> <run ID> <pull request number>\n");
	process.exit(64);
}
try {
	process.stdout.write(JSON.stringify(commentRecord(readFileSync(postedPath, "utf8"), { runId, pull })));
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
}

// Runs a fetch that never ends under a short deadline, then has nothing left to do, so the process should exit.
import { git } from "../../src/git.ts";

const [repo, transport] = process.argv.slice(2) as [string, string];
const result = await git(repo, ["-c", "protocol.ext.allow=always", "fetch", `ext::sh ${transport}`], {
	deadlineMs: 300,
});
process.stdout.write(`${result.timedOut === true}\n`);

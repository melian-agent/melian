// Runs a fetch whose transport writes to standard error without end, under a deadline far off, then has nothing left to
// do, so the process should exit once git is stopped.
import { git } from "../../src/git.ts";

const [repo, transport] = process.argv.slice(2) as [string, string];
const code = await git(repo, ["-c", "protocol.ext.allow=always", "fetch", `ext::sh ${transport}`], {
	deadlineMs: 60_000,
}).then(
	() => "resolved",
	(error: { code?: string }) => error.code,
);
process.stdout.write(`${code}\n`);

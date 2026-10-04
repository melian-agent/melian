import { lint } from "./lint.ts";
import { comment } from "./publish.ts";

const [repository, pullRequest, worktree] = process.argv.slice(2) as [string, string, string];
const report = lint(worktree);
await comment(repository, Number(pullRequest), `Lint report:\n\n${report}`);

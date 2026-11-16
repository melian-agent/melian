// Runs a stand-in for git, found first on PATH, under a short deadline, then has nothing left to do, so the process
// should exit though a program the stand-in started still holds its output.
import { git } from "../../src/git.ts";

const [repo, bin] = process.argv.slice(2) as [string, string];
const result = await git(repo, ["fetch"], { deadlineMs: 300, env: { PATH: `${bin}:${process.env.PATH}` } });
const { code, stdout, timedOut, childrenLeft } = result;
process.stdout.write(`${JSON.stringify({ code, stdout, timedOut, childrenLeft })}\n`);

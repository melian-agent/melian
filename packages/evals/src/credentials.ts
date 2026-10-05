import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadSecrets, type NamedCredential, userFiles } from "@melian-agent/core";

const run = promisify(execFile);

/**
 * The named credentials a live run reads, as a review does: the per-clone secrets file of the repository `from` lies
 * in, at its top level, then the user's own. `npm run eval:live` runs from the evals package, not the repository
 * root, so the root is git's top level rather than the working directory.
 */
export async function liveCredentials(
	from: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<readonly NamedCredential[]> {
	const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: from });
	return (await loadSecrets(stdout.trim(), userFiles(env).secrets)).credentials;
}

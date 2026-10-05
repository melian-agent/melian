import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadSecrets, type NamedCredential, userFiles } from "@melian-agent/core";

const run = promisify(execFile);

// From git's top level, not the working directory: `npm run eval:live` runs from the evals package.
export async function liveCredentials(
	from: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<readonly NamedCredential[]> {
	const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: from });
	return (await loadSecrets(stdout.trim(), userFiles(env).secrets)).credentials;
}

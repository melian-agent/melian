import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadSecrets, type NamedCredential, userFiles } from "@melian-agent/core";
import { createReviewModels, type ReviewModels, unlockCredentials } from "@melian-agent/pipeline";

const run = promisify(execFile);

// From git's top level, not the working directory: `npm run eval:live` runs from the evals package.
export async function liveCredentials(
	from: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<readonly NamedCredential[]> {
	const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: from });
	return (await loadSecrets(stdout.trim(), userFiles(env).secrets)).credentials;
}

// `reviewChangeset` runs no credential command itself; a host unlocks first, as the CLI does. A failing command then
// stops the run here, naming the credential, rather than failing every lens over as an authentication error.
export async function liveModels(from: string, env: NodeJS.ProcessEnv = process.env): Promise<ReviewModels> {
	const credentials = await liveCredentials(from, env);
	const models = createReviewModels({ credentials });
	await unlockCredentials(models, [...new Set(credentials.map((credential) => credential.provider))]);
	return models;
}

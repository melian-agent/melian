import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { parseGitHubRemote, resolveGitHubToken } from "@melian-agent/github";
import { createReviewModels, piAuthPath } from "@melian-agent/pipeline";
import type { Io } from "./commands.ts";
import { git } from "./repository.ts";

type Check = { readonly name: string; readonly state: "ok" | "warn" | "fail"; readonly detail: string };

function run(command: string, args: readonly string[], cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(command, args, { cwd, timeout: 10_000 }, (error, stdout) =>
			resolve(error === null ? stdout.trim() : undefined),
		);
	});
}

function atLeast(version: string, minimum: readonly number[]): boolean {
	const parts = version.split(".").map(Number);
	for (const [index, floor] of minimum.entries()) {
		const part = parts[index] ?? 0;
		if (part !== floor) return part > floor;
	}
	return true;
}

async function gitCheck(cwd: string): Promise<Check> {
	const output = await run("git", ["--version"], cwd);
	const version = /git version (\d+\.\d+(?:\.\d+)?)/.exec(output ?? "")?.[1];
	if (version === undefined) return { name: "git", state: "fail", detail: "not found on PATH" };
	// git before 2.40 rejects the option outright; Melian needs it to read diff attributes from the base.
	const attrSource = (await run("git", ["--attr-source=HEAD", "version"], cwd)) !== undefined;
	const ok = atLeast(version, [2, 40]) && attrSource;
	return {
		name: "git",
		state: ok ? "ok" : "fail",
		detail: `${version}, --attr-source ${attrSource ? "supported" : "unsupported"}${ok ? "" : "; Melian needs 2.40 or later"}`,
	};
}

async function credentialsCheck(): Promise<Check> {
	const models = createReviewModels();
	const configured: string[] = [];
	for (const provider of models.getProviders()) {
		if ((await models.checkAuth(provider.id).catch(() => undefined)) !== undefined) configured.push(provider.id);
	}
	return configured.length === 0
		? { name: "models", state: "warn", detail: "no provider has credentials; log in with pi or set an API key" }
		: { name: "models", state: "ok", detail: `credentials for ${configured.sort().join(", ")}` };
}

async function repositoryCheck(cwd: string): Promise<Check> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return { name: "repository", state: "warn", detail: "not inside a git repository" };
	const url = await git(cwd, ["remote", "get-url", "origin"]).catch(() => undefined);
	if (url === undefined) return { name: "repository", state: "warn", detail: `${root}, with no origin remote` };
	try {
		const { owner, repo } = parseGitHubRemote(url);
		return { name: "repository", state: "ok", detail: `${root}, origin is github.com/${owner}/${repo}` };
	} catch {
		return { name: "repository", state: "warn", detail: `${root}, origin is not on GitHub` };
	}
}

/**
 * `melian doctor`: checks what a review and a publication need, and prints one line per check. Credentials are named
 * by provider and source only, never by value. Exits `1` when Node or git cannot run a review, `0` otherwise.
 */
export async function doctor(io: Io): Promise<number> {
	const nodeVersion = process.versions.node;
	const authPath = piAuthPath(io.env);
	const token = await resolveGitHubToken(io.env);
	const gh = await run("gh", ["--version"], io.cwd);
	const checks: Check[] = [
		{
			name: "node",
			state: atLeast(nodeVersion, [22, 19]) ? "ok" : "fail",
			detail: `${nodeVersion}; Melian needs 22.19.0 or later`,
		},
		await gitCheck(io.cwd),
		existsSync(authPath)
			? { name: "pi login", state: "ok", detail: `${authPath} found` }
			: { name: "pi login", state: "warn", detail: `${authPath} not found; environment variables still apply` },
		await credentialsCheck(),
		token === undefined
			? { name: "github", state: "warn", detail: "no token; set GITHUB_TOKEN or GH_TOKEN, or run gh auth login" }
			: { name: "github", state: "ok", detail: `token from ${token.source}` },
		gh === undefined
			? { name: "gh", state: "warn", detail: "not found on PATH" }
			: { name: "gh", state: "ok", detail: gh.split("\n")[0]! },
		await repositoryCheck(io.cwd),
	];
	const width = Math.max(...checks.map((check) => check.name.length));
	for (const check of checks) io.stdout(`${check.state.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}\n`);
	return checks.some((check) => check.state === "fail") ? 1 : 0;
}

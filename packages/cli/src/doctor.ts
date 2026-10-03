import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { type LensTier, loadConfig, type StaticTool } from "@melian-agent/core";
import { parseGitHubRemote, resolveGitHubToken } from "@melian-agent/github";
import { createReviewModels, piAuthPath, providersWithCredentials, staticToolSource } from "@melian-agent/pipeline";
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
	const configured = await providersWithCredentials(createReviewModels());
	return configured.length === 0
		? { name: "models", state: "warn", detail: "no provider has credentials; log in with pi or set an API key" }
		: { name: "models", state: "ok", detail: `credentials for ${configured.join(", ")}` };
}

const tiers: readonly LensTier[] = ["light", "medium", "heavy"];

// A lens runs on the model its tier routes to. With none routed, every review without --model stops with "no model is
// configured", so doctor reports it before a review does.
async function routesCheck(cwd: string): Promise<Check | undefined> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	try {
		const { config } = await loadConfig(root, { kind: "worktree" }, ".");
		const routed = tiers.filter((tier) => config.models[tier] !== undefined);
		if (routed.length === 0) {
			return {
				name: "routes",
				state: "warn",
				detail:
					"no tier is routed to a model; set models.light, medium, and heavy in melian.local.yaml, or pass --model to review",
			};
		}
		const routes = routed.map((tier) => `${tier} to ${config.models[tier]!.model}`);
		return { name: "routes", state: "ok", detail: routes.join(", ") };
	} catch (error) {
		return { name: "routes", state: "warn", detail: error instanceof Error ? error.message : String(error) };
	}
}

const staticTools: readonly StaticTool[] = ["biome", "tsc"];

// The static checks run the checkout's own Biome and tsc when it has them installed, and Melian's copy otherwise, so a
// result can differ from the repository's own lint run.
async function staticCheck(cwd: string): Promise<Check | undefined> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	const sources = staticTools.map((tool) => ({ tool, ...staticToolSource(root, tool) }));
	const where = { checkout: "the checkout", melian: "Melian's own copy", missing: "nowhere" } as const;
	return {
		name: "static",
		state: sources.some((source) => source.from === "missing") ? "warn" : "ok",
		detail: sources.map((source) => `${source.tool} from ${where[source.from]}`).join(", "),
	};
}

// A melian the checkout provides runs code the change under review can rewrite.
async function executableCheck(cwd: string, executable: string | undefined): Promise<Check | undefined> {
	if (executable === undefined) return undefined;
	const real = realpathSync(executable);
	const shown = real === executable ? executable : `${executable}, which is ${real}`;
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return { name: "melian", state: "ok", detail: shown };
	const checkouts = [root, realpathSync(root)].map((path) => `${path}${sep}`);
	const inside = [executable, real].some((path) => checkouts.some((checkout) => path.startsWith(checkout)));
	return inside
		? {
				name: "melian",
				state: "warn",
				detail: `${shown}, inside this checkout, so the change can alter its reviewer`,
			}
		: { name: "melian", state: "ok", detail: `${shown}, outside this checkout` };
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

// Names credentials by provider and source, never by value.
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
		...[await executableCheck(io.cwd, io.executable), await routesCheck(io.cwd), await staticCheck(io.cwd)].filter(
			(check) => check !== undefined,
		),
	];
	const width = Math.max(...checks.map((check) => check.name.length));
	for (const check of checks) io.stdout(`${check.state.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}\n`);
	return checks.some((check) => check.state === "fail") ? 1 : 0;
}

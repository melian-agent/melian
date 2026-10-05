import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import {
	checksOfTier,
	Lens,
	type LoadedSecrets,
	loadConfig,
	loadSecrets,
	melianPaths,
	type StaticTool,
	userFiles,
	visibleText,
} from "@melian-agent/core";
import { parseGitHubRemote, resolveGitHubToken } from "@melian-agent/github";
import { createReviewModels, piAuthPath, providersWithCredentials, staticToolSource } from "@melian-agent/pipeline";
import type { Io } from "./commands.ts";
import { reviewModels } from "./models.ts";
import { git, stateDirectory, stateDirectoryVariable } from "./repository.ts";

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

async function credentialsCheck(secrets: LoadedSecrets): Promise<Check> {
	let configured: string[];
	try {
		configured = await providersWithCredentials(createReviewModels({ credentials: secrets.credentials }));
	} catch (error) {
		return { name: "models", state: "fail", detail: error instanceof Error ? error.message : String(error) };
	}
	return configured.length === 0
		? { name: "models", state: "warn", detail: "no provider has credentials; log in with pi or set an API key" }
		: { name: "models", state: "ok", detail: `credentials for ${configured.join(", ")}` };
}

// The secrets files, and the files only a maintainer may hold, which git must never track: a tracked melian.secrets.yaml
// commits a key, and a tracked melian.local.yaml lets the repository pose as the maintainer's own preferences.
async function secretsCheck(cwd: string, env: NodeJS.ProcessEnv): Promise<{ checks: Check[]; secrets: LoadedSecrets }> {
	const none = { credentials: [], warnings: [] };
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return { checks: [], secrets: none };
	// In any case of the name: a case-insensitive filesystem opens a committed MELIAN.SECRETS.YAML as the file itself.
	// A pathspec also matches every file beneath a directory of that name, so only the two names count, and a path, the
	// head's text, prints escaped.
	const names: readonly string[] = [melianPaths.localConfig, melianPaths.secrets];
	const pathspecs = names.map((name) => `:(icase,top,literal)${name}`);
	const listed = await git(root, ["ls-files", "-z", "--", ...pathspecs]).catch(() => undefined);
	const checks: Check[] =
		listed === undefined
			? [{ name: "secrets", state: "fail", detail: "git could not say whether it tracks a file only you may hold" }]
			: listed
					.split("\0")
					.filter((file) => names.includes(file.toLowerCase()))
					.map((file) => ({
						name: "secrets",
						state: "fail",
						detail: `git tracks ${visibleText(file)}, which is yours alone; run git rm --cached ${visibleText(file)}`,
					}));
	try {
		const secrets = await loadSecrets(root, userFiles(env).secrets);
		const named = secrets.credentials.map(
			({ name, provider, file }) => `${visibleText(name)} for ${visibleText(provider)} in ${visibleText(file)}`,
		);
		checks.push(...secrets.warnings.map((detail): Check => ({ name: "secrets", state: "warn", detail })), {
			name: "secrets",
			state: "ok",
			detail: named.length === 0 ? "no named credentials" : named.join(", "),
		});
		return { checks, secrets };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { checks: [...checks, { name: "secrets", state: "fail", detail }], secrets: none };
	}
}

// The review plan doctor would resolve now: each tier's model, credential, and file, each lens's levels, and every
// warning, such as a tier a stage's lenses run on that no file routes, which would stop a review before that lens ran.
async function planChecks(cwd: string, env: NodeJS.ProcessEnv, secrets: LoadedSecrets): Promise<Check[]> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return [];
	try {
		const source = { kind: "worktree", preferences: userFiles(env).config } as const;
		const loaded = await loadConfig(root, source, ".");
		const checks = Object.values(loaded.config.stages).flatMap((stage) => checksOfTier(loaded.config, stage));
		const lenses = await Lens.load(root, source, ["."]);
		const { plan } = await reviewModels({}, loaded, lenses, { checks, credentials: secrets.credentials });
		return plan.lines().map(({ state, text }) => ({ name: "plan", state, detail: text }));
	} catch (error) {
		return [{ name: "plan", state: "warn", detail: error instanceof Error ? error.message : String(error) }];
	}
}

// Triage will choose a level by how hard a lens should look, so a higher level that costs less inverts its choice.
async function levelsCheck(cwd: string): Promise<Check | undefined> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	try {
		const inverted = (await Lens.load(root, { kind: "worktree" }, ["."])).flatMap((lens) => {
			const found = lens.inversions();
			return found.length === 0 ? [] : [`${lens.name}: ${found.join("; ")}`];
		});
		return inverted.length === 0
			? { name: "levels", state: "ok", detail: "each lens's levels cost more from quick to deep" }
			: { name: "levels", state: "warn", detail: `${inverted.join("; ")}; set the level's own tier or budget` };
	} catch (error) {
		return { name: "levels", state: "warn", detail: error instanceof Error ? error.message : String(error) };
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

// A sandbox can keep .git read-only, and every review then fails to open its storage. Writing a file is the only test a
// sandbox answers truthfully; it may pass a permission check and still refuse the write.
async function stateCheck(cwd: string, env: NodeJS.ProcessEnv): Promise<Check | undefined> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	const directory = await stateDirectory(root, env);
	const probe = join(directory, `.doctor-${process.pid}`);
	try {
		await mkdir(directory, { recursive: true });
		await writeFile(probe, "");
		await rm(probe, { force: true });
		return { name: "state", state: "ok", detail: `${directory}, writable` };
	} catch (error) {
		return {
			name: "state",
			state: "warn",
			detail: `${directory} is not writable (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); give this host write access there, or set ${stateDirectoryVariable} to a writable directory`,
		};
	}
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
	const { checks: secretChecks, secrets } = await secretsCheck(io.cwd, io.env);
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
		...secretChecks,
		await credentialsCheck(secrets),
		token === undefined
			? { name: "github", state: "warn", detail: "no token; set GITHUB_TOKEN or GH_TOKEN, or run gh auth login" }
			: { name: "github", state: "ok", detail: `token from ${token.source}` },
		gh === undefined
			? { name: "gh", state: "warn", detail: "not found on PATH" }
			: { name: "gh", state: "ok", detail: gh.split("\n")[0]! },
		await repositoryCheck(io.cwd),
		...[
			await executableCheck(io.cwd, io.executable),
			await stateCheck(io.cwd, io.env),
			await levelsCheck(io.cwd),
			await staticCheck(io.cwd),
		].filter((check) => check !== undefined),
		...(await planChecks(io.cwd, io.env, secrets)),
	];
	const width = Math.max(...checks.map((check) => check.name.length));
	for (const check of checks) io.stdout(`${check.state.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}\n`);
	return checks.some((check) => check.state === "fail") ? 1 : 0;
}

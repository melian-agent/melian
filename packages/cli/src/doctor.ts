import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import {
	checksOfTier,
	defaultScrutinyLevel,
	type Lens,
	type LensTier,
	loadConfig,
	loadLenses,
	type MelianConfig,
	type StaticTool,
	scrutinyLevels,
} from "@melian-agent/core";
import { parseGitHubRemote, resolveGitHubToken } from "@melian-agent/github";
import { createReviewModels, piAuthPath, providersWithCredentials, staticToolSource } from "@melian-agent/pipeline";
import type { Io } from "./commands.ts";
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

async function credentialsCheck(): Promise<Check> {
	const configured = await providersWithCredentials(createReviewModels());
	return configured.length === 0
		? { name: "models", state: "warn", detail: "no provider has credentials; log in with pi or set an API key" }
		: { name: "models", state: "ok", detail: `credentials for ${configured.join(", ")}` };
}

const tiers: readonly LensTier[] = ["light", "medium", "heavy"];

// Each model tier the stages' lenses run on, with those lenses: a stage names a check tier, and each `lens.<name>` in it
// runs on the model tier of its lens's default level, as melian.yaml may retier it.
async function tiersInUse(root: string, config: MelianConfig): Promise<Map<LensTier, string[]>> {
	const names = new Set(
		Object.values(config.stages)
			.flatMap((stage) => checksOfTier(config, stage))
			.filter((check) => check.startsWith("lens."))
			.map((check) => check.slice("lens.".length)),
	);
	const used = new Map<LensTier, string[]>();
	for (const lens of await loadLenses(root, { kind: "worktree" }, ["."])) {
		const settings = Object.hasOwn(config.lenses, lens.name) ? config.lenses[lens.name] : undefined;
		if (!names.has(lens.name) || settings?.enabled === false) continue;
		const tier = settings?.tier ?? lens.levels[defaultScrutinyLevel].tier;
		used.set(tier, [...new Set([...(used.get(tier) ?? []), lens.name])]);
	}
	return used;
}

// A lens runs on the model its tier routes to. A review whose stage runs a lens on an unrouted tier stops with "no model
// is configured" before that lens runs, so doctor names every such tier before a review does.
async function routesCheck(cwd: string): Promise<Check | undefined> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	try {
		const { config } = await loadConfig(root, { kind: "worktree" }, ".");
		const routes = tiers
			.filter((tier) => config.models[tier] !== undefined)
			.map((tier) => `${tier} to ${config.models[tier]!.model}`);
		const unrouted = [...(await tiersInUse(root, config))].filter(([tier]) => config.models[tier] === undefined);
		if (unrouted.length === 0) return { name: "routes", state: "ok", detail: routes.join(", ") || "no lens runs" };
		const missing = unrouted
			.map(([tier, lenses]) => {
				const names =
					lenses.length < 3 ? lenses.join(" and ") : `${lenses.slice(0, -1).join(", ")}, and ${lenses.at(-1)}`;
				return `${tier}, for ${names}`;
			})
			.join("; ");
		const fix = "set models.<tier>.model in melian.local.yaml, or pass --model to review";
		return {
			name: "routes",
			state: "warn",
			detail: `${routes.length === 0 ? "no tier is routed to a model" : routes.join(", ")}; no model for ${missing}; ${fix}`,
		};
	} catch (error) {
		return { name: "routes", state: "warn", detail: error instanceof Error ? error.message : String(error) };
	}
}

// Where a lens's level is cheaper than the level below it. Each level takes what it leaves out from the top level, so a
// lens that extends another and sets a top-level tier or budget moves the levels that name none, and can leave
// `careful` on a lighter tier than `quick`, or allowing more than `deep`.
function inversions(lens: Lens): string[] {
	const declared = scrutinyLevels.flatMap((level) => {
		const settings = lens.levels[level];
		return settings === undefined ? [] : [{ level, ...settings }];
	});
	return declared.slice(1).flatMap((upper, index) => {
		const lower = declared[index]!;
		const tier =
			tiers.indexOf(upper.tier) < tiers.indexOf(lower.tier)
				? [`${upper.level} runs on ${upper.tier}, below ${lower.level}'s ${lower.tier}`]
				: [];
		const budgets = (["tokens", "tools"] as const).flatMap((budget) => {
			const mine = upper.budget[budget] ?? Number.POSITIVE_INFINITY;
			const below = lower.budget[budget] ?? Number.POSITIVE_INFINITY;
			if (mine >= below) return [];
			const unit = budget === "tokens" ? "tokens" : "tool calls";
			const theirs = below === Number.POSITIVE_INFINITY ? "no limit" : below.toLocaleString("en-AU");
			return [
				`${upper.level} allows ${mine.toLocaleString("en-AU")} ${unit}, fewer than ${lower.level}'s ${theirs}`,
			];
		});
		return [...tier, ...budgets];
	});
}

// Triage will choose a level by how hard a lens should look, so a higher level that costs less inverts its choice.
async function levelsCheck(cwd: string): Promise<Check | undefined> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	try {
		const inverted = (await loadLenses(root, { kind: "worktree" }, ["."])).flatMap((lens) => {
			const found = inversions(lens);
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
		...[
			await executableCheck(io.cwd, io.executable),
			await stateCheck(io.cwd, io.env),
			await routesCheck(io.cwd),
			await levelsCheck(io.cwd),
			await staticCheck(io.cwd),
		].filter((check) => check !== undefined),
	];
	const width = Math.max(...checks.map((check) => check.name.length));
	for (const check of checks) io.stdout(`${check.state.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}\n`);
	return checks.some((check) => check.state === "fail") ? 1 : 0;
}

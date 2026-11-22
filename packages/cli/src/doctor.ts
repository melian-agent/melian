import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import {
	checksOfTier,
	Lens,
	type LoadedSecrets,
	loadConfig,
	loadSecrets,
	melianPaths,
	resolutionOverrides,
	StandardsInventory,
	type StaticTool,
	standardsLimits,
	userFiles,
	visibleText,
} from "@melian-agent/core";
import { DecisionFiles, decisionIndexWarning } from "@melian-agent/decisions";
import { createGitHubProvider, parseGitHubRemote, resolveGitHubToken } from "@melian-agent/github";
import {
	createReviewModels,
	melianInstall,
	Probe,
	piAuthPath,
	providersWithCredentials,
	staticToolSource,
} from "@melian-agent/pipeline";
import { GitRecordStore, type Sweep, sweepBound } from "@melian-agent/state-git";
import type { Io } from "./commands.ts";
import { CloneEvidence } from "./evidence.ts";
import { decisionProviderRefusal, reviewModels } from "./models.ts";
import { fromCheckout, git, stateDirectory, stateDirectoryVariable } from "./repository.ts";
import { size } from "./store.ts";
import { ToolInventory } from "./tools.ts";

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
// The plan reads the preference files, and a pull request's review never does, so each one doctor read is named.
async function planChecks(cwd: string, env: NodeJS.ProcessEnv, secrets: LoadedSecrets): Promise<Check[]> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return [];
	try {
		const source = { kind: "worktree", preferences: userFiles(env).config } as const;
		const loaded = await loadConfig(root, source, ".");
		const checks = Object.values(loaded.config.stages).flatMap((stage) => checksOfTier(loaded.config, stage));
		const lenses = await Lens.load(root, source, ["."]);
		const { plan } = await reviewModels({}, loaded, lenses, { checks, credentials: secrets.credentials });
		const refusal = decisionProviderRefusal(loaded.config);
		return [
			{
				name: "routes",
				state: "ok",
				detail: visibleText(
					plan.tiers
						.map(
							({ tier, models, status }) =>
								`${tier}: ${models.map(({ model }) => model).join(", then ")} (${status})`,
						)
						.join("; "),
				),
			},
			...(refusal === undefined ? [] : [{ name: "decisions", state: "fail", detail: refusal } satisfies Check]),
			...plan.lines().map(({ state, text }): Check => ({ name: "plan", state, detail: text })),
			...loaded.preferences.flatMap(({ file, keys }): Check[] => {
				// Every review renders with `output` from the preference files, through `terminalEmoji` in commands.ts.
				const ignored = keys.filter((key) => key.split(".")[0] !== "output");
				return ignored.length === 0
					? []
					: [
							{
								name: "plan",
								state: "warn",
								detail: visibleText(
									`${file} sets ${ignored.join(", ")}, which a pull request's review ignores: it reads its policy and lenses from its base`,
								),
							},
						];
			}),
		];
	} catch (error) {
		return [{ name: "plan", state: "warn", detail: error instanceof Error ? error.message : String(error) }];
	}
}

// Triage will choose a level by how hard a lens should look, so a higher level that costs less inverts its choice.
async function levelsCheck(cwd: string, env: NodeJS.ProcessEnv): Promise<Check | undefined> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	try {
		const { config } = await loadConfig(root, { kind: "worktree", preferences: userFiles(env).config }, ".");
		const inverted = (await Lens.load(root, { kind: "worktree" }, ["."])).flatMap((lens) => {
			const routed = Object.hasOwn(config.lenses, lens.name) && config.lenses[lens.name]!.route !== undefined;
			const found = lens.inversions(routed);
			return found.length === 0 ? [] : [`${lens.name}: ${found.join("; ")}`];
		});
		return inverted.length === 0
			? { name: "levels", state: "ok", detail: "each lens's levels cost more from quick to deep" }
			: { name: "levels", state: "warn", detail: `${inverted.join("; ")}; set the level's own tier or budget` };
	} catch (error) {
		return { name: "levels", state: "warn", detail: error instanceof Error ? error.message : String(error) };
	}
}

// What each file's `resolution` now overrides: the accepted cost of letting the nearest file that speaks decide a
// finding whole, read from the working tree as a review of it would.
async function resolutionChecks(cwd: string, env: NodeJS.ProcessEnv): Promise<Check[]> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return [];
	const name = "resolution";
	try {
		const lines = await resolutionOverrides(root, { kind: "worktree", preferences: userFiles(env).config });
		if (lines.length === 0) {
			return [{ name, state: "ok", detail: "no file overrides a lens's default or a farther file's resolution" }];
		}
		return lines.map((line) => ({ name, state: "ok", detail: visibleText(line) }));
	} catch (error) {
		return [{ name, state: "warn", detail: visibleText(error instanceof Error ? error.message : String(error)) }];
	}
}

const staticTools: readonly StaticTool[] = ["biome", "tsc"];

async function toolChecks(cwd: string, env: NodeJS.ProcessEnv): Promise<Check[]> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return [];
	try {
		return (await (await ToolInventory.open(root, env)).readiness()).map((tool) => ({
			name: `tool ${tool.name}`,
			state: tool.state === "verified" ? "ok" : tool.state === "mismatch" ? "fail" : "warn",
			detail: `${tool.version}; ${tool.detail}`,
		}));
	} catch (error) {
		return [{ name: "tools", state: "fail", detail: error instanceof Error ? error.message : String(error) }];
	}
}

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

// A package Melian runs that a link takes out of its install, as `npm link` does, or a layout other than npm's, such as
// Yarn's Plug'n'Play, leaves the install unidentified: the review still runs, and reuses no run.
function packagesCheck(): Check {
	let install: ReturnType<typeof melianInstall>;
	try {
		install = melianInstall();
	} catch (error) {
		return { name: "packages", state: "fail", detail: visibleText((error as Error).message) };
	}
	const { outside, unrecognised } = install;
	const reasons = [
		...(outside.length === 0
			? []
			: [`${visibleText(outside.join(", "))} ${outside.length === 1 ? "links" : "link"} outside Melian's install`]),
		...(unrecognised.length === 0
			? []
			: [
					`${visibleText(unrecognised.join(", "))} ${unrecognised.length === 1 ? "is" : "are"} not laid out as npm lays out an install`,
				]),
	];
	return reasons.length === 0
		? { name: "packages", state: "ok", detail: "nothing in Melian's install links outside it" }
		: { name: "packages", state: "warn", detail: `${reasons.join("; ")}, so no review reuses a run` };
}

// Mutation testing runs only the checkout's own Stryker: Melian carries none, and without one the check records a skip
// that leaves the review not reviewed. It runs the head's own tests unconfined, so doctor says which heads it runs for
// on this host. Silent while the check is off.
async function mutationCheck(cwd: string, env: NodeJS.ProcessEnv): Promise<Check | undefined> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	try {
		const { config } = await loadConfig(root, { kind: "worktree", preferences: userFiles(env).config }, ".");
		if (!config.static.mutation.enabled) return undefined;
		const source = staticToolSource(root, "mutation");
		if (source.from !== "checkout") {
			return {
				name: "mutation",
				state: "warn",
				detail:
					"static.mutation is on, but Stryker is not installed in the checkout and Melian carries none; add @stryker-mutator/core and @stryker-mutator/vitest-runner to its dev dependencies, or the check records a skip",
			};
		}
		return {
			name: "mutation",
			state: "ok",
			detail:
				"static.mutation runs Stryker from the checkout for a pull request a writer pushed to the base repository, and for a range you pass --trust-head; any other head waits for the Actions host's credential-free job",
		};
	} catch (error) {
		return { name: "mutation", state: "warn", detail: error instanceof Error ? error.message : String(error) };
	}
}

async function standardsCheck(cwd: string): Promise<Check | undefined> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	try {
		const inventory = await StandardsInventory.inspect(root, { kind: "worktree" });
		const limit = `${standardsLimits.fileBytes / 1024} KiB`;
		const paths = inventory.entries
			.slice(0, 10)
			.map(
				(entry) =>
					`${visibleText(entry.path)}${"symlink" in entry ? " (symlink skipped)" : entry.oversized ? ` (over ${limit})` : ""}`,
			);
		const remaining = inventory.entries.slice(10);
		const remainingFiles = remaining.filter((entry) => "bytes" in entry).length;
		const remainingSymlinks = remaining.length - remainingFiles;
		if (remainingFiles > 0) paths.push(`and ${remainingFiles} more${remainingSymlinks === 0 ? "" : " files"}`);
		if (remainingSymlinks > 0)
			paths.push(`${remainingSymlinks} more skipped symlink${remainingSymlinks === 1 ? "" : "s"}`);
		const warnings = inventory.warnings();
		const oversized = warnings.filter((entry) => "bytes" in entry).length;
		const symlinks = warnings.length - oversized;
		return {
			name: "standards",
			state: warnings.length === 0 ? "ok" : "warn",
			detail: `${inventory.count()} file${inventory.count() === 1 ? "" : "s"}, ${inventory.bytes()} bytes${paths.length === 0 ? "" : `; ${paths.join(", ")}`}${oversized === 0 ? "" : `; ${oversized} over ${limit}`}${symlinks === 0 ? "" : `; ${symlinks} symlink${symlinks === 1 ? "" : "s"} skipped`}`,
		};
	} catch (error) {
		return {
			name: "standards",
			state: "warn",
			detail: visibleText(error instanceof Error ? error.message : String(error)),
		};
	}
}

// The index the design lens reads at a review's base; doctor has no changeset, so it reads HEAD. It never fails.
async function decisionIndexCheck(cwd: string): Promise<Check | undefined> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	const head = root && (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => undefined));
	if (!root || !head) return undefined;
	try {
		const index = await DecisionFiles.load(root, head);
		const count = index.files().length;
		if (count === 0) return undefined;
		const warning = index.warning();
		if (warning !== undefined) return { name: "decision index", state: "warn", detail: warning };
		const bytes = Buffer.byteLength(index.render(), "utf8");
		return {
			name: "decision index",
			state: "ok",
			detail: `${bytes} bytes for ${count} decision${count === 1 ? "" : "s"} at HEAD, under ${decisionIndexWarning.bytes / 1024} KiB`,
		};
	} catch (error) {
		return {
			name: "decision index",
			state: "warn",
			detail: visibleText(error instanceof Error ? error.message : String(error)),
		};
	}
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

// Which Melian reviewed a change: the clone the executable links to, its commit, and whether its tree holds edits no commit
// names. An install from the registry sits under node_modules and has no clone.
async function cloneCheck(executable: string | undefined): Promise<Check | undefined> {
	if (executable === undefined) return undefined;
	const real = realpathSync(executable);
	if (real.split(sep).includes("node_modules")) return undefined;
	const root = await git(dirname(real), ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	const commit = await git(root, ["rev-parse", "--short=12", "HEAD"]).catch(() => undefined);
	if (commit === undefined) return { name: "clone", state: "warn", detail: `${root}, with no commit` };
	const status = await git(root, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]).catch(
		() => undefined,
	);
	if (status === undefined)
		return { name: "clone", state: "warn", detail: `${root} at ${commit}; git could not read its tree` };
	return status === ""
		? { name: "clone", state: "ok", detail: `${root} at ${commit}, tree clean` }
		: {
				name: "clone",
				state: "warn",
				detail: `${root} at ${commit}, tree dirty: this Melian runs edits no commit holds`,
			};
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

async function evidenceCheck(io: Io): Promise<Check | undefined> {
	const root = await git(io.cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	let store: CloneEvidence["store"];
	let held: number;
	try {
		({ store } = await CloneEvidence.open(io, root));
		held = await store.size();
	} catch (error) {
		return { name: "evidence", state: "warn", detail: `unreadable: ${visibleText((error as Error).message)}` };
	}
	const detail = `${visibleText(store.directory)}, ${size(held)} of its budget of ${size(store.budget)}`;
	return held < store.budget
		? { name: "evidence", state: "ok", detail }
		: {
				name: "evidence",
				state: "warn",
				detail: `${detail}; a valid miss keeps no more evidence until evidence.budget is raised in your configuration, since melian store prune keeps evidence until issue #633 lands`,
			};
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

async function trustCheck(
	cwd: string,
	token: string | undefined,
	fetch: typeof globalThis.fetch | undefined,
): Promise<Check> {
	const name = "trust";
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined)
		return { name, state: "warn", detail: "not inside a git repository; root policy is unknown" };
	const policy = await committedTrust(root);
	if ("unknown" in policy) return { name, state: "warn", detail: policy.unknown };
	const { base, writers, caveat } = policy;
	let state: Check["state"] = writers && caveat === undefined ? "ok" : "warn";
	const details = [`writers trusted: ${writers ? "yes" : "no"}; policy ${base.ref} (${base.commit.slice(0, 7)})`];
	if (!writers) details.push("a trusted host must set the status");
	if (caveat !== undefined) details.push(caveat);
	if (token === undefined) return { name, state: "warn", detail: `${details.join("; ")}; no GitHub token` };
	const url = await git(root, ["remote", "get-url", "origin"]).catch(() => undefined);
	let repository: { owner: string; repo: string };
	try {
		if (url === undefined) throw new Error("no origin");
		repository = parseGitHubRemote(url);
	} catch {
		return { name, state: "warn", detail: `${details.join("; ")}; no GitHub origin; viewer permission is unknown` };
	}
	const controller = new AbortController();
	const transport = fetch ?? globalThis.fetch;
	const provider = createGitHubProvider({
		...repository,
		token,
		fetch: (input, init) =>
			transport(input, {
				...init,
				signal: init?.signal == null ? controller.signal : AbortSignal.any([init.signal, controller.signal]),
			}),
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("GitHub read timed out"));
		}, 10_000);
	});
	try {
		const { login, permission } = await Promise.race([
			(async () => {
				const login = await provider.login();
				const permission = login === undefined ? undefined : await provider.permission(login);
				return { login, permission };
			})(),
			deadline,
		]);
		details.push(`viewer ${visibleText(login ?? "unknown")} (${permission ?? "unknown"})`);
		if (permission === undefined) {
			state = "warn";
			details.push("cannot establish whether melian publish can set a status here");
		} else if (!["admin", "maintain", "write"].includes(permission)) {
			state = "warn";
			details.push("melian publish cannot set a status here");
		}
		return { name, state, detail: details.join("; ") };
	} catch {
		return {
			name,
			state: "warn",
			detail: `${details.join("; ")}; GitHub read timed out after 10 seconds; viewer permission is unknown`,
		};
	} finally {
		clearTimeout(timer);
	}
}

// The committed root policy's `trust.writers`, from the first base ref that resolves. Doctor never fetches the refs.
// Local main may lag the remote, and HEAD is the branch's own policy, so either carries a caveat.
async function committedTrust(
	root: string,
): Promise<{ base: { ref: string; commit: string }; writers: boolean; caveat?: string } | { unknown: string }> {
	let base: { ref: string; commit: string } | undefined;
	for (const ref of ["origin/HEAD", "origin/main", "main", "HEAD"]) {
		const commit = await git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).catch(() => undefined);
		if (commit !== undefined) {
			base = { ref, commit };
			break;
		}
	}
	if (base === undefined) return { unknown: "no committed root policy is available" };
	try {
		return {
			base,
			writers: (await loadConfig(root, { kind: "revision", commit: base.commit }, ".")).config.trust.writers,
			...(base.ref === "HEAD" && { caveat: "base policy is unknown; using committed HEAD" }),
			...(base.ref === "main" && { caveat: "base policy may be stale; using local main" }),
		};
	} catch (error) {
		return { unknown: visibleText(error instanceof Error ? error.message : String(error)) };
	}
}

// Whoever can push to the record branch can add, rewind or remove what a review and the merge gate read, so the line
// says whom the committed policy trusts to write it. Doctor cannot read who may push, so trust off is a warning.
async function recordTrust(root: string): Promise<{ state: Check["state"]; detail: string }> {
	const policy = await committedTrust(root);
	if ("unknown" in policy)
		return {
			state: "warn",
			detail: `who may write it is unknown, since the trust policy cannot be read: ${policy.unknown}`,
		};
	const source = `trust.writers in ${policy.base.ref} (${policy.base.commit.slice(0, 7)})`;
	const detail = policy.writers
		? `its writers are trusted as the repository's writers, by ${source}`
		: `${source} is off, so only the trusted host may write melian/state; doctor cannot check who may push to it`;
	return policy.caveat === undefined
		? { state: policy.writers ? "ok" : "warn", detail }
		: { state: "warn", detail: `${detail}; ${policy.caveat}` };
}

// A file on the record branch that Melian did not write refuses calls until a writer removes it, so the line names it.
async function recordStoreCheck(cwd: string, env: NodeJS.ProcessEnv): Promise<Check | undefined> {
	const name = "records";
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (root === undefined) return undefined;
	const remote = await git(root, ["remote", "get-url", "origin"]).catch(() => undefined);
	if (remote === undefined) return undefined;
	const trust = await recordTrust(root);
	const branch = await branchContents(root, remote, env);
	return {
		name,
		state: branch.state === "ok" ? trust.state : "warn",
		detail: `${branch.detail}; ${trust.detail}`,
	};
}

async function branchContents(
	root: string,
	remote: string,
	env: NodeJS.ProcessEnv,
): Promise<{ state: Check["state"]; detail: string }> {
	let store: GitRecordStore | undefined;
	try {
		store = await GitRecordStore.open({
			directory: await stateDirectory(root, env),
			remote: fromCheckout(root, remote),
			deadlineMs: 20_000,
		});
		const strays = await store.strays();
		const notes = [
			strays.length === 0
				? "melian/state holds only records and cells Melian wrote, or is not there yet"
				: `melian/state holds ${strays.length === 1 ? "a file" : `${strays.length} files`} Melian did not write, which a writer must remove: ${listed(strays)}`,
			...sweepNotes(store.sweep),
		];
		return { state: strays.length === 0 && notes.length === 1 ? "ok" : "warn", detail: notes.join("; ") };
	} catch (error) {
		// The sweep ran when the store opened, so what it left still needs naming when the branch cannot be read.
		const failure = visibleText(error instanceof Error ? error.message : String(error));
		return { state: "warn", detail: [failure, ...(store === undefined ? [] : sweepNotes(store.sweep))].join("; ") };
	} finally {
		await store?.close();
	}
}

// Five names as visible text, and a count of the rest.
function listed(names: readonly string[]): string {
	const shown = names.slice(0, 5).map((name) => visibleText(name));
	return `${shown.join(", ")}${names.length > shown.length ? `, and ${names.length - shown.length} more` : ""}`;
}

// What opening the store swept is silent when it removed all it found; anything it left a person may need to remove.
function sweepNotes(sweep: Sweep): string[] {
	const notes: string[] = [];
	if (sweep.unread !== undefined)
		notes.push(
			`the state directory was not swept, since the process table cannot be read: ${visibleText(sweep.unread)}`,
		);
	if (sweep.kept.length > 0)
		notes.push(
			`the state directory keeps ${sweep.kept.length === 1 ? "a leftover" : `${sweep.kept.length} leftovers`} whose maker Melian cannot tell is gone, which a person may remove once no Melian uses the directory: ${listed(sweep.kept)}`,
		);
	if (sweep.failed.length > 0)
		notes.push(
			`the state directory holds ${sweep.failed.length === 1 ? "a leftover" : `${sweep.failed.length} leftovers`} of an exited call that Melian could not remove: ${listed(sweep.failed)}`,
		);
	if (sweep.unlisted === true)
		notes.push(
			sweep.unswept === undefined
				? "the state directory was not swept, since the sweep could not list its leftovers, which the next open retries"
				: `the state directory holds ${sweep.unswept === 1 ? "a leftover of an exited call" : `${sweep.unswept} leftovers of exited calls`} that the sweep left, since it could not list them all, which the next open removes`,
		);
	else if (sweep.unswept !== undefined)
		notes.push(
			`the state directory holds ${sweep.unswept === 1 ? "a leftover of an exited call" : `${sweep.unswept} leftovers of exited calls`} that the sweep ran out of time to remove, which the next open removes`,
		);
	if (sweep.bounded === true)
		notes.push(
			`the sweep stopped listing at its bound of ${sweepBound} leftovers, so the state directory may hold more, which a later open lists once fewer are left`,
		);
	return notes;
}

// Runs an empty probe, so the line says whether one runs here, not only whether the parts are installed.
async function probeCheck(): Promise<Check> {
	const availability = await Probe.availability();
	return availability.available
		? { name: "probes", state: "ok", detail: "run under sandbox-runtime" }
		: {
				name: "probes",
				state: "warn",
				detail: `cannot run here, so every probe is refused: ${visibleText(availability.reason)}`,
			};
}

// Names credentials by provider and source, never by value.
export async function doctor(io: Io, options: { readonly fetch?: typeof globalThis.fetch } = {}): Promise<number> {
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
		await trustCheck(io.cwd, token?.token, options.fetch),
		...(await toolChecks(io.cwd, io.env)),
		...[
			await executableCheck(io.cwd, io.executable),
			await cloneCheck(io.executable),
			await stateCheck(io.cwd, io.env),
			await evidenceCheck(io),
			await recordStoreCheck(io.cwd, io.env),
			await levelsCheck(io.cwd, io.env),
			await staticCheck(io.cwd),
			packagesCheck(),
			await mutationCheck(io.cwd, io.env),
			await probeCheck(),
			await standardsCheck(io.cwd),
			await decisionIndexCheck(io.cwd),
		].filter((check) => check !== undefined),
		...(await resolutionChecks(io.cwd, io.env)),
		...(await planChecks(io.cwd, io.env, secrets)),
	];
	const width = Math.max(...checks.map((check) => check.name.length));
	for (const check of checks) io.stdout(`${check.state.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}\n`);
	return checks.some((check) => check.state === "fail") ? 1 : 0;
}

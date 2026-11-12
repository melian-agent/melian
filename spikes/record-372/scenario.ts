// The changeset, policy, lenses and fake model every run of the spike shares. Scripts, not product code.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Changeset, Lens, loadConfig, type MelianConfig, type RepositorySource } from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createNodeExecutionEnv,
	createReviewRegistry,
	type defineExtension,
	type Harness,
	type Message,
	openHarness,
	openSqliteStorage,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	type ScriptedReply,
	scriptConversations,
} from "@melian-agent/pipeline/testing";

export const scratch = "/tmp/claude-0/-home-user-melian/49d5dd77-41ed-5de6-b60b-6b3531f2559a/scratchpad/spike-372";

const gitEnv = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_COUNT: "0",
	GIT_AUTHOR_NAME: "Spike",
	GIT_AUTHOR_EMAIL: "spike@melian.invalid",
	GIT_COMMITTER_NAME: "Spike",
	GIT_COMMITTER_EMAIL: "spike@melian.invalid",
};
Object.assign(process.env, gitEnv);
delete process.env.MELIAN_STATE_DIR;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function write(root: string, files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

const lines = (...content: string[]) => `${content.join("\n")}\n`;
const user = (body: string) =>
	lines(
		"export interface User {",
		"\tname: string;",
		"\tmanager?: User;",
		"}",
		"",
		"export function managerName(user: User): string {",
		body,
		"}",
	);

// Every check and lens the full tier names, and one tier per check so a run can stop between checks under the same
// policy: the check policy hash covers the whole configuration, tiers included.
export const checkNames = ["guardrails", "static.tsc", "static.biome"] as const;
export const lensNames = ["correctness", "contracts", "conventions"] as const;
const policy = lines(
	"tiers:",
	`  full: [${[...checkNames, ...lensNames.map((name) => `lens.${name}`)].join(", ")}]`,
	...checkNames.map((name) => `  only.${name}: [${name}]`),
	"guardrails:",
	"  forbidden-patterns:",
	"    rules:",
	"      todo:",
	"        pattern: TODO",
	"        message: finish it",
);

// A repository whose `feature` drops the guard on a manager, so line 7 dereferences a value that may be undefined,
// and adds a TODO for the guardrail. tsc and Biome run from the workspace's own installs.
export function repository(): string {
	mkdirSync(scratch, { recursive: true });
	const repo = realpathSync(mkdtempSync(join(scratch, "repo-")));
	git(repo, "init", "--quiet", "--initial-branch=main");
	const tsconfig = JSON.stringify({
		compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext" },
	});
	write(repo, {
		"melian.yaml": policy,
		"tsconfig.json": tsconfig,
		"src/user.ts": user('\treturn user.manager?.name ?? "none";'),
	});
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "-m", "base");
	git(repo, "checkout", "--quiet", "-b", "feature");
	write(repo, { "src/user.ts": user("\t// TODO: guard again\n\treturn user.manager.name;") });
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "-m", "head");
	// Untracked, so the static runner takes the checkout's tsc and Biome, as a repository with its own install would.
	const workspace = fileURLToPath(new URL("../../node_modules", import.meta.url));
	symlinkSync(workspace, join(repo, "node_modules"));
	return repo;
}

export const crashFinding = {
	file: "src/user.ts",
	line: 8,
	rule: "null-dereference",
	severity: "P1",
	explanation: {
		what: "managerName reads name from a manager that may be undefined.",
		why: "This change dropped the optional chain, so a user without a manager throws.",
		fix: "Restore user.manager?.name with a fallback.",
	},
	failureScenario: 'managerName({ name: "Ada" }) throws a TypeError reading name of undefined.',
	evidence: [{ file: "src/user.ts", line: 8, role: "cause" }],
};

export const contractsFinding = {
	file: "src/user.ts",
	line: 6,
	rule: "changed-error",
	severity: "P2",
	explanation: {
		what: "managerName now throws for a user without a manager instead of returning none.",
		why: "Callers relied on the none fallback.",
		fix: "Keep the documented fallback.",
	},
	failureScenario: 'A caller passing { name: "Ada" } used to get "none" and now gets a TypeError.',
	evidence: [{ file: "src/user.ts", line: 8, role: "cause" }],
};

export type Setup = {
	readonly repo: string;
	readonly changeset: Changeset;
	readonly config: MelianConfig;
	readonly source: RepositorySource;
	readonly lenses: Lens[];
};

export async function setup(repo: string): Promise<Setup> {
	const changeset = await Changeset.resolve(repo, "main...feature");
	const source: RepositorySource = { kind: "revision", commit: changeset.revision.base };
	const { config } = await loadConfig(repo, source, "");
	const lenses = await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"]);
	return { repo, changeset, config, source, lenses };
}

// One fake provider per store, so each run's request log is its own. `park` names lenses whose first request never
// settles, which stands in for a process that stopped mid-review.
export function fakeModels(lenses: readonly Lens[], park: readonly string[] = []) {
	const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "medium" }, { id: "heavy" }] });
	const report = (finding: Record<string, unknown>) =>
		fauxAssistantMessage(fauxToolCall("report_finding", finding as Parameters<typeof fauxToolCall>[1]), {
			stopReason: "toolUse",
		});
	const done = fauxAssistantMessage("Done.");
	const hold: ScriptedReply = () => new Promise<never>(() => setInterval(() => {}, 60_000));
	const scripts: Record<string, ScriptedReply[]> = {
		correctness: [report(crashFinding), done],
		contracts: [report(contractsFinding), done],
		conventions: [done],
	};
	const requests = scriptConversations(
		fake,
		lenses
			.filter((lens) => Object.hasOwn(scripts, lens.name))
			.map((lens) => ({
				match: lens.instructions,
				replies: park.includes(lens.name) ? [hold] : scripts[lens.name]!,
			}))
			.sort((a, b) => b.match.length - a.match.length),
	);
	return { fake, requests };
}

export function config(setup: Setup, fake: FakeModels): MelianConfig {
	const heavy = fake.ref("heavy");
	const medium = fake.ref("medium");
	return {
		...setup.config,
		models: {
			...setup.config.models,
			medium: { model: `${medium.provider}/${medium.modelId}` },
			heavy: { model: `${heavy.provider}/${heavy.modelId}` },
		},
	};
}

export async function open(
	repo: string,
	path: string,
	fake: FakeModels,
	lensExtension?: ReturnType<typeof defineExtension>,
): Promise<Harness> {
	const registry = createReviewRegistry();
	if (lensExtension !== undefined) registry.install(lensExtension);
	registry.install(checksExtension);
	const harness = await openHarness(await openSqliteStorage(path), {
		models: fake.models,
		registry,
		env: () => createNodeExecutionEnv(repo),
		settings: { retry: { enabled: false } },
	});
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	return harness;
}

export function lensRequests(requests: Record<string, Message[][]>, lenses: readonly Lens[]) {
	return Object.fromEntries(
		Object.entries(requests).map(([match, seen]) => [
			lenses.find((lens) => lens.instructions === match)?.name ?? "verifier",
			seen.length,
		]),
	);
}

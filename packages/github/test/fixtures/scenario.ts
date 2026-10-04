// A pull request in two revisions, reviewed on the fake model, for publication tests.
//
// Revision 1 makes managerName unsafe on line 7. The scripted lens reports three findings: one on line 7 (in the diff),
// one on line 19 of the same file (outside the diff), and one in src/config.ts, which the change does not touch.
// Revision 2 restores line 7 and changes line 11, where the lens reports a new finding; line 19 is still reported.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type Changeset,
	type CheckRecord,
	diffLines,
	Lens,
	loadConfig,
	type MelianConfig,
	type RepositorySource,
	type ReviewProvider,
	resolveRange,
} from "@melian-agent/core";
import {
	createReviewRegistry,
	type Harness,
	openHarness,
	publishExtension,
	type ReviewOrigin,
	reviewChangeset,
	type Storage,
} from "@melian-agent/pipeline";
import { createFakeModels, type FakeModels, type LensScript, scriptLenses } from "@melian-agent/pipeline/testing";
import { type FakeState, fakeState } from "./fake-github.ts";

export const isolatedGitEnv = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Melian Test",
	GIT_AUTHOR_EMAIL: "test@melian.invalid",
	GIT_COMMITTER_NAME: "Melian Test",
	GIT_COMMITTER_EMAIL: "test@melian.invalid",
};

export function gitIn(root: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: root, env: { ...process.env, ...isolatedGitEnv }, encoding: "utf8" }).trim();
}

function writeFiles(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

const lines = (...content: string[]) => `${content.join("\n")}\n`;

const user = (line7: string, line11: string) =>
	lines(
		"export interface User {",
		"\tname: string;",
		"\tmanager?: User;",
		"}",
		"",
		"export function managerName(user: User): string {",
		line7,
		"}",
		"",
		"export function greet(user: User): string {",
		line11,
		"}",
		"",
		"export function shout(user: User): string {",
		"\treturn greet(user).toUpperCase();",
		"}",
		"",
		"export function initials(user: User): string {",
		'\treturn user.name.split(" ").map((part) => part[0]).join("");',
		"}",
	);

const safe = '\treturn user.manager?.name ?? "none";';
const greeting = '\treturn "Hello, " + user.name;';

// A repository whose `feature` branch holds revision 1 of the pull request. The caller deletes it.
export function scenarioRepository(): string {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-publish-")));
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, {
		"src/user.ts": user(safe, greeting),
		"src/config.ts": lines("export const retries = Number(process.env.RETRIES);", "export const timeout = 30;"),
	});
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", "base");
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	writeFiles(repo, { "src/user.ts": user("\treturn (user.manager as User).name;", greeting) });
	gitIn(repo, "commit", "--quiet", "--all", "-m", "revision 1");
	return repo;
}

// Pushes revision 2 onto `feature`.
export function pushRevisionTwo(repo: string): void {
	writeFiles(repo, { "src/user.ts": user(safe, '\treturn "Hi, " + user.name.trim();') });
	gitIn(repo, "commit", "--quiet", "--all", "-m", "revision 2");
}

// Pushes revision 3 onto `feature`, which puts the greeting back as it was at the base.
export function pushRevisionThree(repo: string): void {
	writeFiles(repo, { "src/user.ts": user(safe, '\treturn "Hi, " + user.name;') });
	gitIn(repo, "commit", "--quiet", "--all", "-m", "revision 3");
}

// Stacks `feature` on a `parent` branch: `parent` changes src/config.ts on top of `main`, and `feature` merges it, so
// `main...feature` holds both changes and `parent...feature` only revision 1, as after a retarget onto the parent.
export function stackOnParent(repo: string): void {
	gitIn(repo, "branch", "parent", "main");
	gitIn(repo, "checkout", "--quiet", "parent");
	writeFiles(repo, {
		"src/config.ts": lines("export const retries = Number(process.env.RETRIES);", "export const timeout = 60;"),
	});
	gitIn(repo, "commit", "--quiet", "--all", "-m", "parent");
	gitIn(repo, "checkout", "--quiet", "feature");
	gitIn(repo, "merge", "--quiet", "--no-edit", "parent");
}

// Rebuilds `feature` on a `parent` branch that edits the line above managerName's body, so revision 1's hunk is line 7
// alone against `parent` and lines 6 and 7 against `main`: a retarget onto `main` keeps the head and changes the trigger.
export function stackOnEditedParent(repo: string): void {
	const signature = "export function managerName(user: User): string {";
	const edited = (body: string) => user(body, greeting).replace(signature, `${signature} // the manager's name`);
	gitIn(repo, "checkout", "--quiet", "-b", "parent", "main");
	writeFiles(repo, { "src/user.ts": edited(safe) });
	gitIn(repo, "commit", "--quiet", "--all", "-m", "parent");
	gitIn(repo, "checkout", "--quiet", "-B", "feature", "parent");
	writeFiles(repo, { "src/user.ts": edited("\treturn (user.manager as User).name;") });
	gitIn(repo, "commit", "--quiet", "--all", "-m", "revision 1 on parent");
}

const explanation = (what: string) => ({ what, why: `${what} Why.`, fix: `${what} Fix.` });

// Each finding blames its own line, so only a location inside the diff makes it more than pre-existing.
function report(file: string, line: number, rule: string, severity: string, what: string) {
	const evidence = [{ file, line, role: "cause" }];
	const failureScenario = `${what} Scenario.`;
	return {
		name: "report_finding",
		arguments: { file, line, rule, severity, explanation: explanation(what), failureScenario, evidence },
	};
}

// On line 7 at revision 1: introduced, P1, so it blocks.
export const unsafeManager = report("src/user.ts", 7, "null-dereference", "P1", "manager may be absent.");
// On line 19, outside both revisions' diffs: pre-existing, so advisory.
export const emptyName = report("src/user.ts", 19, "wrong-result", "P2", "An empty name yields no initials.");
// In src/config.ts, which the change does not touch: pre-existing, so advisory.
export const nanRetries = report("src/config.ts", 1, "unhandled-error", "P1", "RETRIES may be unset.");
// On line 11 at revision 2: introduced, P2, so it needs acknowledging.
export const trimmedGreeting = report("src/user.ts", 11, "wrong-result", "P2", "trim() changes the greeting.");

export function lensScript(...findings: ReturnType<typeof report>[]): LensScript {
	return {
		correctness: [{ calls: findings }, { text: `Reported ${findings.length} findings.` }],
		contracts: [{ text: "Reported 0 findings." }],
	};
}

// Fake models for reviews: one model every tier routes to.
export function scenarioModels(): FakeModels {
	return createFakeModels({ models: [{ id: "scripted" }] });
}

// Opens a harness that reviews and publishes through `provider`.
export function openPublishHarness(storage: Storage, fake: FakeModels, provider: ReviewProvider): Promise<Harness> {
	const registry = createReviewRegistry();
	registry.install(publishExtension(provider));
	return openHarness(storage, { models: fake.models, registry, settings: { retry: { enabled: false } } });
}

/** How {@link reviewScenario} reviews: by default `main...feature` as pull request #7, under the base's policy. */
export interface ScenarioReview {
	readonly range?: string;
	readonly origin?: "range";
	readonly policy?: "worktree";
	/** The records of the checks that run without a model; all `ran` by default. */
	readonly checks?: CheckRecord[];
}

// Opens a harness that only reviews, as the CLI's review does, so a publish task a crash left stays put.
export function openReviewOnlyHarness(storage: Storage, fake: FakeModels): Promise<Harness> {
	return openHarness(storage, {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
}

// Reviews the scenario, the lenses answering from `script`; `rerun` runs again a lens that failed at this head. Returns
// the changeset.
export async function reviewScenario(
	repo: string,
	harness: Harness,
	fake: FakeModels,
	script: LensScript,
	rerun = false,
	how: ScenarioReview = {},
) {
	const changeset: Changeset = await resolveRange(repo, how.range ?? "main...feature");
	const source: RepositorySource =
		how.policy === "worktree" ? { kind: "worktree" } : { kind: "revision", commit: changeset.revision.base };
	const origin: ReviewOrigin =
		how.origin === "range"
			? { kind: "range" }
			: {
					kind: "pull-request",
					repository: { owner: "melian-agent", name: "example" },
					pullRequest: 7,
					base: changeset.revision.base,
					head: changeset.revision.head,
				};
	const lenses = await Lens.load(
		repo,
		source,
		changeset.revision.files.map((file) => file.path),
	);
	scriptLenses(fake, lenses, script);
	const { config: loaded } = await loadConfig(repo, source, ".");
	const ref = fake.ref("scripted");
	const route = { model: `${ref.provider}/${ref.modelId}` };
	// The scenarios script correctness and contracts; the default full tier's other lenses have goldens of their own.
	const tiers = { ...loaded.tiers, full: ["standard", "lens.contracts"] };
	const config: MelianConfig = { ...loaded, tiers, models: { light: route, medium: route, heavy: route } };
	const review = reviewChangeset({
		harness,
		changeset,
		config,
		lenses,
		standards: [],
		models: fake.review,
		policy: source,
		rerun,
		origin,
		// The default tiers' checks that run without a model, recorded as ran, as runChecks records them.
		checks: how.checks ?? [
			{ name: "guardrails", status: "ran" },
			{ name: "static.biome", status: "ran" },
			{ name: "static.tsc", status: "ran" },
		],
	});
	return { changeset, review };
}

// The fake GitHub's state for pull request #7, before any revision; moveTo sets one.
export function pullRequestState(): FakeState {
	return fakeState(
		"melian-agent",
		"example",
		{ number: 7, title: "Trim names", base: { ref: "main", sha: "" }, head: { ref: "feature", sha: "" } },
		{},
	);
}

// Moves the fake pull request to the changeset's revision.
export function moveTo(state: FakeState, changeset: Changeset): void {
	state.pull.base.sha = changeset.revision.base;
	state.pull.head.sha = changeset.revision.head;
	state.lines = diffLines(changeset.revision.files);
}

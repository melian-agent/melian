import { existsSync } from "node:fs";
import {
	type Changeset,
	createFindingsLog,
	loadConfig,
	loadLenses,
	loadStandards,
	type RepositorySource,
	renderFindingsJson,
	renderFindingsTerminal,
	renderVerdictJson,
	resolveRange,
	type Verdict,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createReviewRegistry,
	type Harness,
	type HarnessOptions,
	openHarness,
	openSqliteStorage,
	publishExtension,
	publishReview,
	ReviewError,
	readVerdict,
	reviewChangeset,
} from "@melian-agent/pipeline";
import { idleModels, isScripted, reviewModels, scriptVariable } from "./models.ts";
import { CliError, git, storagePath } from "./repository.ts";
import { fetchedPullRequest, gitHubFor, parseTarget, pullRequestChangeset } from "./target.ts";

/** Where a command reads and writes: its working directory, environment, and output. */
export interface Io {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	/** Whether standard output takes colour: a terminal, with `NO_COLOR` unset. */
	readonly color: boolean;
}

/**
 * `melian review`'s exit codes: `0` passed, `1` findings with one blocking, `2` not reviewed, `3` findings with none
 * blocking. A review that could not start at all also exits `2`, since nothing was reviewed.
 */
export const reviewExitCodes = { passed: 0, blocking: 1, notReviewed: 2, findings: 3 } as const;

/** The exit code `melian review` ends with for `verdict`. */
export function exitCodeFor(verdict: Verdict): number {
	if (verdict.status === "not-reviewed") return reviewExitCodes.notReviewed;
	if (verdict.blocking) return reviewExitCodes.blocking;
	return verdict.status === "passed" ? reviewExitCodes.passed : reviewExitCodes.findings;
}

async function openStorageHarness(
	path: string,
	options: Omit<HarnessOptions, "registry"> & { readonly registry?: HarnessOptions["registry"] },
): Promise<Harness> {
	return openHarness(await openSqliteStorage(path), { registry: createReviewRegistry(), ...options });
}

async function headCommit(cwd: string): Promise<string | undefined> {
	return git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => undefined);
}

/**
 * `melian review <range|#pr>`: reviews a range of the checkout, or a pull request fetched from GitHub, prints the
 * verdict, and returns its exit code. A pull request's policy, standards, and lenses come from its base commit; a
 * range whose head is the checked-out commit reads them from the working tree, since its author is the one running
 * Melian; any other range reads them from its base.
 */
export async function review(io: Io, argument: string, options: { readonly model?: string }): Promise<number> {
	const target = parseTarget(argument);
	let changeset: Changeset;
	let source: RepositorySource;
	const registry = createReviewRegistry();
	if (target.kind === "pullRequest") {
		const provider = await gitHubFor(io.cwd, io.env);
		const fetched = await fetchedPullRequest(io.cwd, provider, target.number);
		changeset = fetched.changeset;
		source = { kind: "revision", commit: fetched.pullRequest.base.sha };
		registry.install(publishExtension(provider));
	} else {
		changeset = await resolveRange(io.cwd, target.spec);
		const own = (await headCommit(changeset.repoRoot)) === changeset.revision.head;
		source = own ? { kind: "worktree" } : { kind: "revision", commit: changeset.revision.base };
	}
	const { repoRoot } = changeset;
	const paths = changeset.revision.files.map((file) => file.path);
	const lenses = await loadLenses(repoRoot, source, paths);
	const standards = await loadStandards(repoRoot, source, ".");
	const { config: loaded } = await loadConfig(repoRoot, source, ".");
	const { models, config, settings } = await reviewModels(io.env, loaded, lenses, options.model);
	const path = await storagePath(repoRoot, changeset.id, isScripted(io.env));
	const harness = await openStorageHarness(path, {
		models,
		registry,
		...(settings === undefined ? {} : { settings }),
	});
	try {
		let verdict: Verdict;
		try {
			({ verdict } = await reviewChangeset({
				harness,
				changeset,
				config,
				lenses,
				standards,
				models,
				policy: source,
			}));
		} catch (error) {
			if (!(error instanceof ReviewError) || error.verdict === undefined) throw error;
			io.stderr(`melian: ${error.message}\n`);
			verdict = error.verdict;
		}
		io.stdout(renderFindingsTerminal(verdict, { color: io.color }));
		return exitCodeFor(verdict);
	} finally {
		await harness.close(context);
	}
}

function short(commit: string): string {
	return commit.slice(0, 12);
}

/**
 * `melian publish <#pr>`: posts the verdict stored for the pull request's current head. Refuses a range, since a review
 * of a working tree or a local branch is never posted, and a pull request whose head moved since its review.
 */
export async function publish(io: Io, argument: string): Promise<number> {
	const target = parseTarget(argument);
	if (target.kind !== "pullRequest") {
		throw new CliError(`publish takes a pull request, such as '#12'; Melian never posts a review of a range`);
	}
	if (isScripted(io.env)) throw new CliError(`publish refuses to run under ${scriptVariable}`);
	const provider = await gitHubFor(io.cwd, io.env);
	const pullRequest = await provider.pullRequest(target.number);
	const changeset = await pullRequestChangeset(io.cwd, target.number);
	const path = await storagePath(changeset.repoRoot, changeset.id, false);
	const registry = createReviewRegistry();
	registry.install(publishExtension(provider));
	const harness = await openStorageHarness(path, { models: idleModels(io.env), registry });
	try {
		const published = await publishReview({ harness, provider, changeset, pullRequest });
		const parts = [
			`${published.posted} new ${published.posted === 1 ? "finding" : "findings"}`,
			...(published.stillOpen > 0 ? [`${published.stillOpen} still open`] : []),
			...(published.resolved > 0 ? [`${published.resolved} resolved`] : []),
		];
		io.stdout(
			`Published review ${published.review} of ${short(pullRequest.head.sha)} to ${pullRequest.url}: ${parts.join(", ")}.\n`,
		);
		io.stdout(`Status ${published.status.state}: ${published.status.description}\n`);
		return 0;
	} finally {
		await harness.close(context);
	}
}

/**
 * `melian findings <range|#pr>`: prints the verdict stored for the changeset's head, without reviewing or touching the
 * network. `open` limits it to findings that still need attention; `json` prints JSON instead of text.
 */
export async function findings(
	io: Io,
	argument: string,
	options: { readonly open: boolean; readonly json: boolean },
): Promise<number> {
	const target = parseTarget(argument);
	const changeset =
		target.kind === "pullRequest"
			? await pullRequestChangeset(io.cwd, target.number)
			: await resolveRange(io.cwd, target.spec);
	const path = await storagePath(changeset.repoRoot, changeset.id, isScripted(io.env));
	const missing = new CliError(
		`Melian has no review of ${short(changeset.revision.head)}; run melian review ${argument}`,
	);
	if (!existsSync(path)) throw missing;
	const harness = await openStorageHarness(path, { models: idleModels(io.env) });
	try {
		const root = (await harness.root(context)).id;
		const verdict = await readVerdict(harness, root, changeset.revision.head, context);
		if (verdict === undefined) throw missing;
		if (!options.open) {
			io.stdout(options.json ? renderVerdictJson(verdict) : renderFindingsTerminal(verdict, { color: io.color }));
			return 0;
		}
		const open = createFindingsLog([
			...verdict.findings.block,
			...verdict.findings.acknowledge,
			...verdict.findings.advisory,
		]);
		io.stdout(options.json ? renderFindingsJson(open) : renderFindingsTerminal(open, { color: io.color }));
		return 0;
	} finally {
		await harness.close(context);
	}
}

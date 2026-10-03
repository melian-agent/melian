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
	openPublishHarness,
	openReviewHarness,
	openSqliteStorage,
	publishReview,
	ReviewError,
	type ReviewOrigin,
	readVerdict,
	reviewChangeset,
	revisionKey,
	runChecks,
} from "@melian-agent/pipeline";
import { idleModels, isScripted, reviewModels, scriptVariable } from "./models.ts";
import { CliError, git, storagePath } from "./repository.ts";
import { currentBase, fetchedPullRequest, gitHubFor, parseTarget, pullRequestChangeset } from "./target.ts";

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

// A pull request reads policy from its base. A range on the checked-out commit reads it from the working tree, since
// its author runs Melian; any other range reads it from its base.
export async function review(
	io: Io,
	argument: string,
	options: { readonly model?: string; readonly rerun: boolean },
): Promise<number> {
	const target = parseTarget(argument);
	let changeset: Changeset;
	let source: RepositorySource;
	let origin: ReviewOrigin = { kind: "range" };
	if (target.kind === "pullRequest") {
		const provider = await gitHubFor(io.cwd, io.env);
		const { pullRequest, changeset: fetched } = await fetchedPullRequest(io.cwd, provider, target.number);
		changeset = fetched;
		source = { kind: "revision", commit: pullRequest.base.sha };
		origin = {
			kind: "pull-request",
			repository: pullRequest.repository,
			pullRequest: pullRequest.number,
			base: pullRequest.base.sha,
			head: pullRequest.head.sha,
		};
	} else {
		changeset = await resolveRange(io.cwd, target.spec);
		const checkedOut = await git(changeset.repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "");
		const own = checkedOut === changeset.revision.head;
		source = own ? { kind: "worktree" } : { kind: "revision", commit: changeset.revision.base };
	}
	const { repoRoot } = changeset;
	const paths = changeset.revision.files.map((file) => file.path);
	const lenses = await loadLenses(repoRoot, source, paths);
	const standards = await loadStandards(repoRoot, source, ".");
	const { config: loaded } = await loadConfig(repoRoot, source, ".");
	const { models, config, retry } = await reviewModels(io.env, loaded, lenses, options.model);
	const path = await storagePath(repoRoot, changeset.id, isScripted(io.env));
	// Without the publish extension, so a publication a crash interrupted waits for melian publish rather than posting
	// from a review.
	const harness = await openReviewHarness(await openSqliteStorage(path), models, { retry, checkout: repoRoot });
	try {
		// The deterministic checks first, then the lenses: reviewChangeset reads the checks' records, and a check of the
		// manifest without one makes the review not reviewed. The checks take the configuration as loaded, so a --model
		// route does not change their run's identity and run them again.
		const tier = loaded.stages["pull-request"] ?? "full";
		const rootConversationId = (await harness.root(context)).id;
		const checks = await runChecks(
			harness,
			{ rootConversationId, changeset, config: loaded, source, tier, rerunFailed: options.rerun },
			context,
		);
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
				tier,
				checks: checks.records,
				rerun: options.rerun,
				origin,
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

export async function publish(io: Io, argument: string): Promise<number> {
	const target = parseTarget(argument);
	if (target.kind !== "pullRequest") {
		throw new CliError(`publish takes a pull request, such as '#12'; Melian never posts a review of a range`);
	}
	if (isScripted(io.env)) throw new CliError(`publish refuses to run under ${scriptVariable}`);
	const provider = await gitHubFor(io.cwd, io.env);
	const pullRequest = await provider.pullRequest(target.number);
	const changeset = await pullRequestChangeset(io.cwd, target.number);
	const base = await currentBase(io.cwd, pullRequest);
	const path = await storagePath(changeset.repoRoot, changeset.id, false);
	// Only the publish task: a review a crash interrupted must not resume here and spend tokens on real models.
	const harness = await openPublishHarness(await openSqliteStorage(path), idleModels(io.env), provider);
	try {
		// A head that moved has no merge base here, and publishReview refuses it for the head before it reads this.
		const published = await publishReview({
			harness,
			provider,
			changeset,
			pullRequest,
			base: base ?? pullRequest.base.sha,
		});
		const parts = [
			`${published.posted} new ${published.posted === 1 ? "finding" : "findings"}`,
			...(published.stillOpen > 0 ? [`${published.stillOpen} still open`] : []),
			...(published.resolved > 0 ? [`${published.resolved} resolved`] : []),
		];
		io.stdout(
			`Published review ${published.review} of ${short(pullRequest.head.sha)} to ${pullRequest.url}: ${parts.join(", ")}.\n`,
		);
		io.stdout(`Status ${published.status.state}: ${published.status.description}\n`);
		for (const { fingerprint, refusals, error } of published.abandoned) {
			io.stdout(
				`An earlier review of this head, verdict ${fingerprint}, was abandoned after ${refusals} refusals: ${error}\n`,
			);
		}
		return 0;
	} finally {
		await harness.close(context);
	}
}

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
	const harness = await openReviewHarness(await openSqliteStorage(path), idleModels(io.env));
	try {
		const root = (await harness.root(context)).id;
		const verdict = await readVerdict(harness, root, revisionKey(changeset.revision), context);
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

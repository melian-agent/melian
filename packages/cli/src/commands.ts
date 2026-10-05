import { existsSync } from "node:fs";
import {
	Changeset,
	checksOfTier,
	FindingsLog,
	Lens,
	loadConfig,
	loadSecrets,
	loadStandards,
	Rendering,
	type RepositorySource,
	ReviewPlan,
	userFiles,
	type Verdict,
	visibleText,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	DismissError,
	DismissHarness,
	openPublishHarness,
	openReviewHarness,
	publishReview,
	ReviewError,
	type ReviewOrigin,
	readProvenance,
	readVerdict,
	recordDismissal,
	reviewChangeset,
	revisionKey,
	runChecks,
	unlockCredentials,
} from "@melian-agent/pipeline";
import { idleModels, isScripted, reviewModels, scriptVariable } from "./models.ts";
import { CliError, git, openStorage, storagePath } from "./repository.ts";
import { currentBase, fetchedPullRequest, gitHubFor, parseTarget, pullRequestChangeset } from "./target.ts";

/** Where a command reads and writes: its working directory, environment, and output. */
export interface Io {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	/** Whether standard output takes colour: a terminal, with `NO_COLOR` unset. */
	readonly color: boolean;
	/** The path the shell ran `melian` from, which `doctor` reports. */
	readonly executable?: string;
}

/**
 * `melian review`'s exit codes: `0` passed, `1` findings with one blocking, `2` not reviewed, `3` findings with none
 * blocking. A review that could not start at all also exits `2`, since nothing was reviewed.
 */
export const reviewExitCodes = { passed: 0, blocking: 1, notReviewed: 2, findings: 3 } as const;

/** What `melian review` prints for a verdict, and the exit code it ends with. */
export class ReviewOutcome {
	readonly verdict: Verdict;

	constructor(verdict: Verdict) {
		this.verdict = verdict;
	}

	/** One of {@link reviewExitCodes}. */
	exitCode(): number {
		const { verdict } = this;
		if (verdict.status === "not-reviewed") return reviewExitCodes.notReviewed;
		if (verdict.blocking) return reviewExitCodes.blocking;
		return verdict.status === "passed" ? reviewExitCodes.passed : reviewExitCodes.findings;
	}

	/** The verdict as the terminal shows it, with each finding's ID, which `melian dismiss` takes. */
	render(color: boolean): string {
		return this.verdict.render(new Rendering({ color, ids: true }));
	}
}

// A pull request reads policy from its base. A range on the checked-out commit reads it from the working tree, with the
// preference files, since its author runs Melian; any other range reads it from its base. Credentials come from the
// secrets files whatever the policy's source: they are the maintainer's, not the revision's.
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
		changeset = await Changeset.resolve(io.cwd, target.spec);
		const checkedOut = await git(changeset.repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "");
		const own = checkedOut === changeset.revision.head;
		const preferences = userFiles(io.env).config;
		source = own ? { kind: "worktree", preferences } : { kind: "revision", commit: changeset.revision.base };
	}
	const { repoRoot } = changeset;
	const paths = changeset.revision.paths();
	const lenses = await Lens.load(repoRoot, source, paths);
	const standards = await loadStandards(repoRoot, source, ".");
	const policy = await loadConfig(repoRoot, source, ".");
	const { config: loaded } = policy;
	const tier = loaded.stages["pull-request"] ?? "full";
	const secrets = await loadSecrets(repoRoot, userFiles(io.env).secrets);
	for (const warning of secrets.warnings) io.stderr(`melian: ${warning}\n`);
	const { models, plan, retry } = await reviewModels(io.env, policy, lenses, {
		model: options.model,
		checks: checksOfTier(loaded, tier),
		credentials: secrets.credentials,
	});
	for (const line of plan.summary().split("\n").filter(Boolean)) io.stderr(`melian: ${line}\n`);
	// A command a secrets file names runs now, so one that fails stops the review before it starts, named.
	await unlockCredentials(models, plan.providers());
	const path = await storagePath(repoRoot, changeset.id, io.env, isScripted(io.env));
	// Without the publish extension, so a publication a crash interrupted waits for melian publish rather than posting
	// from a review.
	const reviewHarness = await openReviewHarness(await openStorage(path), models, { retry, checkout: repoRoot });
	const { harness } = reviewHarness;
	try {
		// The deterministic checks first, then the lenses: reviewChangeset reads the checks' records, and a check of the
		// manifest without one makes the review not reviewed. The plan's routes reach only the lenses, so a different
		// --model does not change the checks' run identity and run them again.
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
				config: loaded,
				lenses,
				standards,
				models,
				plan,
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
		const outcome = new ReviewOutcome(verdict);
		io.stdout(outcome.render(io.color));
		return outcome.exitCode();
	} finally {
		await reviewHarness.close(context);
	}
}

function short(commit: string): string {
	return commit.slice(0, 12);
}

// An argument echoed in a command to run, quoted so it can be pasted into a shell: an unquoted `#` starts a comment.
function shellQuote(argument: string): string {
	if (/^[\w@%+=:,./-]+$/.test(argument)) return argument;
	if (!/["$`\\!]/.test(argument)) return `"${argument}"`;
	return `'${argument.replace(/'/g, `'\\''`)}'`;
}

export async function publish(io: Io, argument: string): Promise<number> {
	const target = parseTarget(argument);
	if (target.kind !== "pullRequest") {
		throw new CliError(`publish takes a pull request, such as "#12"; Melian never posts a review of a range`);
	}
	if (isScripted(io.env)) throw new CliError(`publish refuses to run under ${scriptVariable}`);
	const provider = await gitHubFor(io.cwd, io.env);
	const pullRequest = await provider.pullRequest(target.number);
	const changeset = await pullRequestChangeset(io.cwd, target.number);
	const base = await currentBase(io.cwd, pullRequest);
	const path = await storagePath(changeset.repoRoot, changeset.id, io.env, false);
	// Only the publish task: a review a crash interrupted must not resume here and spend tokens on real models.
	const publishHarness = await openPublishHarness(await openStorage(path), idleModels(io.env), provider);
	const { harness } = publishHarness;
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
			...(published.dismissed > 0 ? [`${published.dismissed} dismissed`] : []),
		];
		io.stdout(
			`Published review ${published.review} of ${short(pullRequest.head.sha)} to ${pullRequest.url}: ${parts.join(", ")}.\n`,
		);
		io.stdout(`Status ${published.status.state}: ${published.status.description}\n`);
		for (const { reason } of published.superseded) {
			io.stdout(`An interrupted publication for an earlier target was dropped without posting: ${reason}\n`);
		}
		for (const { fingerprint, refusals, error } of published.abandoned) {
			io.stdout(
				`An earlier review of this head, verdict ${fingerprint}, was abandoned after ${refusals} refusals: ${error}\n`,
			);
		}
		return 0;
	} finally {
		await publishHarness.close(context);
	}
}

// A review stored in the clone's storage, named by `argument`: the refs `review` fetched for a pull request, or the
// range. Opening it reads only local refs, never the network.
class StoredReview {
	readonly changeset: Changeset;
	readonly argument: string;

	private constructor(changeset: Changeset, argument: string) {
		this.changeset = changeset;
		this.argument = argument;
	}

	static async open(io: Io, argument: string): Promise<StoredReview> {
		const target = parseTarget(argument);
		const changeset =
			target.kind === "pullRequest"
				? await pullRequestChangeset(io.cwd, target.number)
				: await Changeset.resolve(io.cwd, target.spec);
		return new StoredReview(changeset, argument);
	}

	// The error for a head Melian has no review of, saying how to make one.
	missing(): CliError {
		return new CliError(
			`Melian has no review of ${short(this.changeset.revision.head)}; run melian review ${shellQuote(this.argument)}`,
		);
	}
}

export async function findings(
	io: Io,
	argument: string,
	options: { readonly open: boolean; readonly all: boolean; readonly json: boolean },
): Promise<number> {
	const stored = await StoredReview.open(io, argument);
	const { changeset } = stored;
	const path = await storagePath(changeset.repoRoot, changeset.id, io.env, isScripted(io.env));
	const missing = stored.missing();
	if (!existsSync(path)) throw missing;
	const reviewHarness = await openReviewHarness(await openStorage(path), idleModels(io.env));
	const { harness } = reviewHarness;
	try {
		const root = (await harness.root(context)).id;
		const revision = revisionKey(changeset.revision);
		const verdict = await readVerdict(harness, root, revision, context);
		if (verdict === undefined) throw missing;
		// The plan the review ran under, as stored with its verdict, never one resolved now: routes or credentials may have
		// changed since, and a review a crash interrupted is summarised as it ran.
		const stored = (await readProvenance(harness, root, revision, context))?.plan;
		if (stored !== undefined && !options.json) {
			for (const line of ReviewPlan.from(stored).summary().split("\n").filter(Boolean))
				io.stderr(`melian: ${line}\n`);
		}
		const render = new Rendering({ color: io.color, ids: true, all: options.all });
		if (!options.open) {
			io.stdout(options.json ? verdict.renderJson() : verdict.render(render));
			return 0;
		}
		const open = FindingsLog.of(verdict.attention());
		io.stdout(options.json ? open.renderJson() : open.render(render));
		return 0;
	} finally {
		await reviewHarness.close(context);
	}
}

// The git author, as `Name <email>`, in git's own order: GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL, then user.name and
// user.email.
async function gitAuthor(repoRoot: string): Promise<string> {
	const ident = await git(repoRoot, ["var", "GIT_AUTHOR_IDENT"]).catch((error: Error) => {
		// git explains a missing identity over several lines; its first says what is wrong.
		const why = error.message.split("\n")[0]!.trim();
		throw new CliError(
			`Melian records who dismissed a finding as the git author, and git has none: ${why}; set user.name and user.email`,
		);
	});
	return ident.replace(/ \d+ [+-]\d{4}$/, "");
}

const verdictWords: Readonly<Record<Verdict["status"], string>> = {
	passed: "passed",
	findings: "findings",
	"not-reviewed": "not reviewed",
};

// Dismisses a finding of the stored review in the changeset's storage, shared by every worktree of the clone, and
// decides the verdict again. Like findings, it reads only local refs and storage.
export async function dismiss(
	io: Io,
	argument: string,
	id: string,
	reason: string,
	options: { readonly only: boolean } = { only: false },
): Promise<number> {
	const stored = await StoredReview.open(io, argument);
	const { changeset } = stored;
	const path = await storagePath(changeset.repoRoot, changeset.id, io.env, isScripted(io.env));
	if (!existsSync(path)) throw stored.missing();
	const by = await gitAuthor(changeset.repoRoot);
	// Only the adjudication task: a review or publication a crash interrupted must not resume here.
	const dismissHarness = await DismissHarness.open(await openStorage(path), idleModels(io.env));
	try {
		const dismissal = { by, reason, at: new Date().toISOString() };
		const recorded = await recordDismissal({
			harness: dismissHarness.harness,
			revision: changeset.revision,
			id,
			dismissal,
			only: options.only,
			repoRoot: changeset.repoRoot,
		}).catch((error: unknown) => {
			if (!(error instanceof DismissError)) throw error;
			if (error.code === "notReviewed") throw stored.missing();
			if (error.code === "unknownFinding") {
				throw new CliError(
					`the review of ${short(changeset.revision.head)} has no finding ${id}; melian findings ${shellQuote(argument)} --all lists them`,
				);
			}
			throw error;
		});
		const { finding, also, replaced, verdict } = recorded;
		const { ruleId } = finding;
		const { path: file, id: shown } = finding.properties;
		const line = finding.locations[0]!.physicalLocation.region.startLine;
		const what = `${visibleText(ruleId)} in ${visibleText(file)} line ${line} (${shown})`;
		io.stdout(
			`${replaced === undefined ? "Dismissed" : "Updated the dismissal of"} ${what} as ${visibleText(by)}.\n`,
		);
		if (replaced !== undefined)
			io.stdout(`It was dismissed by ${visibleText(replaced.by)}: ${visibleText(replaced.reason)}\n`);
		if (also.length > 0) {
			const reports = also.map(
				(other) => `  ${visibleText(other.ruleId)} from ${visibleText(other.check)} (${other.id})\n`,
			);
			io.stdout(`Also dismissed, as reports adjudication merged into it:\n${reports.join("")}`);
			io.stdout(`To dismiss one report alone, run melian dismiss with --only.\n`);
		}
		io.stdout(`Verdict now: ${verdictWords[verdict.status]}${verdict.blocking ? ", blocking" : ""}.\n`);
		const target = parseTarget(argument);
		if (target.kind === "pullRequest") {
			io.stdout(`Run melian publish ${shellQuote(argument)} to post the new verdict to the pull request.\n`);
		}
		return 0;
	} finally {
		await dismissHarness.close(context);
	}
}

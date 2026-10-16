import { existsSync } from "node:fs";
import {
	Changeset,
	checksOfTier,
	FindingsLog,
	Lens,
	loadConfig,
	loadSecrets,
	type PullRequest,
	Rendering,
	type RepositoryPermission,
	type RepositorySource,
	ReviewPlan,
	type ReviewProvider,
	Standards,
	userFiles,
	type Verdict,
	visibleText,
} from "@melian-agent/core";
import {
	CallerContext,
	backgroundContext as context,
	createNodeExecutionEnv,
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
	StageTelemetry,
	summarizeReview,
	TelemetryReader,
	type WriterTrust,
} from "@melian-agent/pipeline";
import {
	decisionProviderRefusal,
	type fallbackDecider,
	idleModels,
	isScripted,
	reviewModels,
	scriptVariable,
	Triage,
} from "./models.ts";
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
	/** A seam for tests: the decider triage asks, in place of the LLM fallback, which scripted mode never triages with. */
	readonly decide?: typeof fallbackDecider;
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

	/**
	 * The verdict as the terminal shows it, with each finding's ID, which `melian dismiss` takes, and the file and
	 * entry that decided what it requires.
	 */
	render(color: boolean): string {
		return this.verdict.render(new Rendering({ color, ids: true, decided: true }));
	}
}

// A pull request reads policy from its base. A range on the checked-out commit reads it from the working tree, with the
// preference files, since its author runs Melian; any other range reads it from its base. Credentials come from the
// secrets files whatever the policy's source: they are the maintainer's, not the revision's.
export async function review(
	io: Io,
	argument: string,
	options: {
		readonly model?: string;
		readonly rerun: boolean;
		readonly walkthrough?: boolean;
		readonly trustHead?: boolean;
		readonly cold?: boolean;
		readonly json?: boolean;
	},
): Promise<number> {
	const beganAt = Date.now();
	const target = parseTarget(argument);
	let changeset: Changeset;
	let source: RepositorySource;
	let origin: ReviewOrigin = { kind: "range" };
	// Whether a check that runs the head's own code may run it here. A pull request's head runs when it sits in the base
	// repository and a writer pushed it. Nothing git records about a committed range, its upstream, its author or where
	// it was fetched from, says whose code it is, so a range runs only on the reviewer's word. Any other head, such as a
	// fork's, runs its tests only in a credential-free job of the Actions host.
	let writer: WriterTrust = { trusted: false, detail: committedRange };
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
		writer = await writerTrust(provider, pullRequest);
	} else {
		changeset = await Changeset.resolve(io.cwd, target.spec);
		const checkedOut = await git(changeset.repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "");
		const own = checkedOut === changeset.revision.head;
		const preferences = userFiles(io.env).config;
		source = own ? { kind: "worktree", preferences } : { kind: "revision", commit: changeset.revision.base };
	}
	// The reviewer vouches for the head on the command line, never in a file the repository holds.
	if (options.trustHead === true) writer = { trusted: true, by: "reviewer" };
	const { repoRoot } = changeset;
	const paths = changeset.revision.paths();
	const lenses = await Lens.load(repoRoot, source, paths);
	const standardsSource =
		source.kind === "revision" ? source : ({ kind: "revision", commit: changeset.revision.head } as const);
	const standards = await Standards.load(repoRoot, standardsSource, paths);
	const policy = await loadConfig(repoRoot, source, ".");
	const { config: loaded } = policy;
	// Under --trust-head the reviewer has read the working tree's melian.yaml, so its mutation settings stand. Without the
	// flag, whether the check runs and for how long is the base's to say, even where the rest of the policy comes from the
	// working tree.
	const checksConfig =
		options.trustHead !== true && source.kind === "worktree"
			? {
					...loaded,
					static: {
						...loaded.static,
						mutation: (await loadConfig(repoRoot, { kind: "revision", commit: changeset.revision.base }, "."))
							.config.static.mutation,
					},
				}
			: loaded;
	const tier = loaded.stages["pull-request"] ?? "full";
	const secrets = await loadSecrets(repoRoot, userFiles(io.env).secrets);
	for (const warning of secrets.warnings) io.stderr(`melian: ${warning}\n`);
	const refusal = decisionProviderRefusal(loaded);
	if (refusal !== undefined) throw new CliError(refusal);
	const { models, plan, retry } = await reviewModels(io.env, policy, lenses, {
		model: options.model,
		checks: checksOfTier(loaded, tier),
		credentials: secrets.credentials,
	});
	for (const line of plan.summary().split("\n").filter(Boolean)) io.stderr(`melian: ${line}\n`);
	const selected = new Set(Lens.select(lenses, loaded, paths).map(({ lens }) => `${lens.name}\0${lens.scope}`));
	const credentialPlan = plan.toJSON();
	credentialPlan.lenses = credentialPlan.lenses.filter((lens) => selected.has(`${lens.name}\0${lens.scope ?? ""}`));
	// A command a secrets file names runs when a task first needs a model, so a repeat review that spends no tokens
	// runs none. Triage unlocks the providers just before that point, and failing there names the credential.
	const triage = await Triage.create({
		scripted: isScripted(io.env) && io.decide === undefined,
		config: loaded,
		plan: ReviewPlan.from(credentialPlan),
		models,
		...(io.decide === undefined ? {} : { decide: io.decide }),
	});
	const path = await storagePath(repoRoot, changeset.id, io.env, isScripted(io.env));
	// Without the publish extension, so a publication a crash interrupted waits for melian publish rather than posting
	// from a review.
	const storage = await openStorage(path);
	const reviewHarness = await openReviewHarness(storage, models, {
		retry,
		checkout: repoRoot,
		...triage.harnessOptions(),
	});
	const { harness } = reviewHarness;
	try {
		// A task a crash left unfinished resumes at the first wait below, so its commands run before it.
		const resumed = await reviewHarness.resumedProviders(context);
		await triage.unlockModels(resumed);
		// Caller context needs the graph that deterministic checks produce.
		const rootConversationId = (await harness.root(context)).id;
		const checks = await runChecks(
			harness,
			{
				rootConversationId,
				changeset,
				config: checksConfig,
				source,
				tier,
				rerunFailed: options.rerun,
				writer,
				...(options.cold === true ? { cold: true } : {}),
			},
			context,
		);
		const callerLenses = new Set(
			checksOfTier(loaded, tier)
				.filter((name) => name.startsWith("lens."))
				.map((name) => name.slice(5)),
		);
		const callerPaths = new Set(
			Lens.select(
				lenses.filter((lens) => callerLenses.has(lens.name)),
				loaded,
				paths,
			).flatMap((selection) => selection.files),
		);
		const callers = loaded.static.enola.enabled
			? await CallerContext.open(
					{
						env: createNodeExecutionEnv(repoRoot),
						repoRoot,
						base: changeset.revision.base,
						...(source.kind === "revision" ? { policyCommit: source.commit } : {}),
						commit: changeset.revision.head,
						tool: "enola",
						settings: loaded.static.enola,
					},
					changeset.revision.files.filter(
						(file) => callerPaths.has(file.path) || (file.oldPath !== undefined && callerPaths.has(file.oldPath)),
					),
					context,
					changeset.revision.files.map((file) => file.path),
				)
			: undefined;
		let verdict: Verdict;
		try {
			({ verdict } = await reviewChangeset({
				harness: reviewHarness,
				changeset,
				config: loaded,
				lenses,
				standards,
				models,
				plan,
				...triage.reviewOptions(),
				policy: source,
				tier,
				checks: checks.records,
				...(callers === undefined ? {} : { callers }),
				rerun: options.rerun,
				origin,
			}));
		} catch (error) {
			if (!(error instanceof ReviewError) || error.verdict === undefined) throw error;
			io.stderr(`melian: ${visibleText(error.message)}\n`);
			verdict = error.verdict;
		}
		if (target.kind === "pullRequest" && options.walkthrough !== false)
			await summarizeReview({
				harness,
				changeset,
				config: loaded,
				models,
				rerun: options.rerun,
				// The walkthrough is published, so it never names a credential; the terminal does.
				unlockModels: async (providers) => {
					try {
						await triage.unlockModels(providers);
					} catch (error) {
						io.stderr(`melian: ${visibleText(error instanceof Error ? error.message : String(error))}\n`);
						throw error;
					}
				},
			});
		const outcome = new ReviewOutcome(verdict);
		const timings = await reviewTimings(storage, revisionKey(changeset.revision), beganAt, io);
		io.stderr(timings.slowest());
		io.stdout(
			options.json
				? `${JSON.stringify({ ...JSON.parse(verdict.renderJson()), telemetry: timings.toJSON() }, null, 2)}\n`
				: outcome.render(io.color),
		);
		return outcome.exitCode();
	} catch (error) {
		const timings = await reviewTimings(storage, revisionKey(changeset.revision), beganAt, io);
		io.stderr(timings.slowest());
		if (options.json)
			io.stdout(
				`${JSON.stringify(
					{
						error: { message: error instanceof Error ? error.message : String(error) },
						telemetry: timings.toJSON(),
					},
					null,
					2,
				)}\n`,
			);
		throw error;
	} finally {
		await reviewHarness.close(context);
	}
}

async function reviewTimings(
	storage: Awaited<ReturnType<typeof openStorage>>,
	revision: string,
	before: number,
	io: Io,
): Promise<StageTelemetry> {
	try {
		return await TelemetryReader.open(storage).read(revision, before);
	} catch (error) {
		io.stderr(
			`melian: Stage timings unavailable: ${visibleText(error instanceof Error ? error.message : String(error))}\n`,
		);
		return new StageTelemetry(revision, []);
	}
}

const committedRange =
	"the head is a committed range, and nothing git records says whose code it is; pass --trust-head if you have read this code and want its tests run";

const writePermissions: readonly RepositoryPermission[] = ["write", "maintain", "admin"];

async function writerTrust(provider: ReviewProvider, pullRequest: PullRequest): Promise<WriterTrust> {
	const head = pullRequest.head.repository;
	if (head === undefined)
		return { trusted: false, detail: "the provider names no repository for the pull request head" };
	if (
		head.owner.toLowerCase() !== pullRequest.repository.owner.toLowerCase() ||
		head.name.toLowerCase() !== pullRequest.repository.name.toLowerCase()
	)
		return { trusted: false, detail: "the head is from a fork" };
	if (pullRequest.head.writerError !== undefined) return { trusted: false, detail: pullRequest.head.writerError };
	const writer = pullRequest.head.pusher ?? pullRequest.author;
	if (writer === undefined)
		return { trusted: false, detail: "the provider names no author for the pull request or pusher for its head" };
	const permission = await provider.permission(writer);
	if (writePermissions.some((each) => each === permission)) return { trusted: true, by: "writer" };
	return {
		trusted: false,
		detail: `${writer} has ${permission === undefined ? "no known" : permission} permission on the repository`,
	};
}

export function short(commit: string): string {
	return commit.slice(0, 12);
}

// An argument echoed in a command to run, quoted so it can be pasted into a shell: an unquoted `#` starts a comment.
export function shellQuote(argument: string): string {
	if (/^[\w@%+=:,./-]+$/.test(argument)) return argument;
	if (!/["$`\\!]/.test(argument)) return `"${argument}"`;
	return `'${argument.replace(/'/g, `'\\''`)}'`;
}

export async function publish(
	io: Io,
	argument: string,
	options: { readonly walkthrough?: boolean } = {},
): Promise<number> {
	const target = parseTarget(argument);
	if (target.kind !== "pullRequest") {
		throw new CliError(`publish takes a pull request, such as "#12"; Melian never posts a review of a range`);
	}
	if (isScripted(io.env)) throw new CliError(`publish refuses to run under ${scriptVariable}`);
	const provider = await gitHubFor(io.cwd, io.env);
	const pullRequest = await provider.pullRequest(target.number);
	const changeset = await pullRequestChangeset(io.cwd, target.number);
	const base = await currentBase(io.cwd, pullRequest);
	const { config } = await loadConfig(changeset.repoRoot, { kind: "revision", commit: pullRequest.base.sha }, ".");
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
			trustedWriters: config.trust.writers,
			walkthrough: {
				...config.publish.walkthrough,
				enabled: options.walkthrough !== false && config.publish.walkthrough.enabled,
			},
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
export class StoredReview {
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
		const render = new Rendering({ color: io.color, ids: true, all: options.all, decided: true });
		if (!options.open) {
			io.stdout(options.json ? verdict.renderJson() : verdict.render(render) + verdict.agentPrompt(argument));
			return 0;
		}
		const open = FindingsLog.of(verdict.attention());
		io.stdout(options.json ? open.renderJson() : open.render(render) + verdict.agentPrompt(argument));
		return 0;
	} finally {
		await reviewHarness.close(context);
	}
}

// The git author, as `Name <email>`, in git's own order: GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL, then user.name and
// user.email.
export async function gitAuthor(repoRoot: string, act = "dismissed a finding"): Promise<string> {
	const ident = await git(repoRoot, ["var", "GIT_AUTHOR_IDENT"]).catch((error: Error) => {
		// git explains a missing identity over several lines; its first says what is wrong.
		const why = error.message.split("\n")[0]!.trim();
		throw new CliError(
			`Melian records who ${act} as the git author, and git has none: ${why}; set user.name and user.email`,
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
		const { finding, also, live, replaced, verdict } = recorded;
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
		if (live.length > 0) {
			const reports = live.map(
				(other) => `  ${visibleText(other.ruleId)} from ${visibleText(other.check)} (${other.id})\n`,
			);
			io.stdout(`Still live, merged with it before:\n${reports.join("")}`);
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

export async function telemetry(io: Io, argument: string, options: { readonly json: boolean }): Promise<number> {
	const stored = await StoredReview.open(io, argument);
	const path = await storagePath(stored.changeset.repoRoot, stored.changeset.id, io.env, isScripted(io.env));
	if (!existsSync(path)) throw new CliError("No stage telemetry is stored for this revision.");
	const storage = await openStorage(path);
	try {
		const timings = await TelemetryReader.open(storage).read(revisionKey(stored.changeset.revision));
		if (timings.stages.length === 0) throw new CliError("No stage telemetry is stored for this revision.");
		io.stdout(options.json ? `${JSON.stringify(timings.toJSON(), null, 2)}\n` : timings.render());
		return 0;
	} finally {
		await storage.close(context);
	}
}

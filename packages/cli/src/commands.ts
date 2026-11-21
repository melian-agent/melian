import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	Changeset,
	checksOfTier,
	DirectoryRecordStore,
	describeInheritance,
	FindingsLog,
	Lens,
	loadConfig,
	loadSecrets,
	type MelianConfig,
	type PullRequest,
	type RecordEnvelope,
	Rendering,
	type RepositoryPermission,
	type RepositorySource,
	ReviewPlan,
	type ReviewProvider,
	Revision,
	reviewPayloads,
	SharedRecord,
	Standards,
	type StoredRunDetails,
	userFiles,
	type Verdict,
	visibleText,
	writesWriterTrust,
} from "@melian-agent/core";
import {
	CallerContext,
	backgroundContext as context,
	createNodeExecutionEnv,
	DismissError,
	DismissHarness,
	openPublishHarness,
	openReviewHarness,
	PrepareSpans,
	type ProbeGap,
	type Publication,
	PublishError,
	publishReview,
	RecordedRound,
	type Review,
	ReviewError,
	type ReviewHarness,
	type ReviewOrigin,
	RoundReader,
	readProvenance,
	readVerdict,
	recordDismissal,
	reviewChangeset,
	runChecks,
	StageTelemetry,
	summarizeReview,
	TelemetryReader,
	type WriterTrust,
} from "@melian-agent/pipeline";
import { DecisionIndexWarning } from "./decision-index.ts";
import {
	decisionProviderRefusal,
	type fallbackDecider,
	idleModels,
	isScripted,
	reviewModels,
	scriptVariable,
	Triage,
} from "./models.ts";
import { CliError, git, openStorage, pullRequestRefs, roundChangeset, storagePath } from "./repository.ts";
import {
	checkExpected,
	currentBase,
	fetchedPullRequest,
	gitHubFor,
	parseTarget,
	pullRequestChangeset,
} from "./target.ts";

/** Where a command reads and writes: its working directory, environment, and output. */
export interface Io {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	/** Whether standard output takes colour: a terminal, with `NO_COLOR` unset. */
	readonly color: boolean;
	/** Whether standard output is a terminal, which `output.emoji: auto` asks. */
	readonly tty?: boolean;
	/** The path the shell ran `melian` from, which `doctor` reports. */
	readonly executable?: string;
	/** A seam for tests: the decider triage asks, in place of the LLM fallback, which scripted mode never triages with. */
	readonly decide?: typeof fallbackDecider;
	/** When the process started, in epoch milliseconds, so a review's spans cover its startup. */
	readonly startedAt?: number;
}

/**
 * `melian review`'s exit codes: `0` passed, `1` findings with one blocking, `2` not reviewed, `3` findings with none
 * blocking. A review that could not start at all also exits `2`, since nothing was reviewed.
 */
export const reviewExitCodes = { passed: 0, blocking: 1, notReviewed: 2, findings: 3 } as const;

/** What `melian review` prints for a verdict, and the exit code it ends with. */
export class ReviewOutcome {
	readonly verdict: Verdict;
	/** The range or `#N` reviewed, which each `melian dismiss` command the verdict prints names. */
	readonly target: string | undefined;

	constructor(verdict: Verdict, target?: string) {
		this.verdict = verdict;
		this.target = target;
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
	 * entry that decided what it requires; with emojis when `emoji` is set, each lens's from `lenses`. `ran` is the
	 * configuration and paths the review selected them under, whose `tier` or `paths` give a lens the version its
	 * findings carry.
	 */
	render(
		color: boolean,
		emoji: boolean,
		lenses: readonly Lens[],
		ran?: { readonly config: MelianConfig; readonly paths: readonly string[] },
		notes?: boolean,
	): string {
		const selected = ran === undefined ? [] : Lens.select(lenses, ran.config, ran.paths).map(({ lens }) => lens);
		// Each variant by its version, loaded or as the review ran it; a name alone only when its variants agree, so a
		// report naming no version shows no variant's emoji as another's.
		const declared = [...lenses, ...selected].flatMap((lens) => (lens.emoji === undefined ? [] : [lens]));
		const lensEmojis = Object.fromEntries([
			...declared.map((lens) => [`lens.${lens.name}@${lens.version}`, lens.emoji!]),
			...declared
				.filter((lens) => lenses.every((other) => other.name !== lens.name || other.emoji === lens.emoji))
				.map((lens) => [`lens.${lens.name}`, lens.emoji!]),
		]);
		const { target } = this;
		return this.verdict.render(new Rendering({ color, emoji, lensEmojis, ids: true, decided: true, notes, target }));
	}
}

// Whether the terminal shows emojis. `output.emoji` is display alone, so it comes from the working tree and the
// preference files, and a configuration that does not load leaves it at `auto`: the command's own work reads its
// policy separately and fails there. `auto` shows them on a terminal whose
// locale, the first of `LC_ALL`, `LC_CTYPE` and `LANG` that is set, is UTF-8.
async function terminalEmoji(io: Io, repoRoot: string): Promise<boolean> {
	const source = { kind: "worktree", preferences: userFiles(io.env).config } as const;
	const setting = await loadConfig(repoRoot, source, ".").then(
		({ config }) => config.output.emoji,
		() => "auto" as const,
	);
	if (setting !== "auto") return setting === "on";
	const locale = io.env.LC_ALL || io.env.LC_CTYPE || io.env.LANG || "";
	return io.tty === true && /utf-?8/i.test(locale);
}

/** The dismissal snapshots a publication attested, grouped by round. */
export class PublicationAttestations {
	readonly rounds: Publication["attestations"];

	constructor(rounds: Publication["attestations"]) {
		this.rounds = rounds;
	}

	render(): string {
		return this.rounds
			.map(({ revision, round, dismissals }) => {
				if (dismissals.length === 0) return "";
				return [
					"Attested dismissals:",
					`  Revision ${visibleText(revision)}, round ${round}`,
					...dismissals.map(
						({ id, ruleId, path, dismissal }) =>
							`  ${visibleText(id)} ${visibleText(ruleId)} in ${visibleText(path)}${describeInheritance(dismissal ?? {})}: ${dismissal?.inheritedFrom === undefined ? `by ${visibleText(dismissal?.by ?? "unknown")} ` : ""}at ${visibleText(dismissal?.at ?? "unknown")}: ${visibleText(dismissal?.reason ?? "No reason stored.")}`,
					),
					"",
				].join("\n");
			})
			.join("");
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
		readonly notes?: boolean;
		// Where the review exports its records, as `dir:<path>`, resolved against the working directory.
		readonly records?: string;
		// The base and head the caller approved, such as the melian round workflow's gate; a pull request that moved
		// since is refused before any model credential is read.
		readonly expect?: { readonly base: string; readonly head: string };
		// Fail each level that probes and cannot, rather than run it without probes, and write each such level's check,
		// level and cause to `probeGaps` as JSON, where the reason's text, which can name a path in the head, never goes.
		readonly requireProbes?: boolean;
		readonly probeGaps?: string;
	},
): Promise<number> {
	const beganAt = Date.now();
	const spans = PrepareSpans.start("startup", io.startedAt ?? beganAt);
	spans.step("resolve");
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
		// The policy and origin come from GitHub's answer, and the diff from the refs the fetch wrote.
		if (options.expect !== undefined)
			await checkExpected(pullRequest, fetched, options.expect, "nothing was reviewed");
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
		source = (await ReviewSource.ofRange(changeset, io.env)).source;
	}
	// The reviewer vouches for the head on the command line, never in a file the repository holds.
	if (options.trustHead === true) writer = { trusted: true, by: "reviewer" };
	const { repoRoot } = changeset;
	const paths = changeset.revision.paths();
	spans.step("lenses.load");
	const lenses = await Lens.load(repoRoot, source, paths);
	spans.step("standards.load");
	const standardsSource =
		source.kind === "revision" ? source : ({ kind: "revision", commit: changeset.revision.head } as const);
	const standards = await Standards.load(repoRoot, standardsSource, paths);
	spans.step("config");
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
	// A record counts only from a writer the base trusts, so a store is opened only under that base's policy.
	const trustsWriters =
		options.records === undefined ? false : await ReviewSource.of(changeset, source).trustsWriters();
	if (options.records !== undefined && !trustsWriters)
		io.stderr(
			"melian: records not exported: the base's melian.yaml does not set trust.writers: true, so no reader would count them\n",
		);
	spans.step("secrets");
	const secrets = await loadSecrets(repoRoot, userFiles(io.env).secrets);
	for (const warning of secrets.warnings) io.stderr(`melian: ${warning}\n`);
	const refusal = decisionProviderRefusal(loaded);
	if (refusal !== undefined) throw new CliError(refusal);
	spans.step("models");
	const { models, plan, retry } = await reviewModels(io.env, policy, lenses, {
		model: options.model,
		checks: checksOfTier(loaded, tier),
		credentials: secrets.credentials,
	});
	for (const line of plan.summary().split("\n").filter(Boolean)) io.stderr(`melian: ${line}\n`);
	spans.step("triage.create");
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
	const unlockModels = (providers: readonly string[]) => spans.time("unlock", () => triage.unlockModels(providers));
	spans.step("storage.open");
	const path = await storagePath(repoRoot, changeset.id, io.env, isScripted(io.env));
	// Without the publish extension, so a publication a crash interrupted waits for melian publish rather than posting
	// from a review.
	const storage = await openStorage(path);
	const reviewHarness = await openReviewHarness(storage, models, {
		retry,
		checkout: repoRoot,
		environment: io.env,
		...triage.harnessOptions(),
	});
	const { harness } = reviewHarness;
	let walkthrough: Promise<void> | undefined;
	let records: DirectoryRecordStore | undefined;
	try {
		if (options.records !== undefined && trustsWriters)
			records = await DirectoryRecordStore.open(
				resolve(io.cwd, options.records.slice("dir:".length)),
				reviewPayloads,
			);
		spans.step("resume");
		// A task a crash left unfinished resumes at the first wait below, so its commands run before it.
		const resumed = await reviewHarness.resumedProviders(context);
		await unlockModels(resumed);
		// Caller context needs the graph that deterministic checks produce.
		const rootConversationId = (await harness.root(context)).id;
		spans.end();
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
		spans.step("callers");
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
						environment: io.env,
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
					spans,
				)
			: undefined;
		// The walkthrough needs the change, not the verdict, so it runs beside the lenses once their run is recorded.
		const summarize = () => {
			if (target.kind !== "pullRequest" || options.walkthrough === false) return;
			walkthrough ??= summarizeReview({
				harness,
				changeset,
				config: loaded,
				models,
				origin,
				plan,
				rerun: options.rerun,
				// The walkthrough is published, so it never names a credential; the terminal does. It runs beside the review,
				// so its unlock is a span of its own rather than part of whichever review step is open.
				unlockModels: async (providers) => {
					try {
						await spans.concurrent("walkthrough", "unlock", () => triage.unlockModels(providers));
					} catch (error) {
						io.stderr(`melian: ${visibleText(error instanceof Error ? error.message : String(error))}\n`);
						throw error;
					}
				},
			});
			return walkthrough;
		};
		let verdict: Verdict;
		let decisionIndexWarning: string | undefined;
		let unshared: Review["unshared"] = [];
		const gaps: ProbeGap[] = [];
		try {
			({ verdict, decisionIndexWarning, unshared } = await reviewChangeset({
				harness: reviewHarness,
				changeset,
				config: loaded,
				lenses,
				standards,
				models,
				plan,
				...triage.reviewOptions(),
				unlockModels,
				spans,
				policy: source,
				tier,
				checkRun: checks,
				...(callers === undefined ? {} : { callers }),
				rerun: options.rerun,
				origin,
				writer,
				lensesStarted: summarize,
				...(options.requireProbes === true ? { requireProbes: true, probeGap: (gap) => gaps.push(gap) } : {}),
				...(records === undefined ? {} : { records }),
			}));
		} catch (error) {
			if (!(error instanceof ReviewError) || error.verdict === undefined) throw error;
			io.stderr(`melian: ${visibleText(error.message)}\n`);
			verdict = error.verdict;
			decisionIndexWarning = error.decisionIndexWarning;
			unshared = error.unshared;
		}
		if (options.probeGaps !== undefined) await writeFile(options.probeGaps, `${JSON.stringify(gaps)}\n`, "utf8");
		summarize();
		spans.end();
		await walkthrough;
		const indexWarning = DecisionIndexWarning.from(decisionIndexWarning, [...(verdict.ran ?? []), ...verdict.notRun]);
		spans.step("output");
		const outcome = new ReviewOutcome(verdict, argument);
		const timings = await reviewTimings(reviewHarness, storage, spans, Revision.key(changeset.revision), beganAt, io);
		io.stderr(timings.slowest());
		const texts = [
			...(indexWarning === undefined ? [] : [indexWarning.text]),
			...unshared.map(({ finding, code }) => `the dismissal of ${finding} is not shared with the records (${code})`),
		];
		for (const text of texts) io.stderr(`melian: ${text}\n`);
		const warnings = texts.length === 0 ? {} : { warnings: texts };
		io.stdout(
			options.json
				? `${JSON.stringify({ ...JSON.parse(verdict.renderJson()), ...warnings, telemetry: timings.report() }, null, 2)}\n`
				: outcome.render(
						io.color,
						await terminalEmoji(io, repoRoot),
						lenses,
						{ config: loaded, paths },
						options.notes,
					),
		);
		return outcome.exitCode();
	} catch (error) {
		spans.end();
		await walkthrough;
		const timings = await reviewTimings(
			reviewHarness,
			storage,
			spans,
			Revision.key(changeset.revision),
			beganAt,
			io,
			true,
		);
		io.stderr(timings.slowest());
		if (options.json)
			io.stdout(
				`${JSON.stringify(
					{
						error: { message: error instanceof Error ? error.message : String(error) },
						telemetry: timings.report(),
					},
					null,
					2,
				)}\n`,
			);
		throw error;
	} finally {
		await records?.close();
		await reviewHarness.close(context);
	}
}

// The spans end where the record is stored, just before the verdict prints, so the record covers the whole review.
async function reviewTimings(
	reviewHarness: ReviewHarness,
	storage: Awaited<ReturnType<typeof openStorage>>,
	spans: PrepareSpans,
	revision: string,
	before: number,
	io: Io,
	preserveDecided = false,
): Promise<StageTelemetry> {
	try {
		if (preserveDecided) {
			const root = await reviewHarness.harness.root(context);
			const verdict = await readVerdict(reviewHarness.harness, root.id, revision, context);
			const previous = await TelemetryReader.open(storage).read(revision, before);
			if (verdict !== undefined && previous.prepare !== undefined) return previous;
		}
		const prepare = await spans.record(reviewHarness.harness, revision, context);
		const reader = TelemetryReader.open(storage);
		if (spans.roundId !== undefined) await reader.recordRun(reviewHarness.harness, revision, spans.roundId, prepare);
		return await reader.read(revision, before);
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

export async function writerTrust(provider: ReviewProvider, pullRequest: PullRequest): Promise<WriterTrust> {
	const head = pullRequest.head.repository;
	if (head === undefined)
		return { trusted: false, detail: "the provider names no repository for the pull request head" };
	if (
		head.owner.toLowerCase() !== pullRequest.repository.owner.toLowerCase() ||
		head.name.toLowerCase() !== pullRequest.repository.name.toLowerCase()
	)
		return { trusted: false, detail: "the head is from a fork" };
	if (pullRequest.head.writerError !== undefined) return { trusted: false, detail: pullRequest.head.writerError };
	const writer = pullRequest.head.pusher;
	if (writer === undefined)
		return { trusted: false, detail: "the provider names no pusher for the pull request's head" };
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
// Control characters are written visibly first, so a path cannot rewrite the terminal the command is printed to.
export function shellQuote(text: string): string {
	const argument = visibleText(text);
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
	const reader = await gitHubFor(io.cwd, io.env);
	const pullRequest = await reader.pullRequest(target.number);
	const changeset = await pullRequestChangeset(io.cwd, target.number);
	const base = await currentBase(io.cwd, pullRequest);
	const { config } = await loadConfig(changeset.repoRoot, { kind: "revision", commit: pullRequest.base.sha }, ".");
	// `publish.emoji` is the base's to say, and the base is known only once the pull request is read.
	const provider = config.publish.emoji === "on" ? reader : await gitHubFor(io.cwd, io.env, { emoji: false });
	const path = await storagePath(changeset.repoRoot, changeset.id, io.env, false);
	const storage = await openStorage(path);
	// Only the publish task: a review a crash interrupted must not resume here and spend tokens on real models.
	const publishHarness = await openPublishHarness(storage, idleModels(io.env), provider);
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
			readRun: (roundId) => reviewRun(storage, roundId, io),
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
		io.stdout(new PublicationAttestations(published.attestations).render());
		for (const { reason } of published.superseded) {
			io.stdout(`An interrupted publication for an earlier target was dropped without posting: ${reason}\n`);
		}
		for (const { fingerprint, refusals, error } of published.abandoned) {
			io.stdout(
				`An earlier review of this head, verdict ${fingerprint}, was abandoned after ${refusals} refusals: ${error}\n`,
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof PublishError) io.stdout(new PublicationAttestations(error.attestations).render());
		throw error;
	} finally {
		await publishHarness.close(context);
	}
}

// The ledger is still worth posting without its run details, so an unreadable record leaves them out and says so.
async function reviewRun(
	storage: Awaited<ReturnType<typeof openStorage>>,
	roundId: string,
	io: Io,
): Promise<StoredRunDetails | undefined> {
	try {
		return await TelemetryReader.open(storage).runDetails(roundId);
	} catch (error) {
		io.stderr(
			`melian: Run details unavailable: ${visibleText(error instanceof Error ? error.message : String(error))}\n`,
		);
		return undefined;
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

// A changeset and the source a review of it reads its policy from.
export class ReviewSource {
	readonly changeset: Changeset;
	readonly source: RepositorySource;

	private constructor(changeset: Changeset, source: RepositorySource) {
		this.changeset = changeset;
		this.source = source;
	}

	static of(changeset: Changeset, source: RepositorySource): ReviewSource {
		return new ReviewSource(changeset, source);
	}

	// The source a stored review read its policy from: a pull request's base, or what a range reads.
	static async ofStored(stored: StoredReview, env: Io["env"]): Promise<ReviewSource> {
		const target = parseTarget(stored.argument);
		if (target.kind !== "pullRequest") return ReviewSource.ofRange(stored.changeset, env);
		const commit = await git(stored.changeset.repoRoot, ["rev-parse", pullRequestRefs(target.number).base]);
		return ReviewSource.of(stored.changeset, { kind: "revision", commit });
	}

	// A range reads the working tree when its head is checked out, so the reviewer's own edits count, and otherwise the
	// base.
	static async ofRange(changeset: Changeset, env: Io["env"]): Promise<ReviewSource> {
		const checkedOut = await git(changeset.repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "");
		return new ReviewSource(
			changeset,
			checkedOut === changeset.revision.head
				? { kind: "worktree", preferences: userFiles(env).config }
				: { kind: "revision", commit: changeset.revision.base },
		);
	}

	// Whether the base's policy writes out trust in a record store's writers. A working tree's melian.yaml is the
	// reviewer's, never the base's.
	trustsWriters(): Promise<boolean> {
		const { repoRoot, revision } = this.changeset;
		return writesWriterTrust(repoRoot, this.source.kind === "revision" ? this.source.commit : revision.base);
	}
}

export async function findings(
	io: Io,
	argument: string,
	options: {
		readonly open: boolean;
		readonly all: boolean;
		readonly json: boolean;
		readonly notes?: boolean;
		readonly round?: string;
		readonly rounds?: boolean;
		readonly records?: string;
	},
): Promise<number> {
	if (options.round !== undefined) return roundFindings(io, options.round, options);
	if (options.records !== undefined) return recordedFindings(io, argument, options.records, options);
	const stored = await StoredReview.open(io, argument);
	const { changeset } = stored;
	const path = await storagePath(changeset.repoRoot, changeset.id, io.env, isScripted(io.env));
	const missing = stored.missing();
	if (!existsSync(path)) throw missing;
	if (options.rounds) {
		const storage = await openStorage(path);
		try {
			const rounds = await new RoundReader(storage).read(changeset.id);
			const dates = new Map<string, number>();
			for (const round of rounds.filter((round) => round.stored.mintedAt === undefined)) {
				try {
					dates.set(
						round.stored.head,
						Number(await git(changeset.repoRoot, ["show", "-s", "--format=%ct", round.stored.head, "--"])),
					);
				} catch {}
			}
			rounds.sort((left, right) => left.compare(right, dates));
			const listed = rounds.map((round) => {
				const date = dates.get(round.stored.head);
				const listed = {
					id: round.id,
					base: round.stored.base,
					head: round.stored.head,
					mintedAt: round.stored.mintedAt,
					date: round.stored.mintedAt ?? (date === undefined ? "unknown" : new Date(date * 1000).toISOString()),
					status: round.verdict()?.status ?? "undecided",
				};
				return options.json ? listed : `${listed.id}  ${round.revisionKey()}  ${listed.status}  ${listed.date}\n`;
			});
			io.stdout(options.json ? `${JSON.stringify(listed, null, 2)}\n` : listed.join(""));
			return 0;
		} finally {
			await storage.close(context);
		}
	}
	const reviewHarness = await openReviewHarness(await openStorage(path), idleModels(io.env));
	const { harness } = reviewHarness;
	try {
		const root = (await harness.root(context)).id;
		const revision = Revision.key(changeset.revision);
		const verdict = await readVerdict(harness, root, revision, context);
		if (verdict === undefined) throw missing;
		// The plan the review ran under, as stored with its verdict, never one resolved now: routes or credentials may have
		// changed since, and a review a crash interrupted is summarised as it ran.
		const stored = (await readProvenance(harness, root, revision, context))?.plan;
		if (stored !== undefined && !options.json) {
			for (const line of ReviewPlan.from(stored).summary().split("\n").filter(Boolean))
				io.stderr(`melian: ${line}\n`);
		}
		const emoji = await terminalEmoji(io, changeset.repoRoot);
		const render = new Rendering({
			color: io.color,
			emoji,
			ids: true,
			all: options.all,
			decided: true,
			notes: options.notes,
			target: argument,
		});
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

// Decides each round a record store holds at the target's revision from its records alone, under the policy source the
// review read. Every round is shown, by ID, since no round names another it replaces until issue #395 decides who may.
async function recordedFindings(
	io: Io,
	argument: string,
	store: string,
	options: { readonly all: boolean; readonly json: boolean; readonly notes?: boolean },
): Promise<number> {
	const review = await StoredReview.open(io, argument);
	const { changeset } = review;
	const { repoRoot } = changeset;
	const reviewed = await ReviewSource.ofStored(review, io.env);
	const { source } = reviewed;
	const { config } = await loadConfig(repoRoot, source, ".");
	if (!(await reviewed.trustsWriters()))
		throw new CliError("the base's melian.yaml does not set trust.writers: true, so no record in the store counts");
	const path = resolve(io.cwd, store.slice("dir:".length));
	if (!existsSync(path)) throw new CliError(`no record store at ${path}`);
	const records = await DirectoryRecordStore.open(path, reviewPayloads);
	let stored: RecordEnvelope[];
	try {
		stored = await records.list(changeset.id);
	} finally {
		await records.close();
	}
	const revision = Revision.key(changeset.revision);
	const rounds = stored
		.map((each) => SharedRecord.parseEnvelope(each))
		.filter((record) => record.kind === "round" && record.revision === revision)
		.sort((left, right) => (left.id < right.id ? -1 : 1));
	if (rounds.length === 0) throw new CliError(`the record store holds no round of ${short(changeset.revision.head)}`);
	const emoji = await terminalEmoji(io, repoRoot);
	const render = new Rendering({
		color: io.color,
		emoji,
		ids: true,
		all: options.all,
		decided: true,
		notes: options.notes,
		target: argument,
	});
	const decided: { round: string; verdict: Verdict }[] = [];
	for (const { id } of rounds) {
		const round = RecordedRound.of(stored, id, () => true);
		const contents = round.contents(changeset.revision);
		for (const ended of "refused" in contents ? [] : contents.ended)
			io.stderr(
				`melian: finding ${ended.finding} is live again in round ${id}: it was dismissed at revision ${ended.madeAt}, and round ${ended.round} reviewed ${ended.at}, as after a push. A shared dismissal holds only at the revision it was made at. To share it at this one, dismiss it again: melian dismiss ${shellQuote(argument)} ${ended.finding} --reason "<text>" --records ${shellQuote(store)}\n`,
			);
		decided.push({
			round: id,
			verdict: await round.verdict({ revision: changeset.revision, config, repoRoot, policy: source }),
		});
	}
	io.stdout(
		options.json
			? `${JSON.stringify(
					decided.map(({ round, verdict }) => ({ round, verdict: JSON.parse(verdict.renderJson()) as unknown })),
					null,
					2,
				)}\n`
			: decided.map(({ round, verdict }) => `Round ${round}\n${verdict.render(render)}`).join("\n"),
	);
	return 0;
}

async function roundFindings(
	io: Io,
	id: string,
	options: { readonly open: boolean; readonly all: boolean; readonly json: boolean; readonly notes?: boolean },
): Promise<number> {
	const changesetId = roundChangeset(id);
	if (changesetId === undefined) throw new CliError(`invalid round ID ${id}`);
	const repoRoot = await git(io.cwd, ["rev-parse", "--show-toplevel"]);
	const path = await storagePath(repoRoot, changesetId, io.env, isScripted(io.env));
	if (!existsSync(path)) throw new CliError(`Melian has no round ${id}`);
	const storage = await openStorage(path);
	try {
		const round = (await new RoundReader(storage).read(changesetId)).find((round) => round.id === id);
		if (round === undefined) throw new CliError(`Melian has no round ${id}`);
		const verdict = round.verdict();
		if (verdict === undefined) throw new CliError(`Melian has no decided round ${id}`);
		const plan = round.stored.provenance?.plan;
		if (plan !== undefined && !options.json) {
			for (const line of ReviewPlan.from(plan).summary().split("\n").filter(Boolean)) io.stderr(`melian: ${line}\n`);
		}
		const emoji = await terminalEmoji(io, repoRoot);
		const render = new Rendering({
			color: io.color,
			emoji,
			ids: true,
			all: options.all,
			decided: true,
			historical: true,
			notes: options.notes,
		});
		if (options.open) {
			const open = FindingsLog.of(verdict.attention());
			io.stdout(options.json ? open.renderJson() : open.render(render));
		} else io.stdout(options.json ? verdict.renderJson() : verdict.render(render));
		return 0;
	} finally {
		await storage.close(context);
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
	options: { readonly only: boolean; readonly records?: string },
): Promise<number> {
	const stored = await StoredReview.open(io, argument);
	const { changeset } = stored;
	const path = await storagePath(changeset.repoRoot, changeset.id, io.env, isScripted(io.env));
	if (!existsSync(path)) throw stored.missing();
	// A record counts only from a writer the base trusts, so a dismissal is written to a store only under that policy.
	if (options.records !== undefined && !(await (await ReviewSource.ofStored(stored, io.env)).trustsWriters()))
		throw new CliError(
			"the base's melian.yaml does not set trust.writers: true, so no reader would count the dismissal's record",
		);
	const by = await gitAuthor(changeset.repoRoot);
	// Only the adjudication task: a review or publication a crash interrupted must not resume here.
	const dismissHarness = await DismissHarness.open(await openStorage(path), idleModels(io.env));
	let store: DirectoryRecordStore | undefined;
	try {
		if (options.records !== undefined)
			store = await DirectoryRecordStore.open(resolve(io.cwd, options.records.slice("dir:".length)), reviewPayloads);
		const dismissal = { by, reason, at: new Date().toISOString() };
		const recorded = await recordDismissal({
			harness: dismissHarness.harness,
			revision: changeset.revision,
			id,
			dismissal,
			only: options.only,
			repoRoot: changeset.repoRoot,
			...(store === undefined ? {} : { records: { store, changeset: changeset.id } }),
		}).catch((error: unknown) => {
			if (!(error instanceof DismissError)) throw error;
			if (error.code === "notReviewed") throw stored.missing();
			if (error.code === "storeFailed") {
				const why = error.cause instanceof Error ? error.cause.message : String(error.cause);
				throw new CliError(
					`the dismissal is not recorded, because the record store ${visibleText(options.records!)} failed: ${visibleText(why)}`,
				);
			}
			if (error.code === "unknownFinding") {
				throw new CliError(
					`the review of ${short(changeset.revision.head)} has no finding ${id}; melian findings ${shellQuote(argument)} --all lists them`,
				);
			}
			throw error;
		});
		const { finding, also, live, replaced, verdict, unshared } = recorded;
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
		if (store === undefined)
			io.stdout(
				"The dismissal is not shared: no record names the rounds the store held as it was made, so no review exports it. Dismiss it again with --records to share it.\n",
			);
		for (const { finding: report, code } of unshared)
			io.stderr(`melian: the dismissal of ${report} is not shared with the records (${code})\n`);
		const target = parseTarget(argument);
		if (target.kind === "pullRequest") {
			io.stdout(`Run melian publish ${shellQuote(argument)} to post the new verdict to the pull request.\n`);
		}
		return 0;
	} finally {
		await store?.close();
		await dismissHarness.close(context);
	}
}

export async function telemetry(io: Io, argument: string, options: { readonly json: boolean }): Promise<number> {
	const stored = await StoredReview.open(io, argument);
	const path = await storagePath(stored.changeset.repoRoot, stored.changeset.id, io.env, isScripted(io.env));
	if (!existsSync(path)) throw new CliError("No stage telemetry is stored for this revision.");
	const storage = await openStorage(path);
	try {
		const timings = await TelemetryReader.open(storage).read(Revision.key(stored.changeset.revision));
		if (timings.stages.length === 0 && timings.prepare === undefined)
			throw new CliError("No stage telemetry is stored for this revision.");
		io.stdout(options.json ? `${JSON.stringify(timings.report(), null, 2)}\n` : timings.render());
		return 0;
	} finally {
		await storage.close(context);
	}
}

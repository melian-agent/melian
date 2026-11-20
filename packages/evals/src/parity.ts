import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type ChangedFile,
	Changeset,
	checksOfTier,
	gitEnvironment,
	Lens,
	type LensLevel,
	lensCovers,
	lensGraphToolNames,
	type MelianConfig,
	type ModelRoute,
	parseModelReference,
	Revision,
	visibleText,
} from "@melian-agent/core";
import {
	backgroundContext,
	isProviderLimit,
	openSqliteStorage,
	type ProbeAvailability,
	type ProbingHost,
	type ReviewModels,
	type Stage,
	type StageTelemetry,
	TelemetryReader,
} from "@melian-agent/pipeline";
import type { LiveGoldenMode, ProbingRoute, RangeRun, ReviewTarget } from "./goldens.ts";
import { Miss, type MissLocation, ProbeTrust } from "./probing.ts";
import { GoldenRunError } from "./run-error.ts";

type Print = (line: string) => void;

/** The name of the arm that gives a review one total and every lens the design lens's capabilities. */
export const parityArmName = "Parity per total budget";

/**
 * The design lens's paragraph on the graph tools, from `.melian/lenses/design/LENS.md`, which the parity arm gives every
 * lens that does not already list them, so each lens is told how to use the tools it is given.
 */
export const graphGuidance =
	"To test an assumption against the code that relies on it, ask Enola's graph of the head before you grep. `graph_definitions` finds where a name is declared and gives its full name. `graph_references` lists what calls, constructs, names, imports or implements that declaration, and `graph_impact` lists what reaches it through calls, up to three levels away. `graph_callees` lists what it calls. The graph holds only the edges Enola resolved: a method called through an instance is often missing, so an empty answer proves nothing, and `search` finds the rest. Confirm each caller with `read_file` before citing it.";

const modelTiers = ["light", "medium", "heavy"] as const;

// A route with no fallbacks, so a lens at its provider's limit fails rather than answering on another model. A route
// that names no model runs its accepted models in turn, so it is held to the first. No route stays none: a lens route
// of thinking alone has no model, and core reads it in place of the tier's.
function pinned(route: ModelRoute | undefined, thinking?: "high"): ModelRoute | undefined {
	if (route === undefined) return undefined;
	const { fallbacks: _, ...rest } = route;
	const first = rest.model ?? rest.accept?.[0];
	const held = first === undefined ? rest : { ...rest, model: first };
	return thinking === undefined ? held : { ...held, thinking };
}

function pinnedConfig(config: MelianConfig, thinking?: "high"): MelianConfig {
	const models = { ...config.models };
	for (const tier of modelTiers) {
		const route = pinned(models[tier], thinking);
		if (route !== undefined) models[tier] = route;
	}
	for (const tier of ["decision", "verifier"] as const) {
		const route = pinned(models[tier]);
		if (route !== undefined) models[tier] = route;
	}
	const lenses = Object.fromEntries(
		Object.entries(config.lenses).map(([name, settings]) => {
			const route = pinned(settings.route, thinking);
			return [name, route === undefined ? settings : { ...settings, route }];
		}),
	);
	return { ...config, models, lenses };
}

function changedLines(file: ChangedFile): number {
	return file.hunks.reduce((sum, hunk) => sum + hunk.oldLines + hunk.newLines, 0);
}

/**
 * The review as its base's policy commits it, with Enola's graph opened as the CLI opens it and every route held to its
 * first model, so its spend is the parity arm's total and both arms answer on the same models.
 */
export class CommittedArm implements ProbingRoute {
	readonly graph = true as const;

	routed(config: MelianConfig, lenses: readonly Lens[]): { config: MelianConfig; lenses: readonly Lens[] } {
		return { config: pinnedConfig(config), lenses };
	}
}

/**
 * The parity arm: every lens the review's tier runs gets the graph tools and their guidance, `high` thinking on its
 * route, and one level in place of its own, declared as both `careful` and `deep` and never `quick`, so whichever level
 * triage picks, the floor raises it to, or escalation reaches runs the same settings once: its `deep` level, which
 * probes wherever core allows, with at least the policy commit's design lens's findings budget and its tool-call
 * ceiling, so the token share binds. Tokens are what bind: `total` is shared between the lenses, half equally and
 * half by the changed lines of the files each selects, and a lens that probes splits its share between its planner
 * and its prober, since each conversation spends against its level's budget. A share is a soft limit: the request that
 * crosses it finishes, and a lens its share ends counts, with its findings so far, so a review whose lenses and probers
 * spent past `total` goes unscored. Every route is held to its first model, as the committed arm's is. Throws when the
 * lenses hold no design lens at the root.
 */
export class ParityArm implements ProbingRoute {
	readonly graph = true as const;
	/** The tokens, cache reads left out, the lenses share. */
	readonly total: number;

	constructor(total: number) {
		if (!Number.isInteger(total) || total < 1) throw new Error(`The parity arm needs a positive total, not ${total}`);
		this.total = total;
	}

	/** Each lens the tier runs and the tokens its share gives it, before a probing lens splits it. */
	shares(config: MelianConfig, lenses: readonly Lens[], files: readonly ChangedFile[]): Map<string, number> {
		const tier = config.stages["pull-request"] ?? "full";
		const runs = new Set(checksOfTier(config, tier));
		const selections = Lens.select(
			lenses.filter((lens) => runs.has(`lens.${lens.name}`)),
			config,
			files.flatMap((file) => (file.oldPath === undefined ? [file.path] : [file.oldPath, file.path])),
		);
		const weights = new Map<string, number>();
		for (const { lens, files: selected } of selections) {
			const lines = files
				.filter(
					(file) =>
						selected.includes(file.path) || (file.oldPath !== undefined && selected.includes(file.oldPath)),
				)
				.reduce((sum, file) => sum + changedLines(file), 0);
			const key = this.keyOf(lens);
			weights.set(key, (weights.get(key) ?? 0) + lines);
		}
		const all = [...weights.values()].reduce((sum, lines) => sum + lines, 0);
		const count = weights.size;
		return new Map(
			[...weights].map(([name, lines]) => [
				name,
				Math.floor(this.total * (0.5 / count + (all === 0 ? 0.5 / count : (0.5 * lines) / all))),
			]),
		);
	}

	private keyOf(lens: Lens): string {
		return lens.scope === "" ? lens.name : `${lens.name} in ${lens.scope}`;
	}

	routed(
		config: MelianConfig,
		lenses: readonly Lens[],
		files: readonly ChangedFile[],
	): { config: MelianConfig; lenses: readonly Lens[] } {
		const design = lenses.find((lens) => lens.name === "design" && lens.scope === "");
		if (design === undefined)
			throw new Error(
				"The parity arm gives every lens the design lens's tool ceiling and findings budget, and the policy commit loads no design lens at its root",
			);
		const ceiling = (design.levels.deep ?? design.levels.careful).budget;
		const shares = this.shares(config, lenses, files);
		const routedConfig = pinnedConfig(config, "high");
		const routedLenses = lenses.map((lens) => {
			const share = shares.get(this.keyOf(lens));
			if (share === undefined) return lens;
			const base = lens.levels.deep ?? lens.levels.careful;
			const probe = base.probe ?? (lens.probeRefusal() === undefined ? {} : undefined);
			const parity: LensLevel = {
				...base,
				budget: {
					findings: Math.max(base.budget.findings, ceiling.findings),
					tokens: probe === undefined ? share : Math.floor(share / 2),
					tools: ceiling.tools,
					ended: "count",
				},
				...(probe === undefined ? {} : { probe }),
			};
			const graphed = lensGraphToolNames.every((tool) => lens.tools.includes(tool));
			const fields = lens.toJSON();
			return Lens.from({
				...fields,
				tools: [...new Set([...lens.tools, ...lensGraphToolNames])],
				instructions: graphed ? fields.instructions : `${fields.instructions}\n\n${graphGuidance}`,
				levels: { careful: parity, deep: parity },
			});
		});
		return { config: routedConfig, lenses: routedLenses };
	}
}

/** One stage of a measured review, with its tokens counted both ways and what a cut lens had left. */
export interface ParityStage {
	readonly name: string;
	readonly subject: string;
	/**
	 * For a lens, the level triage picked, as its subject names it. In the parity arm the name is nominal: every level
	 * the arm declares runs the same settings, which `limit`, `toolLimit` and `effort` record.
	 */
	readonly level?: string;
	readonly role?: "planner" | "prober";
	readonly outcome: string;
	/** The models that answered it; more than one means a model failed over, which stops the run. */
	readonly models: readonly string[];
	/** The reasoning effort its requests asked for, and what the provider reported, each value once in request order. */
	readonly effort: { readonly requested: readonly string[]; readonly reported: readonly string[] };
	/** Every response's input, output, cache reads and cache writes, as a round's Spend line counts. */
	readonly tokens: number;
	readonly cacheRead: number;
	/** Input, cache writes and output, cache reads left out, as Melian's budgets count. */
	readonly budgetTokens: number;
	readonly tools?: number;
	readonly minutes?: number;
	readonly limit?: number;
	readonly toolLimit?: number;
	readonly ended?: "tokens" | "tools";
	/** For a lens its budget ended, the changed files it covered that it was neither shown nor read. */
	readonly unread?: readonly string[];
	/** For a prober its budget ended, the planned attacks it neither probed nor skipped. */
	readonly openAttacks?: number;
	readonly error?: string;
}

/** One arm's attempt to review one miss. Every attempt is saved, so the run's spend is always their sum. */
export interface ParityAttempt {
	readonly miss: string;
	readonly arm: "committed" | "parity";
	readonly said: string;
	readonly found?: boolean;
	/** Whether the review finished, so a failure to judge it still leaves the parity arm its total. */
	readonly reviewed?: true;
	readonly error?: string;
	/** Why the run stopped on this attempt, which scored nothing; a resumed run reviews the arm again. */
	readonly stopped?: string;
	/** Saved before its review starts and replaced once it ends, so a resumed run settles it from its store. */
	readonly pending?: true;
	/** For the parity arm, the tokens its lenses shared, by Melian's budget count. */
	readonly total?: number;
	/** For a parity review its lenses and probers spent past `total`, by how many tokens, which leaves it unscored. */
	readonly overrun?: number;
	readonly tokens: number;
	readonly cacheRead: number;
	readonly budgetTokens: number;
	readonly stages: readonly ParityStage[];
	/** The SQLite file that keeps the review's store, conversations and all, beside the results file. */
	readonly store?: string;
	/** The snapshot ID of Enola's graph of the head, built before the review so its lenses get callers as the CLI's do. */
	readonly graph?: string;
}

/** What a parity run has measured so far, as its results file holds it. */
export interface ParityResults {
	readonly version: 2;
	readonly arm: typeof parityArmName;
	readonly commit: string;
	/** The host every probe ran on, which a probe's answer depends on, so a resume elsewhere would mix two hosts. */
	readonly host: ProbingHost;
	/** The commit whose policy, standards and lenses reviewed every miss, in both arms. */
	readonly policyCommit: string;
	/** The verifier's model, when MELIAN_EVAL_VERIFIER_MODEL named one. */
	readonly verifier?: string;
	/** What each miss named when the run first reviewed it, so a resume refuses a miss that has since changed. */
	readonly misses: Readonly<Record<string, ParityMiss>>;
	readonly attempts: readonly ParityAttempt[];
	readonly stopped?: string;
}

/** A miss as the run first reviewed it, at resolved commits. */
export interface ParityMiss {
	readonly repo: string;
	readonly base: string;
	readonly head: string;
	readonly file: string;
	readonly rules: readonly string[];
	readonly lines: readonly [number, number];
}

/** The runners a parity measurement calls, so a test can stand in for providers and clones. */
export interface ParityRunners {
	readonly availability: () => Promise<ProbeAvailability>;
	readonly models: () => Promise<ReviewModels>;
	readonly range: (target: ReviewTarget, mode: LiveGoldenMode) => Promise<RangeRun>;
	/** Builds and caches Enola's graph of the target's head, returning its snapshot ID. */
	readonly graph: (target: ReviewTarget) => Promise<string>;
	/** Whether the target's graph is already cached, for the dry run. */
	readonly graphCached: (target: ReviewTarget) => Promise<boolean>;
	/** The checkout's commit, refusing a checkout that holds uncommitted changes or one of `artefacts`. */
	readonly commit: (artefacts: readonly string[]) => string;
	/** The host this process's probes run on. */
	readonly host: () => ProbingHost;
}

function tokensInt(env: NodeJS.ProcessEnv, name: string): number {
	const value = Number(env[name]);
	if (env[name] === undefined || !Number.isInteger(value) || value < 1)
		throw new Error(`${name} must be a positive whole number of tokens`);
	return value;
}

// The one reader of a review's spend. A model stage whose usage the telemetry did not measure, by the pipeline's own
// rule, leaves the review unmeasured, never counted as nothing.
function measuredSpend(
	telemetry: StageTelemetry,
	paths: readonly string[],
): { stages: ParityStage[]; unmeasured: string[] } {
	const unmeasured = telemetry
		.runDetails()
		.stages.filter((row) => row.usageIncomplete === true)
		.map((row) => row.name);
	return { stages: measuredStages(telemetry, paths), unmeasured };
}

function measuredStages(telemetry: StageTelemetry, paths: readonly string[]): ParityStage[] {
	return telemetry.stages.map((stage: Stage) => {
		const tokens = stage.usage?.total.totalTokens ?? 0;
		const cacheRead = stage.usage?.total.cacheRead ?? 0;
		const total = stage.usage?.total;
		const budgetTokens = total === undefined ? 0 : total.input + total.cacheWrite + total.output;
		const unread =
			stage.ended === undefined || stage.coverage === undefined || stage.role === "prober"
				? undefined
				: paths.filter(
						(path) =>
							lensCovers(stage.coverage!, path) &&
							!stage.shown?.includes(path) &&
							!stage.read?.some((read) => read.path === path),
					);
		const requests = stage.usage?.requests ?? [];
		const probes = stage.probes;
		const openAttacks =
			stage.ended === undefined || probes === undefined
				? undefined
				: probes.attacks - new Set([...probes.runs.map((each) => each.attack), ...probes.skipped]).size;
		return {
			name: stage.name,
			subject: stage.subject,
			...(stage.name === "melian.lens" ? { level: stage.subject.slice(stage.subject.lastIndexOf("@") + 1) } : {}),
			...(stage.role === undefined ? {} : { role: stage.role }),
			outcome: stage.outcome,
			models: Object.keys(stage.usage?.models ?? {}),
			effort: {
				requested: [...new Set(requests.map(({ reasoning }) => reasoning.requested))],
				reported: [...new Set(requests.flatMap(({ reasoning }) => reasoning.providerReported ?? []))],
			},
			tokens,
			cacheRead,
			budgetTokens,
			...(stage.tools === undefined ? {} : { tools: stage.tools }),
			...(stage.durationMs === undefined ? {} : { minutes: stage.durationMs / 60_000 }),
			...(stage.limits?.tokens === undefined ? {} : { limit: stage.limits.tokens }),
			...(stage.limits?.tools === undefined ? {} : { toolLimit: stage.limits.tools }),
			...(stage.ended === undefined ? {} : { ended: stage.ended }),
			...(unread === undefined ? {} : { unread }),
			...(openAttacks === undefined ? {} : { openAttacks }),
			...(stage.error === undefined ? {} : { error: stage.error }),
		};
	});
}

// The words the pipeline gives a lens, prober or verifier whose route reaches no model it holds credentials for. Every
// route is held to its first model, so a missing credential leaves the same stage unrun on every later miss.
const unrouted = /\bwith credentials\b/;

// Why the run must stop after this review: a provider said its usage limit was reached, a stage's route reached no
// model with credentials, or a lens answered on a model other than its route's first, which with every route held to
// its first model only a failover does and which is the earliest sign of that limit. Fallbacks are equivalent in a
// real round; here both arms must answer on the same models to be compared.
function stopCause(
	run: RangeRun | undefined,
	telemetry: StageTelemetry | undefined,
	error: string | undefined,
): string | undefined {
	const cause = (text: string) =>
		isProviderLimit(text)
			? "a provider's usage limit"
			: unrouted.test(text)
				? "no model with credentials"
				: undefined;
	if (error !== undefined && cause(error) !== undefined) return `${cause(error)}: ${error}`;
	for (const stage of telemetry?.stages ?? []) {
		if (stage.error !== undefined && cause(stage.error) !== undefined)
			return `${cause(stage.error)} in ${stage.subject}: ${stage.error}`;
		const models = Object.keys(stage.usage?.models ?? {});
		if (models.length > 1) return `${stage.subject} answered on ${models.join(" and ")}, so a model failed over`;
	}
	for (const { name, reason } of run?.verdict.notRun ?? [])
		if (reason !== undefined && cause(reason) !== undefined) return `${cause(reason)} in ${name}: ${reason}`;
	return undefined;
}

// The yardstick: what the committed arm's lens conversations spent, planners included. Probers, triage, verification
// and the walkthrough are left out, so the parity arm's lenses and probers together never spend more than this.
const lensSpend = (stage: ParityStage) => stage.name === "melian.lens" && stage.role !== "prober";
const budgeted = (stages: readonly ParityStage[]) => stages.reduce((sum, stage) => sum + stage.budgetTokens, 0);

// What each kind of stage spent by Melian's budget count, so a reader sees the whole review beside the lenses' total.
function stageSpend(stages: readonly ParityStage[]): string {
	const kinds: [string, (stage: ParityStage) => boolean][] = [
		["lenses", lensSpend],
		["probers", (stage) => stage.role === "prober"],
		["triage", (stage) => stage.name === "melian.triage"],
		["verification", (stage) => stage.name.startsWith("melian.verification")],
		["walkthrough", (stage) => stage.name === "melian.walkthrough"],
	];
	return kinds.map(([kind, of]) => `${kind} ${budgeted(stages.filter(of))}`).join(", ");
}

/**
 * Runs the committed arm and then the parity arm on each miss, the parity arm's lenses sharing what the committed arm's
 * lenses spent, cache reads left out. Saves after every review, and resumes from the results file a stopped run left,
 * skipping what it finished. Stops cleanly before a review once the run's tokens reach its stop, after a review whose
 * tokens passed the review stop, and on the first sign of a provider's usage limit. Returns 0 when every review scored,
 * 1 when one did not, 2 when the run never started, and 3 when it stopped with reviews left.
 */
export async function measureParity(
	env: NodeJS.ProcessEnv,
	runners: ParityRunners,
	print: Print,
	printError: Print,
): Promise<0 | 1 | 2 | 3> {
	const held: { lock?: ResultsLock } = {};
	try {
		return await measureHeld(env, runners, print, printError, held);
	} catch (thrown) {
		if (!(thrown instanceof LostLock)) throw thrown;
		printError(visibleText(thrown.message));
		return 2;
	} finally {
		held.lock?.close();
	}
}

class LostLock extends Error {}

// Two runs on one results file would each save over the other's attempts, so a run holds the file from before it reads
// it until it ends. A lock a run that died left stays, and the next run refuses until a person removes it. The lock
// carries a claim of this run's own, so a run whose lock another took saves nothing and leaves that lock in place.
class ResultsLock {
	readonly path: string;
	readonly file: string;
	private readonly claim: string;

	private constructor(file: string, claim: string) {
		this.file = file;
		this.path = `${file}.lock`;
		this.claim = claim;
	}

	// Keyed by the file, not the name it was given, so a run that names the held file through a link is refused too,
	// and the run reads and saves that file, so its save never turns the link into a file another run could lock apart.
	static take(out: string): ResultsLock {
		let real: string;
		try {
			real = realpathSync(out);
		} catch {
			real = join(realpathSync(dirname(out)), basename(out));
		}
		const path = `${real}.lock`;
		const claim = `${process.pid} ${randomUUID()}\n`;
		try {
			writeFileSync(path, claim, { flag: "wx" });
		} catch (thrown) {
			if ((thrown as NodeJS.ErrnoException).code !== "EEXIST") throw thrown;
			const run = ResultsLock.claimant(path);
			throw new Error(
				run === undefined
					? `${path} is not a lock this measurement wrote, so it cannot say which run holds ${out}; if no run is using it, removing it lets this one start`
					: `${path} says run ${run} holds ${out}; if no run is using it, a run that died left it, and removing it lets this one start`,
			);
		}
		return new ResultsLock(real, claim);
	}

	// The refusal prints what the path holds, so it reads only a regular file, opened without following a link, and
	// only one that reads whole as a claim; anything else could be a link to a file whose text is private.
	private static claimant(path: string): string | undefined {
		let fd: number;
		try {
			fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch {
			return undefined;
		}
		try {
			if (!fstatSync(fd).isFile()) return undefined;
			return /^(\d+) [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/.exec(
				readFileSync(fd, "utf8"),
			)?.[1];
		} finally {
			closeSync(fd);
		}
	}

	// Read and then acted on: a lock deleted while its run lives, and taken by a second run between the read and the act,
	// lets the first run save over the second's results or remove its lock. Delete a lock only once its run is gone.
	holds(): boolean {
		try {
			return readFileSync(this.path, "utf8") === this.claim;
		} catch {
			return false;
		}
	}

	check(out: string): void {
		if (!this.holds())
			throw new LostLock(
				`${this.path} no longer holds this run's claim, so another run may own ${out}; this run stopped without saving`,
			);
	}

	close(): void {
		if (this.holds()) rmSync(this.path, { force: true });
	}
}

async function measureHeld(
	env: NodeJS.ProcessEnv,
	runners: ParityRunners,
	print: Print,
	printError: Print,
	held: { lock?: ResultsLock },
): Promise<0 | 1 | 2 | 3> {
	let out: string;
	let stops: { review: number; run: number };
	let verifier: string | undefined;
	let misses: {
		miss: Miss;
		target: ReviewTarget & { readonly head: string };
		location: MissLocation;
		lenses: readonly string[];
		paths: readonly string[];
		revision: string;
	}[];
	let results: ParityResults;
	let settled: { results: ParityResults; unmeasured?: string } | undefined;
	let policyCommit: string;
	try {
		out = env.MELIAN_EVAL_PARITY_OUT ?? "";
		if (out === "") throw new Error("MELIAN_EVAL_PARITY_OUT must name the results file a stopped run resumes from");
		if (env.MELIAN_EVAL_MISSES === undefined || env.MELIAN_EVAL_MISSES === "")
			throw new Error("MELIAN_EVAL_MISSES must name the misses file");
		stops = {
			review: tokensInt(env, "MELIAN_EVAL_PARITY_STOP_REVIEW"),
			run: tokensInt(env, "MELIAN_EVAL_PARITY_STOP_RUN"),
		};
		if (env.MELIAN_EVAL_VERIFIER_MODEL) {
			const { provider, modelId } = parseModelReference(
				env.MELIAN_EVAL_VERIFIER_MODEL,
				"verifier",
				"MELIAN_EVAL_VERIFIER_MODEL",
			);
			verifier = `${provider}/${modelId}`;
		}
		const trust = ProbeTrust.parse(env.MELIAN_EVAL_PROBE_TRUST);
		const named = (env.MELIAN_EVAL_PARITY_MISSES ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name !== "");
		const loaded = Miss.load(env.MELIAN_EVAL_MISSES);
		const unknown = named.filter((name) => !loaded.some((miss) => miss.name === name));
		if (unknown.length > 0)
			throw new Error(`MELIAN_EVAL_PARITY_MISSES names no miss called ${unknown.map(visibleText).join(", ")}`);
		const chosen = named.length === 0 ? loaded : loaded.filter((miss) => named.includes(miss.name));
		const unlined = chosen.filter((miss) => miss.lines === undefined).map(({ name }) => visibleText(name));
		if (unlined.length > 0)
			throw new Error(
				`A whole review scores a miss only on its hand-entered lines, which ${unlined.join(", ")} lack`,
			);
		const policyName = env.MELIAN_EVAL_POLICY_COMMIT ?? "";
		if (policyName === "")
			throw new Error(
				"MELIAN_EVAL_POLICY_COMMIT must name the commit whose policy reviews every miss, such as main, so both arms measure one policy",
			);
		misses = [];
		const refusals: string[] = [];
		const policies = new Set<string>();
		for (const miss of chosen) {
			let target: ReviewTarget & { readonly head: string };
			try {
				target = miss.target(trust, "whole", [], policyName);
			} catch (thrown) {
				refusals.push(
					`refused ${visibleText(miss.name)}, commit unresolved: ${(thrown instanceof Error ? thrown.message : String(thrown)).split("\n")[0]}`,
				);
				continue;
			}
			policies.add(target.policy!);
			if (!target.writer.trusted) {
				refusals.push(
					`refused ${visibleText(miss.name)}, unvouched: MELIAN_EVAL_PROBE_TRUST does not vouch for its base, head and policy commit, so its probes cannot run`,
				);
				continue;
			}
			const reviewers = await miss.reviewers(target, "whole");
			if ("refusal" in reviewers) {
				refusals.push(`refused ${visibleText(miss.name)}, ${reviewers.check}: ${reviewers.refusal}`);
				continue;
			}
			const { revision } = await Changeset.resolve(target.repo, target.range);
			misses.push({
				miss,
				target,
				location: await miss.locate(target.head),
				lenses: reviewers.lenses,
				paths: revision.paths(),
				revision: Revision.key(revision),
			});
		}
		if (policies.size > 1)
			throw new Error(
				`MELIAN_EVAL_POLICY_COMMIT ${visibleText(policyName)} names ${[...policies].join(" and ")} in the misses' clones, so the run would measure more than one policy`,
			);
		policyCommit = [...policies][0] ?? "";
		const counted = `${misses.length} of ${chosen.length} misses can be scored under ${policyCommit || visibleText(policyName)}`;
		if (env.MELIAN_EVAL_PARITY_DRY === "1") {
			for (const { miss, lenses, target } of misses) {
				print(visibleText(`scorable ${miss.name}: ${lenses.join(", ")}`));
				print(
					visibleText(
						(await runners.graphCached(target))
							? `    Enola's graph of ${miss.name}'s head is cached`
							: `    Enola's graph of ${miss.name}'s head needs building before its reviews`,
					),
				);
			}
			for (const refusal of refusals) print(visibleText(refusal));
			print(visibleText(counted));
			return 0;
		}
		if (refusals.length > 0) {
			for (const line of [...refusals, counted]) printError(visibleText(line));
			return 2;
		}
		const availability = await runners.availability();
		if (!availability.available) throw new Error(`Probes cannot run on this host: ${availability.reason}`);
		const commit = runners.commit([out, env.MELIAN_EVAL_MISSES]);
		const host = runners.host();
		const identities = Object.fromEntries(
			misses.map(({ miss, target }) => [
				miss.name,
				{
					repo: target.repo,
					base: target.base,
					head: target.head,
					file: miss.file,
					rules: miss.rules,
					lines: miss.lines!,
				},
			]),
		);
		held.lock = ResultsLock.take(out);
		out = held.lock.file;
		if (existsSync(out)) {
			const earlier = JSON.parse(readFileSync(out, "utf8")) as ParityResults;
			if (earlier.version !== 2 || earlier.arm !== parityArmName)
				throw new Error(`${out} is not a results file of this measurement`);
			if (earlier.commit !== commit)
				throw new Error(
					`${out} was measured at ${earlier.commit}, not this checkout's ${commit}; resume from that commit or name a new file`,
				);
			if (JSON.stringify(earlier.host) !== JSON.stringify(host))
				throw new Error(
					`${out} probed on ${JSON.stringify(earlier.host)}, not this host's ${JSON.stringify(host)}; resume on that host or name a new file`,
				);
			if (earlier.policyCommit !== policyCommit)
				throw new Error(
					`${out} was measured under ${earlier.policyCommit ?? "each miss's base"}'s policy, not ${policyCommit}'s; resume under that policy or name a new file`,
				);
			if (earlier.verifier !== verifier)
				throw new Error(
					`${out} was verified on ${earlier.verifier ?? "the verifier's route"}, not ${verifier ?? "the verifier's route"}; resume with the same verifier or name a new file`,
				);
			for (const { miss } of misses)
				if (
					earlier.attempts.some((attempt) => attempt.miss === miss.name) &&
					JSON.stringify(earlier.misses[miss.name]) !== JSON.stringify(identities[miss.name])
				)
					throw new Error(
						`${out} reviewed ${miss.name} as another miss, at another base, head, file, rules or lines; resume with the same misses or name a new file`,
					);
			const { stopped: _, ...kept } = earlier;
			results = { ...kept, misses: { ...earlier.misses, ...identities } };
			settled = await settle(results, misses, out);
			results = settled.results;
		} else
			results = {
				version: 2,
				arm: parityArmName,
				commit,
				host,
				policyCommit,
				...(verifier === undefined ? {} : { verifier }),
				misses: identities,
				attempts: [],
			};
	} catch (error) {
		printError(visibleText(error instanceof Error ? error.message : String(error)));
		return 2;
	}
	// Written whole through a rename, so a cut run leaves every review it finished, never a torn file. The temporary
	// file is created afresh, so a file or link planted at its path fails the save rather than receiving it.
	const save = () => {
		held.lock!.check(out);
		const written = `${out}.${process.pid}.tmp`;
		writeFileSync(written, `${JSON.stringify(results, null, 2)}\n`, { flag: "wx" });
		renameSync(written, out);
	};
	const stop = (reason: string): 3 => {
		results = { ...results, stopped: reason };
		save();
		print(visibleText(`stopped: ${reason}; resume with the same MELIAN_EVAL_PARITY_OUT`));
		return 3;
	};
	save();
	if (settled?.unmeasured !== undefined) return stop(settled.unmeasured);
	const models = await runners.models();
	const spent = () => results.attempts.reduce((sum, attempt) => sum + attempt.tokens, 0);
	const budgetSpent = () => results.attempts.reduce((sum, attempt) => sum + attempt.budgetTokens, 0);
	const finished = (name: string, arm: "committed" | "parity") =>
		results.attempts.find((attempt) => attempt.miss === name && attempt.arm === arm && attempt.stopped === undefined);
	// One build per miss serves both arms, which review the same head.
	const graphs = new Map<string, string>();
	for (const { miss, target, location, lenses, paths } of misses) {
		for (const arm of ["committed", "parity"] as const) {
			if (finished(miss.name, arm) !== undefined) continue;
			let route: ProbingRoute = new CommittedArm();
			let total: number | undefined;
			if (arm === "parity") {
				const committed = finished(miss.name, "committed")!;
				total = budgeted(committed.stages.filter(lensSpend));
				const unrun =
					committed.reviewed === undefined
						? "not run: the committed arm had no review"
						: total < 1
							? "not run: the committed arm's lenses spent nothing"
							: undefined;
				if (unrun !== undefined) {
					results = {
						...results,
						attempts: [
							...results.attempts,
							{
								miss: miss.name,
								arm,
								said: unrun,
								tokens: 0,
								cacheRead: 0,
								budgetTokens: 0,
								stages: [],
							},
						],
					};
					save();
					continue;
				}
				route = new ParityArm(total);
			}
			if (spent() >= stops.run)
				return stop(`the run's ${spent()} tokens reached MELIAN_EVAL_PARITY_STOP_RUN, ${stops.run}`);
			let graph = graphs.get(miss.name);
			if (graph === undefined) {
				try {
					graph = await runners.graph(target);
				} catch (thrown) {
					const error = thrown instanceof Error ? thrown.message : String(thrown);
					results = {
						...results,
						attempts: [
							...results.attempts,
							{
								miss: miss.name,
								arm,
								said: `no score: Enola's graph of the head could not be built, and a review without its callers is not today's Melian: ${error}`,
								error,
								tokens: 0,
								cacheRead: 0,
								budgetTokens: 0,
								stages: [],
							},
						],
					};
					save();
					print(visibleText(`${parityLabel(arm)} ${miss.name}: ${results.attempts.at(-1)!.said}`));
					continue;
				}
				graphs.set(miss.name, graph);
			}
			// A review a stop cut keeps its store too, so a resumed review takes the next free name.
			const stores = `${out}.stores`;
			mkdirSync(stores, { recursive: true });
			const stem = `${miss.name.replace(/[^A-Za-z0-9._-]/g, "_")}-${arm}`;
			let attempt = 1;
			const storeOf = () => join(stores, attempt === 1 ? `${stem}.sqlite` : `${stem}.${attempt}.sqlite`);
			while (existsSync(storeOf()) || results.attempts.some((each) => each.store === storeOf())) attempt += 1;
			const store = storeOf();
			results = {
				...results,
				attempts: [
					...results.attempts,
					{
						...endedDuring(miss.name, arm),
						pending: true,
						tokens: 0,
						cacheRead: 0,
						budgetTokens: 0,
						stages: [],
						store,
						graph,
					},
				],
			};
			save();
			const mode: LiveGoldenMode = {
				store,
				kind: "live",
				models,
				probing: route,
				...(verifier === undefined ? {} : { verifierModel: verifier }),
			};
			let run: RangeRun | undefined;
			let error: string | undefined;
			// A review that failed part-way still spent what its telemetry recorded.
			let telemetry: StageTelemetry | undefined;
			try {
				run = await runners.range(target, mode);
				telemetry = run.telemetry;
			} catch (thrown) {
				error = thrown instanceof Error ? thrown.message : String(thrown);
				if (thrown instanceof GoldenRunError) telemetry = thrown.telemetry;
			}
			const { stages, unmeasured } =
				telemetry === undefined ? { stages: [], unmeasured: [] } : measuredSpend(telemetry, paths);
			const tokens = stages.reduce((sum, stage) => sum + stage.tokens, 0);
			const cacheRead = stages.reduce((sum, stage) => sum + stage.cacheRead, 0);
			const budgetTokens = budgeted(stages);
			const cause =
				stopCause(run, telemetry, error) ??
				(unmeasured.length === 0 ? undefined : `usage its telemetry did not measure, in ${unmeasured.join(", ")}`);
			const stopped = cause === undefined ? undefined : `${parityLabel(arm)} on ${miss.name} met ${cause}`;
			// A share is a soft limit, so what keeps the arm within its total is this sum of what was recorded.
			const lensTokens = budgeted(stages.filter((stage) => stage.name === "melian.lens"));
			const overrun = total !== undefined && lensTokens > total ? lensTokens - total : undefined;
			let judged: { said: string; found?: boolean } =
				stopped === undefined ? { said: `no score: ${error}` } : { said: "not scored: the run stopped" };
			if (run !== undefined && stopped === undefined && overrun !== undefined)
				judged = {
					said: `not scored: its lenses and probers spent ${lensTokens} tokens by Melian's budget count, ${overrun} past its total of ${total}, since a share is a soft limit and the request that crosses it finishes`,
				};
			else if (run !== undefined && stopped === undefined) {
				try {
					judged = await miss.judge(run, miss.match(run, location, "whole"), target, location, lenses);
				} catch (thrown) {
					error = thrown instanceof Error ? thrown.message : String(thrown);
					judged = { said: `no score: ${error}` };
				}
			}
			results = {
				...results,
				attempts: [
					...results.attempts.filter((each) => each.store !== store),
					{
						miss: miss.name,
						arm,
						said: judged.said,
						...(judged.found === undefined ? {} : { found: judged.found }),
						...(run === undefined ? {} : { reviewed: true }),
						...(error === undefined ? {} : { error }),
						...(stopped === undefined ? {} : { stopped }),
						...(total === undefined ? {} : { total }),
						...(overrun === undefined ? {} : { overrun }),
						tokens,
						cacheRead,
						budgetTokens,
						stages,
						store,
						graph,
					},
				],
			};
			if (stopped !== undefined) return stop(stopped);
			save();
			print(
				visibleText(
					`${parityLabel(arm)} ${miss.name}: ${judged.said}; ${tokens} tokens, ${cacheRead} of them cache reads, ${budgetTokens} by Melian's budget count; run so far ${spent()} tokens, ${budgetSpent()} by Melian's budget count`,
				),
			);
			print(
				visibleText(
					`    by Melian's budget count: ${stageSpend(stages)}${arm === "committed" ? "; the lenses' spend is the parity arm's total" : ""}`,
				),
			);
			for (const stage of stages.filter((each) => each.ended !== undefined))
				print(
					visibleText(
						`    ${stage.subject}${stage.role === "prober" ? " prober" : ""} ended at its ${stage.ended} share of ${stage.limit ?? "no limit"}${stage.unread === undefined ? "" : `, ${stage.unread.length} covered files unread`}${stage.openAttacks === undefined ? "" : `, ${stage.openAttacks} attacks open`}`,
					),
				);
			if (tokens > stops.review)
				return stop(
					`${parityLabel(arm)} on ${miss.name} spent ${tokens} tokens, past MELIAN_EVAL_PARITY_STOP_REVIEW, ${stops.review}`,
				);
		}
	}
	const unfinished = Object.keys(results.misses).find((name) =>
		(["committed", "parity"] as const).some((arm) => finished(name, arm) === undefined),
	);
	if (unfinished !== undefined)
		return stop(`${unfinished} is not yet reviewed in both arms; resume with it in MELIAN_EVAL_PARITY_MISSES`);
	return results.attempts.every((attempt) => attempt.stopped !== undefined || attempt.found !== undefined) ? 0 : 1;
}

function endedDuring(
	miss: string,
	arm: "committed" | "parity",
): Pick<ParityAttempt, "miss" | "arm" | "said" | "stopped"> {
	return {
		miss,
		arm,
		said: "not scored: the run ended during this review",
		stopped: `${parityLabel(arm)} on ${miss} ended with the run, during its review`,
	};
}

// Each attempt a run ended during counts what its store recorded, the one account of that review's spend; a store the
// review never opened spent nothing, and one that cannot be read refuses the resume rather than count it as nothing.
async function settle(
	results: ParityResults,
	misses: readonly { miss: Miss; paths: readonly string[]; revision: string }[],
	out: string,
): Promise<{ results: ParityResults; unmeasured?: string }> {
	let unmeasured: string | undefined;
	const attempts: ParityAttempt[] = [];
	for (const attempt of results.attempts) {
		if (attempt.pending === undefined) {
			attempts.push(attempt);
			continue;
		}
		const chosen = misses.find(({ miss }) => miss.name === attempt.miss);
		if (chosen === undefined)
			throw new Error(
				`${out} holds a review of ${attempt.miss} that the run ended during; resume with ${attempt.miss} among MELIAN_EVAL_PARITY_MISSES to settle it`,
			);
		const { pending: _, ...kept } = attempt;
		if (attempt.store === undefined || !existsSync(attempt.store)) {
			attempts.push(kept);
			continue;
		}
		let telemetry: StageTelemetry;
		try {
			const storage = await openSqliteStorage(attempt.store);
			try {
				telemetry = await TelemetryReader.open(storage).read(chosen.revision);
			} finally {
				await storage.close(backgroundContext);
			}
		} catch (thrown) {
			throw new Error(
				`Cannot read ${attempt.store}, the store of a review the run ended during, so its spend is unknown: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
			);
		}
		const { stages, unmeasured: missing } = measuredSpend(telemetry, chosen.paths);
		attempts.push({
			...kept,
			tokens: stages.reduce((sum, stage) => sum + stage.tokens, 0),
			cacheRead: stages.reduce((sum, stage) => sum + stage.cacheRead, 0),
			budgetTokens: budgeted(stages),
			stages,
		});
		if (missing.length > 0)
			unmeasured = `${attempt.stopped}, and its store did not measure usage in ${missing.join(", ")}`;
	}
	return { results: { ...results, attempts }, ...(unmeasured === undefined ? {} : { unmeasured }) };
}

function parityLabel(arm: "committed" | "parity"): string {
	return arm === "committed" ? "committed" : parityArmName;
}

/**
 * The checkout's commit, which a results file is tied to so a resumed run measures the same code. Throws when the
 * checkout has changes no commit holds, since then no commit names the code that ran, or when one of `artefacts`, the
 * files the run reads and writes, lies inside it, since writing them would leave such changes.
 */
export function checkoutCommit(directory: string, artefacts: readonly string[]): string {
	// Git's stderr is captured, not inherited, so a directory's control bytes reach the terminal only escaped.
	const git = (...args: string[]) => {
		try {
			return execFileSync("git", ["-C", directory, ...args], {
				encoding: "utf8",
				env: gitEnvironment(),
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (thrown) {
			throw new Error(visibleText(thrown instanceof Error ? thrown.message : String(thrown)));
		}
	};
	const root = git("rev-parse", "--show-toplevel").trim();
	for (const artefact of artefacts) {
		const path = resolve(artefact);
		let real = path;
		try {
			real = join(realpathSync(dirname(path)), basename(path));
		} catch {}
		const from = relative(root, real);
		if (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from))
			throw new Error(
				`${real} is inside the checkout ${root}, which the run must leave unchanged; name a path outside it`,
			);
	}
	const dirty = git("status", "--porcelain", "--untracked-files=normal").trimEnd();
	if (dirty !== "")
		throw new Error(`The checkout has changes no commit holds, so no commit names the code that ran:\n${dirty}`);
	return git("rev-parse", "HEAD").trim();
}

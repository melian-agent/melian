import {
	everyRecordCounts,
	Lens,
	loadConfig,
	RecordError,
	Rendering,
	reviewPayloads,
	TierAccount,
} from "@melian-agent/core";
import { ChangeLenses, RecordGate } from "@melian-agent/pipeline";
import { GitRecordStore } from "@melian-agent/state-git";
import { type Io, ReviewSource, reviewExitCodes, terminalEmoji } from "./commands.ts";
import { CliError, fromCheckout, git, stateDirectory } from "./repository.ts";
import { checkExpected, fetchedPullRequest, gitHubFor, parseTarget } from "./target.ts";

/**
 * Whether a pull request's head may merge into its base tip now, from the shared records on `melian/state` alone, under
 * the base tip's policy. It prints the merged verdict, each round it counted and why that round covers the merge or
 * not, and the command that clears each reason it cannot pass. It writes nothing anywhere. It exits 0 when the head may
 * merge, 1 when a finding blocks or awaits an answer, and 2 when the records do not review the merge.
 */
export async function gate(io: Io, argument: string): Promise<number> {
	const target = parseTarget(argument);
	if (target.kind !== "pullRequest") throw new CliError(`gate takes a pull request such as "#12"`);
	const provider = await gitHubFor(io.cwd, io.env);
	const { pullRequest, changeset } = await fetchedPullRequest(io.cwd, provider, target.number);
	const tip = pullRequest.base.sha;
	await checkExpected(pullRequest, changeset, { base: tip, head: pullRequest.head.sha }, "nothing was decided");
	const { repoRoot, revision } = changeset;
	const source = { kind: "revision", commit: tip } as const;
	if (!(await ReviewSource.of(changeset, source).trustsWriters()))
		throw new CliError(
			"the base tip's melian.yaml does not set trust.writers: true, so no record in the store counts",
		);
	const { config } = await loadConfig(repoRoot, source, ".");
	const tier = config.stages["pull-request"] ?? "full";
	const lenses = await Lens.load(repoRoot, source, revision.paths());
	const selection = await ChangeLenses.read({ changeset, lenses, config, tier, policy: source, floor: "quick" });
	const remote = await git(repoRoot, ["remote", "get-url", "origin"]);
	let store: GitRecordStore | undefined;
	let records: Awaited<ReturnType<GitRecordStore["list"]>>;
	try {
		store = await GitRecordStore.open({
			directory: await stateDirectory(repoRoot, io.env),
			remote: fromCheckout(repoRoot, remote),
			payloads: reviewPayloads,
		});
		records = await store.list(changeset.id);
	} catch (error) {
		// A store's message can quote git's own words, which a public log must not carry.
		if (error instanceof RecordError)
			throw new CliError(`melian/state could not be read (${error.code}), so nothing was decided`);
		throw error;
	} finally {
		await store?.close();
	}
	// Only a writer can add to melian/state, and the base tip trusts writers, so every record there counts.
	const outcome = await RecordGate.decide(records, changeset.id, {
		repoRoot,
		target: tip,
		revision,
		config,
		policy: source,
		tier: TierAccount.of(config, tier, selection.tierLenses()),
		counts: everyRecordCounts,
	});
	for (const round of outcome.rounds)
		io.stderr(
			"refused" in round.covers
				? `melian: round ${round.id} counts for its findings and covers no check: it ${round.covers.refused}\n`
				: `melian: round ${round.id} counts, and covers ${round.covers.length} checks\n`,
		);
	for (const reason of outcome.failures) io.stderr(`melian: the records cannot decide the merge: ${reason}\n`);
	for (const ended of outcome.ended)
		io.stderr(
			`melian: finding ${ended.finding} is live: it was dismissed at revision ${ended.madeAt}, and round ${ended.round} reviewed ${ended.at}, as after a push. To dismiss it at this head: melian dismiss ${argument} ${ended.finding} --reason <text> --records git:melian/state\n`,
		);
	if (outcome.verdict.status === "not-reviewed") {
		const stale = outcome.rounds.length > 0 && outcome.rounds.every(({ covers }) => "refused" in covers);
		const why =
			outcome.failures.length > 0
				? "the records cannot decide the merge"
				: stale
					? "no counted round stands as reviewed of the merge's diff as it stands"
					: "no round that stands as reviewed ran every check the base tip's tier requires";
		io.stderr(
			`melian: ${why}. To review it again: gh workflow run melian-round.yml -f pull_request=${target.number}\n`,
		);
	}
	const render = new Rendering({
		color: io.color,
		emoji: await terminalEmoji(io, repoRoot),
		ids: true,
		all: false,
		decided: true,
		target: argument,
	});
	io.stdout(outcome.verdict.render(render));
	if (outcome.passes()) return reviewExitCodes.passed;
	return outcome.verdict.status === "not-reviewed" ? reviewExitCodes.notReviewed : reviewExitCodes.blocking;
}

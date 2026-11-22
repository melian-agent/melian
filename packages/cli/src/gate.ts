import {
	everyRecordCounts,
	Lens,
	loadConfig,
	RecordError,
	Rendering,
	reviewPayloads,
	TierAccount,
	visibleText,
} from "@melian-agent/core";
import { ChangeLenses, RecordGate } from "@melian-agent/pipeline";
import { GitRecordStore } from "@melian-agent/state-git";
import { type Io, ReviewSource, reviewExitCodes, shellQuote, terminalEmoji, writerTrust } from "./commands.ts";
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
	// Without a pinned key the gate cannot tell the trusted host's record of a fork's head from a writer's.
	const writer = await writerTrust(provider, pullRequest);
	if (!writer.trusted)
		throw new CliError(
			`the head is not a writer's (${writer.detail}), and only a record the trusted host's pinned key signed counts for such a head; no key is pinned, so no record in the store counts`,
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
			!("refused" in round.covers)
				? `melian: round ${visibleText(round.id)} counts, and covers ${round.covers.length} checks\n`
				: round.sound
					? `melian: round ${visibleText(round.id)} counts for its findings and covers no check: it ${visibleText(round.covers.refused)}. Its verifier's verdicts stand\n`
					: `melian: round ${visibleText(round.id)} counts for its findings and covers no check: it ${visibleText(round.covers.refused)}. Like a round whose verifier did not finish, it lowers nothing: its findings count as no verifier judged them, uncapped, and no later round's verdict clears one: to answer one, push a fix or dismiss it\n`,
		);
	for (const reason of outcome.failures)
		io.stderr(`melian: the records cannot decide the merge: ${visibleText(reason)}\n`);
	const dismiss = (finding: string) =>
		command("melian", "dismiss", argument, finding, "--reason", "<text>", "--records", "git:melian/state");
	for (const ended of outcome.ended)
		io.stderr(
			`melian: finding ${visibleText(ended.finding)} is live: it was dismissed at revision ${visibleText(ended.madeAt)}, and round ${visibleText(ended.round)} reviewed ${visibleText(ended.at)} since, which ends it: any round of another revision does, a round of this head at another base included, such as a stacked parent's. To dismiss it at this head: ${dismiss(ended.finding)}\n`,
		);
	for (const unjudged of outcome.unjudged)
		io.stderr(
			`melian: finding ${visibleText(unjudged.finding)} is live: dismissal ${visibleText(unjudged.record)} cannot be judged, since round ${visibleText(unjudged.round)} names a record or round the store does not hold. To dismiss it again: ${dismiss(unjudged.finding)}\n`,
		);
	if (outcome.verdict.status === "not-reviewed") {
		const stale = outcome.rounds.every(({ covers }) => "refused" in covers);
		const why =
			outcome.failures.length > 0
				? "the records cannot decide the merge"
				: stale
					? "no counted round stands as reviewed of the merge's diff as it stands"
					: "no round that stands as reviewed ran every check the base tip's tier requires";
		io.stderr(
			`melian: ${why}. To review it again: ${command("gh", "workflow", "run", "melian-round.yml", "-f", `pull_request=${target.number}`)}\n`,
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

// A command to paste into a shell: each word escaped for the terminal, then quoted, since `#` starts a comment and `<` a redirect.
function command(...words: string[]): string {
	return words.map((word) => shellQuote(visibleText(word))).join(" ");
}

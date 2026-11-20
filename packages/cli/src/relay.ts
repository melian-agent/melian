import { resolve } from "node:path";
import { Lens, loadConfig, RecordError, Revision, reviewPayloads, TierAccount } from "@melian-agent/core";
import { ChangeLenses, headCodeChecks, RelayBatch } from "@melian-agent/pipeline";
import { GitRecordStore } from "@melian-agent/state-git";
import { type Io, ReviewSource, writerTrust } from "./commands.ts";
import { CliError, fromCheckout, git, stateDirectory } from "./repository.ts";
import { checkApproved, fetchedPullRequest, gitHubFor, parseTarget } from "./target.ts";

/**
 * Adds the records a pull request's round left in a directory store to the clone's `melian/state`, checked whole by
 * `RelayBatch`. The changeset, revision and whether the head is a fork come from GitHub's answer for the pull request,
 * never from the batch, and the tier its round must account for from the approved base's policy, which the round's review read.
 * With `check`, it checks the batch the same way and writes nothing.
 */
export async function relayRecords(
	io: Io,
	argument: string,
	options: {
		readonly from: string;
		readonly expect: { readonly base: string; readonly head: string };
		readonly check?: boolean;
	},
): Promise<number> {
	const target = parseTarget(argument);
	if (target.kind !== "pullRequest") throw new CliError(`records relay takes a pull request such as "#12"`);
	const provider = await gitHubFor(io.cwd, io.env);
	const { pullRequest, changeset } = await fetchedPullRequest(io.cwd, provider, target.number);
	await checkApproved(pullRequest, changeset, options.expect, "nothing was relayed");
	const { repoRoot } = changeset;
	// The records are judged under the policy that produced them: the approved base, which the round's review read.
	const source = { kind: "revision", commit: options.expect.base } as const;
	if (!(await ReviewSource.of(changeset, source).trustsWriters()))
		throw new CliError("the base's melian.yaml does not set trust.writers: true, so nothing was relayed");
	// A head whose writer Melian cannot establish hands over what a fork's may, which is less.
	const fork = !(await writerTrust(provider, pullRequest)).trusted;
	const { config } = await loadConfig(repoRoot, source, ".");
	const tier = config.stages["pull-request"] ?? "full";
	const lenses = await Lens.load(repoRoot, source, changeset.revision.paths());
	// The floor decides no skip, since neither floor is skip, so the head's trust need not choose it here.
	const selection = await ChangeLenses.read({ changeset, lenses, config, tier, policy: source, floor: "quick" });
	const batch = await RelayBatch.read(resolve(io.cwd, options.from.slice("dir:".length)), {
		changeset: changeset.id,
		revision: Revision.key(changeset.revision),
		fork,
		tier: TierAccount.of(config, tier, selection.tierLenses()),
		handedOver: headCodeChecks,
	});
	if (options.check === true) {
		io.stdout(
			`melian: the relay would add ${batch.records.length} records of pull request #${target.number} to melian/state\n`,
		);
		return 0;
	}
	const remote = await git(repoRoot, ["remote", "get-url", "origin"]);
	let store: GitRecordStore | undefined;
	try {
		store = await GitRecordStore.open({
			directory: await stateDirectory(repoRoot, io.env),
			remote: fromCheckout(repoRoot, remote),
			payloads: reviewPayloads,
		});
		await batch.into(store);
	} catch (error) {
		// A store's message can quote git's own words, which a public log must not carry.
		if (error instanceof RecordError)
			throw new CliError(
				`melian/state refused or failed the relay (${error.code}); repeat the relay, which completes a batch that landed in part`,
			);
		throw error;
	} finally {
		await store?.close();
	}
	io.stdout(`melian: relayed ${batch.records.length} records of pull request #${target.number} to melian/state\n`);
	return 0;
}

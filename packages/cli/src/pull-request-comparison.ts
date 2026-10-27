import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	ComparisonExport,
	MembershipError,
	PullRequestMembership,
	type PullRequestRoundHeads,
	pullRequestChangesetId,
	visibleText,
} from "@melian-agent/core";
import { PullRequestRoundsReader, parseGitHubRemote } from "@melian-agent/github";
import {
	CompareHarness,
	backgroundContext as context,
	PullRequestRoundHistory,
	type PullRequestRoundSnapshot,
} from "@melian-agent/pipeline";
import { gitAuthor, type Io } from "./commands.ts";
import { ComparisonStores } from "./comparison-stores.ts";
import { idleModels } from "./models.ts";
import { CliError, git, openStorage } from "./repository.ts";
import { gitHubAccess } from "./target.ts";

export class PullRequestComparison {
	private readonly io: Io;
	private readonly number: number;
	private readonly changeset: string;
	private readonly stores: ComparisonStores;
	private readonly url: string;
	private readonly repository: PullRequestRoundHeads["repository"];

	private constructor(
		io: Io,
		number: number,
		changeset: string,
		stores: ComparisonStores,
		url: string,
		repository: PullRequestRoundHeads["repository"],
	) {
		this.io = io;
		this.number = number;
		this.changeset = changeset;
		this.stores = stores;
		this.url = url;
		this.repository = repository;
	}
	static async open(io: Io, number: number): Promise<PullRequestComparison> {
		const repository = parseGitHubRemote(await git(io.cwd, ["remote", "get-url", "origin"]));
		const stores = await ComparisonStores.read(io, {
			repository: { owner: repository.owner, name: repository.repo },
			pullRequest: number,
		});
		return new PullRequestComparison(
			io,
			number,
			pullRequestChangesetId("github", { owner: repository.owner, name: repository.repo }, number),
			stores,
			`https://github.com/${repository.owner}/${repository.repo}/pull/${number}`,
			{ owner: repository.owner, name: repository.repo },
		);
	}
	async refresh(accept: boolean): Promise<number> {
		const access = await gitHubAccess(this.stores.repoRoot, this.io.env);
		const answer = await PullRequestRoundsReader.open({ ...access, pullRequest: this.number }).read();
		const membership = await PullRequestMembership.open(this.stores.repoRoot, answer);
		const classified = [];
		const prior = new Set(
			this.stores.histories
				.get(this.changeset)
				?.current()
				?.members.map((round) => round.id),
		);
		for (const candidate of this.stores.candidates) {
			const round = await membership.classify(candidate);
			if (prior.has(round.id) && round.status === "member" && !(await membership.headAvailable(round.head)))
				classified.push({ ...round, status: "unreachable" as const, reason: "head unavailable after fetch" });
			else classified.push(round);
		}
		const by = accept ? await gitAuthor(this.stores.repoRoot, "accepted pull request membership") : "";
		const at = new Date().toISOString();
		PullRequestRoundHistory.from(this.stores.histories.get(this.changeset)?.versions ?? []).refresh(
			answer,
			classified,
			by,
			at,
			accept,
		);
		const path = join(this.stores.directory, `${this.changeset}.sqlite`);
		const harness = await CompareHarness.open(await openStorage(path), idleModels(this.io.env), this.changeset);
		let snapshot: PullRequestRoundSnapshot;
		try {
			snapshot = await harness.refreshMembership(answer, classified, by, at, accept);
		} finally {
			await harness.close(context);
		}
		const previous = this.stores.histories.get(this.changeset)?.current();
		const old = new Set(previous?.members.map((round) => round.id));
		const added = snapshot.members.filter((round) => !old.has(round.id)).length;
		const removed =
			previous?.members.filter((round) => !snapshot.members.some((member) => member.id === round.id)).length ?? 0;
		this.io.stdout(`Membership snapshot ${snapshot.version}: ${added} added, ${removed} removed.\n`);
		this.io.stdout(this.render(snapshot));
		for (const round of snapshot.members) {
			const entry = this.stores.entries.find((entry) => entry.round === round.id);
			if (entry !== undefined) this.io.stdout(`Round ${round.number}:\n${entry.comparison.render(entry.verdict)}`);
		}
		return 0;
	}
	async export(options: { readonly json: boolean; readonly out?: string }): Promise<number> {
		const history = this.stores.histories.get(this.changeset);
		const snapshot = history?.current();
		const ids = new Set(snapshot?.members.map((round) => round.id));
		const memberStores = new Set(snapshot?.members.map((round) => round.id.split(".")[0]));
		const ownership = new Map(
			this.stores.candidates.map((candidate) => [
				candidate.id,
				PullRequestMembership.storedOwnership(candidate, { repository: this.repository, number: this.number }),
			]),
		);
		const conflicts = snapshot?.members.filter((round) => ownership.get(round.id) === false) ?? [];
		if (conflicts.length > 0)
			throw new MembershipError(
				`stored ownership now rejects saved members ${conflicts.map((round) => round.id).join(", ")}; run melian compare refresh "#${this.number}", then --accept if refresh reports a rejection`,
			);
		const owned = new Set(
			this.stores.candidates
				.filter((candidate) => ownership.get(candidate.id) === true)
				.map((candidate) => candidate.id),
		);
		const ownedStores = new Set([...owned].map((id) => id.split(".")[0]));
		const entries = this.stores.entries.filter((entry) =>
			snapshot === undefined
				? entry.changeset === this.changeset &&
					(entry.unattributed !== undefined || ownership.get(entry.round!) !== false)
				: entry.unattributed !== undefined
					? entry.changeset === this.changeset ||
						memberStores.has(entry.changeset) ||
						ownedStores.has(entry.changeset)
					: entry.round !== undefined && (ids.has(entry.round) || owned.has(entry.round)),
		);
		const additional =
			snapshot !== undefined &&
			entries.some((entry) =>
				entry.unattributed !== undefined
					? entry.changeset !== this.changeset && !memberStores.has(entry.changeset)
					: entry.round !== undefined && !ids.has(entry.round),
			);
		const notice =
			snapshot === undefined
				? ""
				: `Additional stored records are included beyond snapshot ${snapshot.version}; membership/history remain as last refreshed; run melian compare "#${this.number}" to refresh.`;
		if (snapshot === undefined && entries.length === 0)
			throw new CliError(`no membership snapshot; run melian compare "#${this.number}" first`);
		if (snapshot !== undefined) {
			const positions = new Map(
				[...ids, ...[...owned].filter((id) => !ids.has(id)).sort()].map((id, index) => [id, index]),
			);
			entries.sort((a, b) => (positions.get(a.round!) ?? -1) - (positions.get(b.round!) ?? -1));
		}
		const comparisons = new ComparisonExport(entries, `#${this.number}`, this.url);
		const record = options.json ? comparisons.renderJson() : comparisons.render();
		const output = options.json
			? snapshot === undefined
				? record
				: `${JSON.stringify({ ...JSON.parse(record), membership: snapshot, history: history!.versions }, null, 2)
						.split("\n")
						.map(visibleText)
						.join("\n")}\n`
			: `${snapshot === undefined ? "" : `${this.render(snapshot)}${additional ? `${visibleText(`Membership as of ${snapshot.at}. Additional records have no snapshot numbers. ${notice}`)}\n` : ""}\n`}${record}`;
		if (options.out === undefined) this.io.stdout(output);
		else {
			const path = resolve(this.io.cwd, options.out);
			await writeFile(path, output, "utf8");
			this.io.stdout(`Exported comparison to ${visibleText(path)}.\n`);
		}
		if (additional) this.io.stderr(`${visibleText(notice)}\n`);
		return 0;
	}
	private render(snapshot: PullRequestRoundSnapshot): string {
		const lines = [
			`Pull request #${this.number}: ${snapshot.members.length} member rounds (snapshot ${snapshot.version}).`,
		];
		for (const round of snapshot.members)
			lines.push(`Round ${round.number}: ${round.id}${round.status === "unreachable" ? " (unreachable)" : ""}`);
		for (const round of [...snapshot.foreign, ...snapshot.ambiguous])
			lines.push(
				`${round.status === "ambiguous" ? "Ambiguous" : "Foreign"}: ${round.id}: ${round.reason}${round.otherPullRequests === undefined ? "" : ` (#${round.otherPullRequests.join(", #")})`}`,
			);
		for (const round of snapshot.unattributed) lines.push(`Unattributed: ${round.id}: ${round.reason}`);
		lines.push(
			`Unattributed rounds in member-holding stores: ${snapshot.unattributed.length}.`,
			...snapshot.warnings,
		);
		return `${lines.map((line) => visibleText(line)).join("\n")}\n`;
	}
}

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ComparisonEntry, type MembershipCandidate, pullRequestChangesetId } from "@melian-agent/core";
import {
	ComparisonReader,
	backgroundContext as context,
	MembershipReader,
	type PullRequestRoundHistory,
} from "@melian-agent/pipeline";
import type { Io } from "./commands.ts";
import { isScripted } from "./models.ts";
import { CliError, git, openStorage, stateDirectory } from "./repository.ts";
import { ChangesetStore } from "./state.ts";

export class ComparisonStores {
	readonly entries: ComparisonEntry[] = [];
	readonly candidates: MembershipCandidate[] = [];
	readonly histories = new Map<string, PullRequestRoundHistory>();
	readonly directory: string;
	readonly repoRoot: string;
	private constructor(repoRoot: string, directory: string) {
		this.repoRoot = repoRoot;
		this.directory = directory;
	}
	static async read(
		io: Io,
		ownership?: MembershipCandidate["publication"],
		histories = ownership !== undefined,
		exporting = false,
	): Promise<ComparisonStores> {
		const repoRoot = await git(io.cwd, ["rev-parse", "--show-toplevel"]);
		const directory = join(await stateDirectory(repoRoot, io.env), ...(isScripted(io.env) ? ["scripted"] : []));
		const result = new ComparisonStores(repoRoot, directory);
		const historyChangeset =
			ownership === undefined
				? undefined
				: pullRequestChangesetId("github", ownership.repository, ownership.pullRequest);
		const names = await readdir(directory).catch((error: NodeJS.ErrnoException): string[] => {
			if (error.code === "ENOENT") return [];
			throw new CliError(`cannot read comparisons at ${directory}: ${error.message}`);
		});
		// A pull request's storage is this clone's copy of the state branch's, unless it kept SQLite from before.
		// A copy's directory is named for its changeset alone; its lock and markers carry a suffix.
		const copies = await readdir(join(directory, "state")).catch((error: NodeJS.ErrnoException): string[] => {
			if (error.code === "ENOENT") return [];
			throw new CliError(`cannot read comparisons at ${join(directory, "state")}: ${error.message}`);
		});
		const changesets = [
			...new Set([
				...names
					.filter((name) => /^(range|pull)-[0-9a-f]{16}\.sqlite$/.test(name))
					.map((name) => name.slice(0, -7)),
				...copies.filter((name) => /^pull-[0-9a-f]{16}$/.test(name)),
			]),
		].sort();
		if (exporting) {
			const own = changesets.indexOf(historyChangeset!);
			if (own < 0) return result;
			changesets.unshift(...changesets.splice(own, 1));
		}
		for (const changeset of changesets) {
			const sqlite = names.includes(`${changeset}.sqlite`);
			const store = sqlite
				? undefined
				: await ChangesetStore.read(io, repoRoot, changeset, directory, {
						skipHeld: changeset !== historyChangeset,
					});
			if (!sqlite && store === undefined) continue;
			const storage = store?.storage ?? (await openStorage(join(directory, `${changeset}.sqlite`)));
			try {
				result.entries.push(...(await ComparisonReader.open(storage).read(changeset)));
				const reader = MembershipReader.open(storage);
				if (ownership !== undefined) result.candidates.push(...(await reader.candidates(changeset, ownership)));
				if (histories && (historyChangeset === undefined || changeset === historyChangeset))
					result.histories.set(changeset, await reader.history());
			} finally {
				await storage.close(context);
				await store?.close();
			}
			if (exporting && result.histories.get(historyChangeset!)?.current() === undefined) break;
		}
		return result;
	}
}

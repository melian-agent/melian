import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ComparisonEntry, MembershipCandidate } from "@melian-agent/core";
import {
	ComparisonReader,
	backgroundContext as context,
	MembershipReader,
	type PullRequestRoundHistory,
} from "@melian-agent/pipeline";
import type { Io } from "./commands.ts";
import { isScripted } from "./models.ts";
import { CliError, git, openStorage, stateDirectory } from "./repository.ts";

/** One detached scan of the command's chosen state directory. */
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
	static async read(io: Io, ownership?: MembershipCandidate["publication"]): Promise<ComparisonStores> {
		const repoRoot = await git(io.cwd, ["rev-parse", "--show-toplevel"]);
		const directory = join(await stateDirectory(repoRoot, io.env), ...(isScripted(io.env) ? ["scripted"] : []));
		const result = new ComparisonStores(repoRoot, directory);
		const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw new CliError(`cannot read comparisons at ${directory}: ${error.message}`);
		});
		for (const name of names.filter((name) => /^(range|pull)-[0-9a-f]{16}\.sqlite$/.test(name)).sort()) {
			const changeset = name.slice(0, -".sqlite".length);
			const storage = await openStorage(join(directory, name));
			try {
				result.entries.push(...(await ComparisonReader.open(storage).read(changeset)));
				const reader = MembershipReader.open(storage);
				result.candidates.push(...(await reader.candidates(changeset, ownership)));
				result.histories.set(changeset, await reader.history());
			} finally {
				await storage.close(context);
			}
		}
		return result;
	}
}

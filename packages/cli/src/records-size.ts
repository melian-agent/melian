import { RecordError } from "@melian-agent/core";
import { GitRecordStore } from "@melian-agent/state-git";
import type { Io } from "./commands.ts";
import { CliError, fromCheckout, git, stateDirectory } from "./repository.ts";

/**
 * Prints the size of the clone's `melian/state` against each of the store's limits, and a warning past half of any,
 * as `melian doctor` does. With `json`, it prints the counts alone, which the `melian round` workflow's comment reads.
 */
export async function recordsSize(io: Io, options: { readonly json: boolean }): Promise<number> {
	const root = await git(io.cwd, ["rev-parse", "--show-toplevel"]);
	const remote = await git(root, ["remote", "get-url", "origin"]);
	let store: GitRecordStore | undefined;
	try {
		store = await GitRecordStore.open({
			directory: await stateDirectory(root, io.env),
			remote: fromCheckout(root, remote),
		});
		const size = await store.size();
		const warning = size.warning();
		io.stdout(
			options.json ? `${JSON.stringify(size)}\n` : `${size.line()}\n${warning === undefined ? "" : `${warning}\n`}`,
		);
		return 0;
	} catch (error) {
		// A store's message can quote git's own words, which a public log must not carry.
		if (error instanceof RecordError)
			throw new CliError(`melian/state's size could not be read (${error.code}); melian doctor says why`);
		throw error;
	} finally {
		await store?.close();
	}
}

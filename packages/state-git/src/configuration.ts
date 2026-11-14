import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RecordError } from "@melian-agent/core";

// The whole of the private repository's own configuration. Anything else in that file, a credential helper, an
// `include.path`, a `url.<base>.insteadOf` or a `core.sshCommand`, would run or redirect under Melian, and no command
// line setting clears every such key, so the bytes themselves are the defence.
export const repositoryConfiguration = "[core]\n\trepositoryformatversion = 0\n\tbare = true\n";

export async function writeConfiguration(repository: string): Promise<void> {
	await writeFile(join(repository, "config"), repositoryConfiguration);
}

export async function checkConfiguration(repository: string): Promise<void> {
	const path = join(repository, "config");
	const found = await readFile(path, "utf8").catch((cause: unknown) => {
		throw new RecordError("unreachable", `${path} cannot be read`, { path, cause });
	});
	if (found !== repositoryConfiguration)
		throw new RecordError(
			"unreachable",
			`${path} holds configuration Melian did not write; delete ${repository} and Melian fetches the branch again`,
			{ path },
		);
}

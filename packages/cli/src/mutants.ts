import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MutationInventory, openSource, SuiteExports } from "@melian-agent/core";
import { MutationEnumeration } from "@melian-agent/pipeline";
import type { Io } from "./commands.ts";
import { pullRequestRefs } from "./repository.ts";
import { fetchedPullRequest, gitHubFor, parseTarget } from "./target.ts";

export async function listMutants(
	io: Io,
	argument: string,
	options: { json: boolean; all: boolean; limit?: number },
): Promise<number> {
	const target = parseTarget(argument);
	let range = argument;
	let policy: { kind: "revision"; commit: string } | undefined;
	let url: string | undefined;
	if (target.kind === "pullRequest") {
		const { pullRequest } = await fetchedPullRequest(io.cwd, await gitHubFor(io.cwd, io.env), target.number);
		range = pullRequestRefs(target.number).range;
		policy = { kind: "revision", commit: pullRequest.base.sha };
		url = pullRequest.url;
	}
	const enumeration = await MutationEnumeration.open(io.cwd, range, { policy, target: url });
	const inventory = await enumeration.list(options);
	io.stdout(`${options.json ? inventory.renderJson() : inventory.renderTable()}\n`);
	return 0;
}

export async function sampleMutants(io: Io, path: string): Promise<number> {
	const inventory = MutationInventory.parse(JSON.parse(await readFile(resolve(io.cwd, path), "utf8")));
	const suites = await SuiteExports.read(await openSource(io.cwd, { kind: "worktree" }));
	io.stdout(`${inventory.renderSampleJson(suites)}\n`);
	return 0;
}

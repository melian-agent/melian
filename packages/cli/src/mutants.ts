import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Changeset, loadConfig, MutantsVerdict, MutationInventory, visibleText } from "@melian-agent/core";
import {
	backgroundContext,
	createNodeExecutionEnv,
	MutationEnumeration,
	type MutantsVerifyRun,
	runMutantsVerify,
} from "@melian-agent/pipeline";
import { type Io, writerTrust } from "./commands.ts";
import { git, pullRequestRefs } from "./repository.ts";
import { fetchedPullRequest, gitHubFor, parseTarget } from "./target.ts";

const answersPath = ".melian/mutants/answers.yaml";

// A file at a commit, or undefined when the commit has none at that path.
async function blob(repoRoot: string, commit: string, path: string): Promise<string | undefined> {
	const listed = await git(repoRoot, ["ls-tree", "-z", commit, "--", path]);
	if (listed === "") return undefined;
	return git(repoRoot, ["show", `${commit}:${path}`]);
}

// The digest an answer names: the head's tree, every entry's mode, type, object and path, less the answers file itself,
// which an answer cannot name without changing.
async function treeDigest(repoRoot: string, head: string): Promise<string> {
	const listing = await git(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", head]);
	const entries = listing.split("\0").filter((entry) => entry !== "" && entry.split("\t")[1] !== answersPath);
	return createHash("sha256").update(entries.join("\0")).digest("hex");
}

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
	io.stdout(`${inventory.renderSampleJson()}\n`);
	return 0;
}

/**
 * `melian mutants verify <range|#pr> <path>...`: runs Stryker once over the changed lines of the listed files and decides
 * from its report and `.melian/mutants/answers.yaml`. Exits 0 when every mutant is caught, noted or answered, 1 when one
 * is not, and 2 when it could not decide.
 */
export async function verifyMutants(
	io: Io,
	argument: string,
	files: readonly string[],
	options: { json: boolean; trustHead: boolean },
): Promise<number> {
	const undecided = (reason: string): number => {
		io.stderr(`melian: mutants verify could not decide: ${visibleText(reason)}\n`);
		return 2;
	};
	try {
		const target = parseTarget(argument);
		let range = argument;
		let policy: string | undefined;
		let url: string | undefined;
		let leave: "writer" | "reviewer" | undefined = options.trustHead ? "reviewer" : undefined;
		let refusal = "nothing git records says whose code this head is; pass --trust-head if you have read it and want its tests run";
		if (target.kind === "pullRequest") {
			const provider = await gitHubFor(io.cwd, io.env);
			const { pullRequest } = await fetchedPullRequest(io.cwd, provider, target.number);
			range = pullRequestRefs(target.number).range;
			policy = pullRequest.base.sha;
			url = pullRequest.url;
			const writer = await writerTrust(provider, pullRequest);
			if (writer.trusted) leave ??= "writer";
			else refusal = `${writer.detail}; pass --trust-head if you have read this code and want its tests run`;
		}
		if (leave === undefined) return undecided(refusal);
		const changeset = await Changeset.resolve(io.cwd, range);
		const { repoRoot, revision } = changeset;
		const policyCommit = policy ?? revision.base;
		const changed = new Set(revision.files.filter((file) => file.status !== "deleted").map((file) => file.path));
		const unknown = files.filter((file) => !changed.has(file));
		if (unknown.length > 0)
			return undecided(
				`${unknown.map((file) => JSON.stringify(file)).join(", ")} ${unknown.length === 1 ? "is not a file" : "are not files"} this range changes`,
			);
		const listed = new Set(files);
		const inventory = (
			await (await MutationEnumeration.open(io.cwd, range, { policy: { kind: "revision", commit: policyCommit }, target: url })).list({
				all: true,
			})
		).toJSON();
		const mutants = inventory.mutants.filter((row) => listed.has(row.file));
		const setAside = inventory.unmutated.filter((entry) => listed.has(entry.file));
		const strykerConfig = await blob(repoRoot, policyCommit, "stryker.config.json");
		let run: MutantsVerifyRun = { report: undefined, noTests: false, endCheck: {}, notes: [] };
		if (mutants.some((row) => row.status === "generated")) {
			if (strykerConfig === undefined) return undecided(`the base, ${policyCommit}, has no stryker.config.json`);
			const { config } = await loadConfig(repoRoot, { kind: "revision", commit: policyCommit }, ".");
			run = await runMutantsVerify(
				{
					env: createNodeExecutionEnv(repoRoot),
					repoRoot,
					commit: revision.head,
					base: revision.base,
					tool: "mutation",
					settings: config.static.mutation,
					revision,
					headCode: leave,
				},
				{ files, config: strykerConfig },
				backgroundContext,
			);
		}
		const verdict = MutantsVerdict.decide({
			head: revision.head,
			tree: await treeDigest(repoRoot, revision.head),
			files,
			mutants,
			setAside,
			report: run.report,
			noTests: run.noTests,
			endCheck: run.endCheck,
			answers: await blob(repoRoot, revision.head, answersPath),
		});
		for (const note of run.notes) io.stderr(`melian: ${visibleText(note)}\n`);
		io.stdout(`${options.json ? verdict.renderJson() : verdict.render()}\n`);
		return verdict.exitCode();
	} catch (error) {
		return undecided(error instanceof Error ? error.message : String(error));
	}
}

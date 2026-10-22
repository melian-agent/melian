import { readFile } from "node:fs/promises";
import { createGitHubProvider, type GitHubProvider } from "@melian-agent/github";
import type { Io } from "./commands.ts";
import { CliError, git } from "./repository.ts";

const shaPattern = /^[0-9a-f]{40}$/;
const headPattern = /^(?:refs\/heads\/)?gh-readonly-queue\/main\/pr-([1-9][0-9]*)-([0-9a-f]{40})$/;

type GroupEvent = {
	merge_group?: { head_sha?: string; base_sha?: string; base_ref?: string; head_ref?: string };
};

export class MergeGroupStatus {
	private readonly io: Io;
	private readonly provider: GitHubProvider;
	private readonly event: GroupEvent;
	private readonly head: string;
	private readonly base: string;
	private readonly signal: AbortSignal;
	private readonly expected: { head?: string; base?: string };
	private number: string | undefined;

	private constructor(
		io: Io,
		provider: GitHubProvider,
		event: GroupEvent,
		head: string,
		base: string,
		expected: { head?: string; base?: string },
	) {
		this.io = io;
		this.provider = provider;
		this.event = event;
		this.head = head;
		this.base = base;
		this.signal = AbortSignal.timeout(60_000);
		this.expected = expected;
	}

	static async load(
		io: Io,
		options: { head?: string; base?: string; provider?: GitHubProvider } = {},
	): Promise<MergeGroupStatus> {
		const event = JSON.parse(await readFile(io.env.GITHUB_EVENT_PATH ?? "", "utf8")) as GroupEvent;
		const head = event.merge_group?.head_sha ?? "";
		const base = event.merge_group?.base_sha ?? "";
		if (!shaPattern.test(head)) throw new CliError("merge group head must be a full lowercase SHA");
		const [owner, repo] = (io.env.GITHUB_REPOSITORY ?? "").split("/");
		if (!owner || !repo) throw new CliError("GITHUB_REPOSITORY must name owner/repository");
		const provider = options.provider ?? createGitHubProvider({ owner, repo, token: io.env.GITHUB_TOKEN ?? "" });
		return new MergeGroupStatus(io, provider, event, head, base, options);
	}

	async post(): Promise<number> {
		let reason: string | undefined;
		try {
			await this.validate();
		} catch (error) {
			reason = error instanceof Error ? error.message : String(error);
		}
		const label = this.number === undefined ? "merge group" : `PR #${this.number}`;
		const description = reason === undefined ? `${label}: reviewed head and base verified` : `${label}: ${reason}`;
		const run = `${this.io.env.GITHUB_SERVER_URL ?? "https://github.com"}/${this.provider.owner}/${this.provider.repo}/actions/runs/${this.io.env.GITHUB_RUN_ID}`;
		await this.provider.setStatus(
			this.head,
			{ state: reason === undefined ? "success" : "failure", description },
			run,
		);
		this.io.stdout(`${description}\n`);
		return reason === undefined ? 0 : 1;
	}

	private async validate(): Promise<void> {
		const group = this.event.merge_group;
		if (this.io.env.GITHUB_EVENT_NAME !== "merge_group") throw new CliError("event name is not merge_group");
		if (group?.base_ref !== "refs/heads/main") throw new CliError("base_ref is not refs/heads/main");
		const match = headPattern.exec(group.head_ref ?? "");
		if (match === null) throw new CliError("head_ref has an invalid queue shape");
		this.number = match[1]!;
		if (!Number.isSafeInteger(Number(this.number))) throw new CliError("head_ref pull request number is not safe");
		if (
			(this.expected.head !== undefined && this.expected.head !== this.head) ||
			(this.expected.base !== undefined && this.expected.base !== this.base)
		)
			throw new CliError("event SHAs differ from command arguments");
		if (match[2] !== this.base) throw new CliError("head_ref SHA differs from base_sha");
		const rules = (await this.provider.mergeGroupRules(this.signal)).filter((rule) => rule.type === "merge_queue");
		if (
			rules.length !== 1 ||
			rules[0]!.parameters?.grouping_strategy !== "ALLGREEN" ||
			rules[0]!.parameters?.merge_method !== "MERGE"
		)
			throw new CliError("merge queue rule must be exactly one ALLGREEN MERGE rule");
		const parents = (await git(this.io.cwd, ["show", "-s", "--format=%P", this.head])).split(" ");
		if (parents.length !== 2) throw new CliError("head_sha must have exactly two parents");
		if (parents[0] !== this.base) throw new CliError("first parent differs from base_sha");
		const head = await this.provider.mergeGroupHead(Number(this.number), this.signal);
		if (parents[1] !== head) throw new CliError("second parent differs from pull request head");
		const status = await this.provider.mergeGroupReview(head, this.signal);
		if (status === undefined) throw new CliError(`head ${head} has no melian/review status`);
		if (status.state !== "success") throw new CliError("latest head status is not success");
		if (status.creator?.type !== "User") throw new CliError("head status creator is not a user");
		const permission = await this.provider.mergeGroupPermission(status.creator.login, this.signal);
		if (!["write", "maintain", "admin"].includes(permission))
			throw new CliError("head status creator is not a writer");
		const target = status.target_url ?? "";
		const pull = `https://github.com/${this.provider.owner}/${this.provider.repo}/pull/${this.number}`;
		if (target !== pull && !target.startsWith(`${pull}#`))
			throw new CliError("head status target names another pull request");
		const description = status.description ?? "";
		const reviewed = /; base ([0-9a-f]{40})$/.exec(description);
		if (reviewed === null || description.indexOf("; base ") !== reviewed.index)
			throw new CliError("head status lacks the exact reviewed base suffix");
		await git(this.io.cwd, ["merge-base", "--is-ancestor", reviewed[1]!, this.base]).catch(() => {
			throw new CliError("reviewed base is not a known ancestor of base_sha");
		});
	}
}

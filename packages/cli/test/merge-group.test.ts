import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as github from "@melian-agent/github";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeStatus, fakeGitHub, fakeState } from "../../github/test/fixtures/fake-github.ts";
import { main } from "../src/main.ts";
import { MergeGroupStatus } from "../src/merge-group.ts";

const gitEnv = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const queueRule = { type: "merge_queue", parameters: { grouping_strategy: "ALLGREEN", merge_method: "MERGE" } };
let root: string;
function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: root, env: { ...process.env, ...gitEnv }, encoding: "utf8" }).trim();
}
function commit(...parents: string[]): string {
	return git(
		"commit-tree",
		git("rev-parse", "HEAD^{tree}"),
		...parents.flatMap((sha) => ["-p", sha]),
		"-m",
		`commit ${parents.join(" ")}`,
	);
}
function fixture() {
	const reviewed = git("rev-parse", "HEAD");
	const base = commit(reviewed);
	const head = commit(base);
	const group = commit(base, head);
	const state = fakeState(
		"owner",
		"repo",
		{ number: 7, title: "Change", base: { ref: "main", sha: base }, head: { ref: "feature", sha: head } },
		{},
	);
	state.branchRules = [queueRule];
	state.statuses.push({
		sha: head,
		context: "melian/review",
		state: "success",
		description: `0 findings; base ${reviewed}`,
		target_url: "https://github.com/owner/repo/pull/7#issuecomment-1",
		creator: { login: state.login, type: "User" },
	});
	const event = {
		merge_group: {
			head_sha: group,
			base_sha: base,
			base_ref: "refs/heads/main",
			head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${base}`,
		},
	};
	const env = {
		GITHUB_EVENT_NAME: "merge_group",
		GITHUB_EVENT_PATH: join(root, "event.json"),
		GITHUB_REPOSITORY: "owner/repo",
		GITHUB_RUN_ID: "123",
	};
	const io = { cwd: root, env, stdout: vi.fn(), stderr: vi.fn(), color: false };
	const provider = createGitHubProvider({ owner: "owner", repo: "repo", token: "fake", fetch: fakeGitHub(state) });
	const post = async (options: { head?: string; base?: string } = {}) => {
		writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
		return (await MergeGroupStatus.load(io, { provider, ...options })).post();
	};
	const posted = () =>
		state.calls
			.filter((call) => call.method === "POST")
			.map((call) => ({ sha: call.path.split("/").at(-1)!, ...(call.body as Omit<FakeStatus, "sha">) }));
	const fails = async (reason: string) => {
		expect(await post()).toBe(1);
		expect(posted()).toEqual([
			expect.objectContaining({
				sha: event.merge_group.head_sha,
				state: "failure",
				description: expect.stringContaining(reason),
			}),
		]);
	};
	return { reviewed, base, head, group, state, event, env, io, provider, post, posted, fails };
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "melian-merge-group-")));
	git("init", "-q");
	git("commit", "--allow-empty", "-qm", "root");
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("merge group's own pull request status", () => {
	it("1, 19: posts the whole result only on the group SHA and never reads the queue", async () => {
		const f = fixture();
		expect(await f.post({ head: f.group, base: f.base })).toBe(0);
		expect(f.posted()).toEqual([
			{
				sha: f.group,
				state: "success",
				description: "PR #7: reviewed head and base verified",
				context: "melian/review",
				target_url: "https://github.com/owner/repo/actions/runs/123",
			},
		]);
		expect(f.state.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
			"GET /repos/owner/repo/rules/branches/main",
			"GET /repos/owner/repo/pulls/7",
			`GET /repos/owner/repo/commits/${f.head}/statuses`,
			"GET /repos/owner/repo/collaborators/melian-user/permission",
			`POST /repos/owner/repo/statuses/${f.group}`,
		]);
		expect(f.io.stdout.mock.calls).toEqual([["PR #7: reviewed head and base verified\n"]]);
	});
	it("2: rejects another event before any read", async () => {
		const f = fixture();
		f.env.GITHUB_EVENT_NAME = "pull_request";
		await f.fails("event name");
		expect(f.state.calls).toHaveLength(1);
		expect(f.posted()[0]!.description).toBe("merge group: event name is not merge_group");
	});
	it("3: rejects another base_ref", async () => {
		const f = fixture();
		f.event.merge_group.base_ref = "refs/heads/dev";
		await f.fails("base_ref");
	});
	it.each(["refs/heads/", ""])("4: accepts the queue ref prefix %s", async (prefix) => {
		const f = fixture();
		f.event.merge_group.head_ref = `${prefix}gh-readonly-queue/main/pr-7-${f.base}`;
		expect(await f.post()).toBe(0);
	});
	it.each([
		"other base",
		"zero",
		"leading zero",
		"abbreviated",
		"uppercase",
		"trailing text",
		"trailing newline",
		"leading text",
	])("4: rejects head_ref with %s", async (kind) => {
		const f = fixture();
		let ref = f.event.merge_group.head_ref;
		if (kind === "other base") ref = ref.replace("/main/", "/dev/");
		if (kind === "zero") ref = ref.replace("pr-7-", "pr-0-");
		if (kind === "leading zero") ref = ref.replace("pr-7-", "pr-07-");
		if (kind === "abbreviated") ref = ref.slice(0, -1);
		if (kind === "uppercase") ref = ref.slice(0, -40) + "A".repeat(40);
		if (kind === "trailing text") ref += "suffix";
		if (kind === "trailing newline") ref += "\n";
		if (kind === "leading text") ref = `x${ref}`;
		f.event.merge_group.head_ref = ref;
		await f.fails("head_ref has an invalid queue shape");
	});
	it("5: rejects a captured SHA different from base_sha", async () => {
		const f = fixture();
		f.event.merge_group.head_ref = f.event.merge_group.head_ref.replace(f.base, f.head);
		await f.fails("head_ref SHA");
	});
	it("5: rejects a first parent different from base_sha", async () => {
		const f = fixture();
		f.event.merge_group.head_sha = commit(f.reviewed, f.head);
		await f.fails("first parent");
	});
	it.each([1, 3])("6: rejects %i parents", async (count) => {
		const f = fixture();
		f.event.merge_group.head_sha = count === 1 ? f.head : commit(f.base, f.head, f.reviewed);
		await f.fails("exactly two parents");
	});
	it("7: rejects a stale pull request head", async () => {
		const f = fixture();
		f.state.pull.head.sha = f.reviewed;
		await f.fails("second parent");
	});
	it.each([
		["HEADGREEN", [{ ...queueRule, parameters: { ...queueRule.parameters, grouping_strategy: "HEADGREEN" } }]],
		["SQUASH", [{ ...queueRule, parameters: { ...queueRule.parameters, merge_method: "SQUASH" } }]],
		["no queue rule", []],
		["two queue rules", [queueRule, queueRule]],
		["missing parameters", [{ type: "merge_queue" }]],
	])("8: rejects %s", async (_, rules) => {
		const f = fixture();
		f.state.branchRules = rules;
		await f.fails("merge queue rule");
	});
	it("8: ignores other branch rules", async () => {
		const f = fixture();
		f.state.branchRules!.push({ type: "required_status_checks" });
		expect(await f.post()).toBe(0);
	});
	it("9: rejects a missing status and names the pull request and head", async () => {
		const f = fixture();
		f.state.statuses[0]!.context = "unrelated";
		await f.fails(`PR #7: head ${f.head} has no melian/review`);
		expect(f.posted()[0]!.description).toContain(f.head);
	});
	it("10: uses the newest matching status, never an older success", async () => {
		const f = fixture();
		f.state.statuses.push({ ...f.state.statuses[0]!, state: "failure" });
		await f.fails("latest head status");
	});
	it.each(["pending", "error", "failure"])("11: rejects head state %s", async (state) => {
		const f = fixture();
		f.state.statuses[0]!.state = state;
		await f.fails("latest head status");
	});
	it.each(["Bot", "Organization", "missing"])("12: rejects status creator %s", async (type) => {
		const f = fixture();
		f.state.statuses[0]!.creator = type === "missing" ? null : { login: "github-actions[bot]", type };
		await f.fails("creator is not a user");
	});
	it.each(["read", "triage", "none", "unknown"])("12: rejects creator permission %s", async (permission) => {
		const f = fixture();
		f.state.permissions = { [f.state.login]: permission };
		await f.fails("not a writer");
	});
	it.each(["write", "maintain", "admin"])("12: accepts creator permission %s", async (permission) => {
		const f = fixture();
		f.state.permissions = { [f.state.login]: permission };
		expect(await f.post()).toBe(0);
	});
	it("13: fails closed on a refused collaborator read", async () => {
		const f = fixture();
		f.state.failPermission = true;
		await f.fails("read permission");
		expect(f.state.calls.filter((call) => call.path.endsWith("/permission"))).toHaveLength(2);
	});
	it.each([
		"https://github.com/owner/repo/pull/8",
		"https://github.com/other/repo/pull/7",
		"https://github.com/owner/other/pull/7",
		"https://github.com/owner/repo/pull/70",
		"https://evil.example/owner/repo/pull/7",
		"",
	])("14: rejects target %s", async (target_url) => {
		const f = fixture();
		f.state.statuses[0]!.target_url = target_url;
		await f.fails("target");
	});
	it("14: accepts a pull request target without a fragment", async () => {
		const f = fixture();
		f.state.statuses[0]!.target_url = "https://github.com/owner/repo/pull/7";
		expect(await f.post()).toBe(0);
	});
	it.each([
		"no base",
		"short SHA",
		"uppercase",
		"ref",
		"two SHAs",
		"text after",
		"cut",
		"newline",
		"wrong separator",
		"a head suffix before it",
		"a doubled suffix",
	])("15: rejects reviewed base with %s", async (kind) => {
		const f = fixture();
		const sha = f.reviewed;
		const descriptions: Record<string, string> = {
			"no base": "0 findings",
			"short SHA": `0 findings; base ${sha.slice(0, 39)}`,
			uppercase: `0 findings; base ${"A".repeat(40)}`,
			ref: "0 findings; base HEAD~1",
			"two SHAs": `0 findings; base ${sha} ${sha}`,
			"text after": `0 findings; base ${sha} extra`,
			cut: `0 findings; base ${sha}…`,
			newline: `0 findings; base ${sha}\n`,
			"wrong separator": `0 findings base ${sha}`,
			"a head suffix before it": `0 findings; base ${f.head}; base ${sha}`,
			"a doubled suffix": `0 findings; base ${sha}; base ${sha}`,
		};
		f.state.statuses[0]!.description = descriptions[kind]!;
		await f.fails("exact reviewed base suffix");
	});
	it("16: rejects a known reviewed base outside the group's ancestry", async () => {
		const f = fixture();
		f.state.statuses[0]!.description = `0 findings; base ${f.head}`;
		await f.fails("not a known ancestor");
	});
	it("16: rejects an unknown 40-hex object when git exits 128", async () => {
		const f = fixture();
		const unknown = "f".repeat(40);
		expect(() => git("merge-base", "--is-ancestor", unknown, f.base)).toThrow(
			expect.objectContaining({ status: 128 }),
		);
		f.state.statuses[0]!.description = `0 findings; base ${unknown}`;
		await f.fails("not a known ancestor");
	});
	it("16: accepts a reviewed base through an earlier unlanded group", async () => {
		const f = fixture();
		const earlier = commit(f.base, f.head);
		const group = commit(earlier, f.head);
		f.event.merge_group = {
			...f.event.merge_group,
			base_sha: earlier,
			head_sha: group,
			head_ref: `gh-readonly-queue/main/pr-7-${earlier}`,
		};
		expect(git("rev-parse", "HEAD")).toBe(f.reviewed);
		expect(await f.post()).toBe(0);
	});
	it.each(["rules", "pull", "statuses", "permission"])("8, 18: retries the %s read once", async (kind) => {
		const f = fixture();
		const paths: Record<string, string> = {
			rules: "/repos/owner/repo/rules/branches/main",
			pull: "/repos/owner/repo/pulls/7",
			statuses: `/repos/owner/repo/commits/${f.head}/statuses`,
			permission: "/repos/owner/repo/collaborators/melian-user/permission",
		};
		f.state.readFailures = { [paths[kind]!]: 1 };
		expect(await f.post()).toBe(0);
		expect(f.state.calls.filter((call) => call.path === paths[kind])).toHaveLength(2);
	});
	it.each(["rules", "pull", "statuses", "permission"])("8, 18: fails after two failed %s reads", async (kind) => {
		const f = fixture();
		const paths: Record<string, string> = {
			rules: "/repos/owner/repo/rules/branches/main",
			pull: "/repos/owner/repo/pulls/7",
			statuses: `/repos/owner/repo/commits/${f.head}/statuses`,
			permission: "/repos/owner/repo/collaborators/melian-user/permission",
		};
		f.state.readFailures = { [paths[kind]!]: 2 };
		await f.fails("Read unavailable");
		expect(f.state.calls.filter((call) => call.path === paths[kind])).toHaveLength(2);
	});
	it("rejects event SHAs different from explicit arguments", async () => {
		const f = fixture();
		expect(await f.post({ base: f.head })).toBe(1);
		expect(f.posted()[0]!.description).toContain("event SHAs");
	});
	it("refuses a malformed destination before any write", async () => {
		const f = fixture();
		f.event.merge_group.head_sha = "HEAD";
		await expect(f.post()).rejects.toThrow("full lowercase SHA");
		expect(f.state.calls).toEqual([]);
	});
	it("refuses a missing repository before any write", async () => {
		const f = fixture();
		f.env.GITHUB_REPOSITORY = "owner";
		await expect(f.post()).rejects.toThrow("GITHUB_REPOSITORY");
		expect(f.state.calls).toEqual([]);
	});
	it("writes failure to the event head when --head disagrees", async () => {
		const f = fixture();
		expect(await f.post({ head: f.head })).toBe(1);
		expect(f.state.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
			`/repos/owner/repo/statuses/${f.group}`,
		]);
	});
	it("rejects the first unsafe pull request number", async () => {
		const f = fixture();
		f.event.merge_group.head_ref = `gh-readonly-queue/main/pr-9007199254740992-${f.base}`;
		await f.fails("number is not safe");
	});
	it("accepts the largest safe pull request number", async () => {
		const f = fixture();
		f.state.pull.number = Number.MAX_SAFE_INTEGER;
		f.event.merge_group.head_ref = `gh-readonly-queue/main/pr-${Number.MAX_SAFE_INTEGER}-${f.base}`;
		f.state.statuses[0]!.target_url = `https://github.com/owner/repo/pull/${Number.MAX_SAFE_INTEGER}`;
		expect(await f.post()).toBe(0);
	});
	it("18: bounds hanging reads with the command deadline and posts failure", async () => {
		const f = fixture();
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		const transport = fakeGitHub(f.state);
		let reads = 0;
		const provider = createGitHubProvider({
			owner: "owner",
			repo: "repo",
			token: "fake",
			fetch: async (input, init) => {
				if (init?.method === "POST") return transport(input, init);
				reads++;
				const signal = init?.signal;
				return new Promise((_resolve, reject) => {
					if (signal?.aborted) reject(new Error("read deadline"));
					else signal?.addEventListener("abort", () => reject(new Error("read deadline")), { once: true });
				});
			},
		});
		writeFileSync(f.env.GITHUB_EVENT_PATH, JSON.stringify(f.event));
		const group = await MergeGroupStatus.load(f.io, { provider });
		const posting = group.post();
		controller.abort();
		expect(await posting).toBe(1);
		expect(reads).toBe(2);
		expect(timeout).toHaveBeenCalledWith(60_000);
		expect(f.posted()[0]).toMatchObject({ state: "failure", description: expect.stringContaining("read deadline") });
	});

	it.each([
		["pull request", "/pulls/7"],
		["permission", "/permission"],
	])("passes the command deadline to the %s read", async (_name, suffix) => {
		const f = fixture();
		const controller = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		const transport = fakeGitHub(f.state);
		const provider = createGitHubProvider({
			owner: "owner",
			repo: "repo",
			token: "fake",
			fetch: async (input, init) => {
				if (!new URL(String(input)).pathname.endsWith(suffix)) return transport(input, init);
				const signal = init?.signal;
				if (signal === undefined || signal === null) throw new Error("read without a deadline");
				return new Promise((_resolve, reject) => {
					if (signal.aborted) reject(new Error("read deadline"));
					signal.addEventListener("abort", () => reject(new Error("read deadline")), { once: true });
					controller.abort();
				});
			},
		});
		writeFileSync(f.env.GITHUB_EVENT_PATH, JSON.stringify(f.event));
		expect(await (await MergeGroupStatus.load(f.io, { provider })).post()).toBe(1);
		expect(f.posted()).toEqual([
			expect.objectContaining({ state: "failure", description: expect.stringContaining("read deadline") }),
		]);
	});
	it("returns exactly the rules and statuses GitHub lists", async () => {
		const f = fixture();
		const signal = new AbortController().signal;
		expect(await f.provider.mergeGroupRules(signal)).toEqual([queueRule]);
		expect(await f.provider.mergeGroupReview(f.head, signal)).toEqual(f.state.statuses[0]);
	});
	it.each(["missing", "newline", "uppercase", "groupless"])("refuses a %s destination", async (kind) => {
		const f = fixture();
		if (kind === "missing") Reflect.deleteProperty(f.event.merge_group, "head_sha");
		if (kind === "groupless") Reflect.deleteProperty(f.event, "merge_group");
		if (kind === "newline") f.event.merge_group.head_sha += "\n";
		if (kind === "uppercase") f.event.merge_group.head_sha = "A".repeat(40);
		await expect(f.post()).rejects.toThrow("full lowercase SHA");
		expect(f.state.calls).toEqual([]);
	});
	it.each(["head_ref", "base_sha"])("fails closed on missing %s", async (field) => {
		const f = fixture();
		Reflect.deleteProperty(f.event.merge_group, field);
		await f.fails(field === "head_ref" ? "head_ref" : "base_sha");
	});
	it("uses the Actions token and repository when no provider is supplied", async () => {
		const f = fixture();
		const create = vi.spyOn(github, "createGitHubProvider").mockReturnValue(f.provider);
		const env = { ...f.env, GITHUB_TOKEN: "test-token", GITHUB_SERVER_URL: "https://github.example" };
		writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(f.event));
		expect(await (await MergeGroupStatus.load({ ...f.io, env })).post()).toBe(0);
		expect(create).toHaveBeenCalledWith({ owner: "owner", repo: "repo", token: "test-token" });
		expect(f.posted()[0]!.target_url).toBe("https://github.example/owner/repo/actions/runs/123");
	});
	it.each([null, "HEAD~1"])("fails closed on description %s", async (description) => {
		const f = fixture();
		Reflect.set(f.state.statuses[0]!, "description", description);
		await f.fails("exact reviewed base suffix");
	});
	it("fails closed on a missing target URL", async () => {
		const f = fixture();
		Reflect.deleteProperty(f.state.statuses[0]!, "target_url");
		await f.fails("target");
	});
	it.each([409, 503])("retries HTTP %i pages and refuses synthetic success", async (status) => {
		const f = fixture();
		const transport = fakeGitHub(f.state);
		let reads = 0;
		const provider = createGitHubProvider({
			owner: "owner",
			repo: "repo",
			token: "fake",
			fetch: async (input, init) => {
				if (init?.method === "POST") return transport(input, init);
				reads++;
				return new Response(JSON.stringify({ message: "refused page" }), {
					status,
					headers: { "content-type": "application/json" },
				});
			},
		});
		writeFileSync(f.env.GITHUB_EVENT_PATH, JSON.stringify(f.event));
		expect(await (await MergeGroupStatus.load(f.io, { provider })).post()).toBe(1);
		expect(reads).toBe(2);
		expect(f.posted()[0]!.description).toContain("refused page");
	});
	it("retries a malformed page before accepting its answer", async () => {
		const f = fixture();
		const transport = fakeGitHub(f.state);
		let reads = 0;
		const provider = createGitHubProvider({
			owner: "owner",
			repo: "repo",
			token: "fake",
			fetch: async (input, init) => {
				const url = new URL(String(input));
				if (url.pathname.endsWith("/rules/branches/main") && reads++ === 0)
					return new Response("null", { headers: { "content-type": "application/json" } });
				return transport(input, init);
			},
		});
		writeFileSync(f.env.GITHUB_EVENT_PATH, JSON.stringify(f.event));
		expect(await (await MergeGroupStatus.load(f.io, { provider })).post()).toBe(0);
		expect(reads).toBe(2);
	});
	it("reads all rule pages and retries each page independently", async () => {
		const f = fixture();
		const transport = fakeGitHub(f.state);
		const counts = [0, 0];
		const provider = createGitHubProvider({
			owner: "owner",
			repo: "repo",
			token: "fake",
			fetch: async (input, init) => {
				const url = new URL(String(input));
				if (!url.pathname.endsWith("/rules/branches/main")) return transport(input, init);
				const page = Number(url.searchParams.get("page") ?? "1");
				expect(page).toBeLessThanOrEqual(2);
				counts[page - 1]!++;
				if (counts[page - 1] === 1) return new Response("{}", { status: 503 });
				return new Response(JSON.stringify([queueRule]), {
					headers: {
						"content-type": "application/json",
						...(page === 1
							? { link: '<https://api.github.com/repos/owner/repo/rules/branches/main?page=2>; rel="next"' }
							: {}),
					},
				});
			},
		});
		writeFileSync(f.env.GITHUB_EVENT_PATH, JSON.stringify(f.event));
		expect(await (await MergeGroupStatus.load(f.io, { provider })).post()).toBe(1);
		expect(f.posted()[0]!.description).toContain("exactly one");
		expect(counts).toEqual([2, 2]);
	});

	it.each([140, 141])("bounds a %i-character group description at 140", async (length) => {
		const f = fixture();
		const transport = fakeGitHub(f.state);
		const prefix = "PR #7: GitHub refused to read main's merge queue rule: 500 ";
		const message = "x".repeat(length - prefix.length);
		const provider = createGitHubProvider({
			owner: "owner",
			repo: "repo",
			token: "fake",
			fetch: async (input, init) => {
				if (init?.method === "POST") return transport(input, init);
				throw new Error(message);
			},
		});
		writeFileSync(f.env.GITHUB_EVENT_PATH, JSON.stringify(f.event));
		expect(await (await MergeGroupStatus.load(f.io, { provider })).post()).toBe(1);
		const whole = prefix + message;
		expect(f.posted()[0]!.description).toBe(length === 140 ? whole : `${whole.slice(0, 139)}…`);
	});

	it("dispatches the command and requires merge-group as its subcommand", async () => {
		const f = fixture();
		const load = vi.spyOn(MergeGroupStatus, "load");
		writeFileSync(f.env.GITHUB_EVENT_PATH, JSON.stringify(f.event));
		const group = await MergeGroupStatus.load(f.io, { provider: f.provider });
		load.mockResolvedValue(group);
		expect(await main(["status", "merge-group", "--head", f.group, "--base", f.base], f.io)).toBe(0);
		expect(load).toHaveBeenLastCalledWith(f.io, { head: f.group, base: f.base });
		expect(await main(["status", "other"], f.io)).toBe(64);
		expect(await main(["status"], f.io)).toBe(64);
	});
});

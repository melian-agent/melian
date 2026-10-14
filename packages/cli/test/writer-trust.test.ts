import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { fakeMutationProcesses } from "../../pipeline/test/fixtures/mutation-process.ts";
import { baseAndHead, fakeTool, gitIn, isolatedGitEnv, writeFiles } from "../../pipeline/test/fixtures/repo.ts";
import { emptyVitestInstall } from "../../pipeline/test/fixtures/vitest-listing.ts";
import { review } from "../src/commands.ts";
import * as targets from "../src/target.ts";
import { outsideCheckout } from "../src/target.ts";

let repo: string;
let calls: string;

beforeEach(() => {
	fakeMutationProcesses();
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

// A repository whose review runs only static.mutation, with a Stryker that records each call and reports no mutant.
async function open(
	author: string | undefined,
	permissions: Record<string, string>,
	head: Record<string, string> = {},
	tier = "static.mutation",
	identity: {
		repository?: { owner: string; name: string } | null;
		pusher?: string;
		pushers?: string[];
		failEvents?: boolean;
		failPermission?: boolean;
	} = {},
	baseFiles: Record<string, string> = {},
) {
	repo = baseAndHead(
		{
			".gitignore": "node_modules\n",
			"src/a.ts": "export const a = 1;\n",
			"stryker.config.json": "{}\n",
			"melian.yaml": `tiers:\n  full: [${tier}]\nstatic:\n  mutation: { enabled: true, timeout: 120 }\n`,
			...baseFiles,
		},
		{ "src/a.ts": "export const a = 2;\n", ...head },
	);
	writeFiles(repo, emptyVitestInstall);
	calls = join(repo, "calls.txt");
	fakeTool(
		repo,
		"stryker",
		`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
echo run >> '${calls}'
mkdir -p reports/mutation
echo '{"files":{}}' > reports/mutation/mutation.json`,
	);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const state = pullRequestState();
	moveTo(state, changeset);
	if (author !== undefined) state.author = author;
	state.permissions = permissions;
	state.headRepository = identity.repository;
	state.failEvents = identity.failEvents;
	state.failPermission = identity.failPermission;
	const pushers = identity.pushers ?? (identity.pusher === undefined ? [] : [identity.pusher]);
	state.pushEvents = pushers.map((login) => ({
		type: "PushEvent",
		actor: { login },
		payload: { head: changeset.revision.head, ref: `refs/heads/${state.pull.head.ref}` },
	}));
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test-token",
		fetch: fakeGitHub(state),
	});
	vi.spyOn(targets, "gitHubFor").mockResolvedValue(provider);
	const pullRequest = await provider.pullRequest(7);
	vi.spyOn(targets, "fetchedPullRequest").mockResolvedValue({
		pullRequest: author === undefined ? { ...pullRequest, author: undefined } : pullRequest,
		changeset,
	});
	const script = join(repo, "script.json");
	writeFileSync(script, "{}");
	let output = "";
	const io = {
		cwd: repo,
		// Whatever the machine running these tests has declared, the host under test has declared nothing.
		env: { ...process.env, MELIAN_TEST_SCRIPT: script } as NodeJS.ProcessEnv,
		stdout: (text: string) => {
			output += text;
		},
		stderr: () => {},
		color: false,
	};
	return { io, output: () => output };
}

// A review that is not reviewed exits as a failed one does.
const notReviewed = 2;

const ran = () => existsSync(calls) && readFileSync(calls, "utf8").trim().split("\n").length;

describe("static.mutation and the writer of a pull request", { timeout: 60_000 }, () => {
	it.each(["write", "maintain", "admin"])(
		"runs the head's tests for an author with %s permission",
		async (permission) => {
			const { io } = await open("octocat", { octocat: permission });
			expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
			expect(ran()).toBe(1);
		},
	);

	it.each(["triage", "read", "none"])(
		"runs nothing for an author with %s permission, and the review is not reviewed",
		async (permission) => {
			const { io, output } = await open("octocat", { octocat: permission });
			expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(notReviewed);
			expect(ran()).toBe(false);
			expect(output()).toContain("Verdict: not reviewed");
			expect(output()).toContain(
				`static.mutation  skipped: octocat has ${permission} permission on the repository; the mutation check runs the head's own tests`,
			);
		},
	);

	it("skips the check when the provider names no author", async () => {
		const { io, output } = await open(undefined, {});
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain("the provider names no author for the pull request");
	});

	it("skips the check when the author's permission cannot be read", async () => {
		const { io, output } = await open("octocat", { octocat: "surprise" });
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain("octocat has no known permission on the repository");
	});

	it.each([
		{ owner: "fork-owner", name: "example" },
		{ owner: "melian-agent", name: "another" },
	])("refuses a maintainer's fork head %s", async (repository) => {
		const { io, output } = await open("maintainer", { maintainer: "admin" }, {}, "static.mutation", { repository });
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain("the head is from a fork; the mutation check runs the head's own tests");
	});
	it("refuses an absent head repository", async () => {
		const { io, output } = await open("maintainer", { maintainer: "admin" }, {}, "static.mutation", {
			repository: null,
		});
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain("names no repository");
	});
	it.each(["read", "surprise"])(
		"refuses a pusher with %s permission despite the author's write access",
		async (permission) => {
			const { io, output } = await open(
				"maintainer",
				{ maintainer: "admin", contributor: permission },
				{},
				"static.mutation",
				{ pusher: "contributor" },
			);
			expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(notReviewed);
			expect(ran()).toBe(false);
			expect(output()).toContain("contributor has");
		},
	);

	it("refuses the newest matching read-only pusher despite an older writer push", async () => {
		const { io, output } = await open(
			"maintainer",
			{ maintainer: "write", contributor: "read" },
			{},
			"static.mutation",
			{
				pushers: ["contributor", "maintainer"],
			},
		);
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain("contributor has read permission");
	});
	it("trusts a same-repository pusher with write permission despite the author's read role", async () => {
		const { io } = await open("contributor", { maintainer: "write", contributor: "read" }, {}, "static.mutation", {
			pusher: "maintainer",
		});
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(1);
	});
	it("records unreadable permission as untrusted", async () => {
		const { io, output } = await open("maintainer", { maintainer: "admin" }, {}, "static.mutation", {
			failPermission: true,
		});
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain("maintainer has no known permission");
	});
	it("refuses a failed pusher lookup rather than falling back to the writer author", async () => {
		const { io, output } = await open("maintainer", { maintainer: "admin" }, {}, "static.mutation", {
			failEvents: true,
		});
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain("pushing identity could not be read");
	});

	it("runs the check for a range whose head is the checked-out commit, which the reviewer chose to run", async () => {
		const { io } = await open("octocat", { octocat: "read" });
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(1);
	});

	it("runs nothing for a range whose head is not the checked-out commit, and the review is not reviewed", async () => {
		const { io, output } = await open("octocat", { octocat: "admin" });
		gitIn(repo, "checkout", "--quiet", "main");
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain("Verdict: not reviewed");
		expect(output()).toContain("the review's range head is not the checked-out commit;");
		expect(output()).toContain("which arrives with the Actions host");
	});
});

describe("static.mutation on a checked-out head", { timeout: 60_000 }, () => {
	const base = "https://github.com/melian-agent/melian.git";
	const fork = "https://github.com/fork-owner/melian.git";
	// Sets up the clone's remotes and the upstream of `feature`, as `git clone`, `git push -u` or `gh pr checkout` would.
	const track = (remote: string | undefined, merge = "refs/heads/feature") => {
		gitIn(repo, "remote", "add", "origin", base);
		if (remote === undefined) return;
		gitIn(repo, "config", "branch.feature.remote", remote);
		gitIn(repo, "config", "branch.feature.merge", merge);
	};

	it.each([
		["a branch with no upstream", undefined],
		["a branch that tracks the repository's own remote", "origin"],
		["a branch whose upstream is the repository's URL in another spelling", "git@github.com:Melian-Agent/melian"],
	])("runs the head's tests on %s", async (_name, remote) => {
		const { io } = await open("octocat", { octocat: "read" });
		track(remote);
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(1);
	});

	it.each([
		[
			"a fork's remote, as gh pr checkout adds it",
			() => {
				gitIn(repo, "remote", "add", "fork-owner", fork);
				return "fork-owner";
			},
		],
		["a fork's URL as the upstream itself", () => fork],
		["a remote that does not exist", () => "ghost"],
		["a local branch", () => "."],
		["no branch at all, its merge ref unset", () => "origin"],
	])("refuses a branch that tracks %s", async (name, remote) => {
		const { io, output } = await open("octocat", { octocat: "admin" });
		track(undefined);
		const upstream = remote();
		gitIn(repo, "config", "branch.feature.remote", upstream);
		if (!name.startsWith("no branch")) gitIn(repo, "config", "branch.feature.merge", "refs/heads/feature");
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain(outsideCheckout);
	});

	it("refuses a branch that tracks a pull request ref of the repository, as gh pr checkout sets up for a fork", async () => {
		const { io, output } = await open("octocat", { octocat: "admin" });
		track("origin", "refs/pull/7/head");
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain(outsideCheckout);
	});

	it("runs a detached head only when a branch that tracks the repository holds it", async () => {
		const { io, output } = await open("octocat", { octocat: "admin" });
		track(undefined);
		gitIn(repo, "remote", "add", "fork-owner", fork);
		gitIn(repo, "config", "branch.feature.remote", "fork-owner");
		gitIn(repo, "config", "branch.feature.merge", "refs/heads/feature");
		gitIn(repo, "checkout", "--quiet", "--detach", "feature");
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain(outsideCheckout);
		// A detached head counts on no branch without an upstream: only one that tracks the repository vouches for it.
		gitIn(repo, "branch", "--quiet", "local", "feature");
		expect(await review(io, "main...feature", { rerun: true, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		gitIn(repo, "branch", "--quiet", "pushed", "feature");
		gitIn(repo, "config", "branch.pushed.remote", "origin");
		gitIn(repo, "config", "branch.pushed.merge", "refs/heads/pushed");
		expect(await review(io, "main...feature", { rerun: true, walkthrough: false })).toBe(0);
		expect(ran()).toBe(1);
	});

	it("does not take a branch that tracks the repository but does not hold the head", async () => {
		const { io, output } = await open("octocat", { octocat: "admin" });
		track(undefined);
		gitIn(repo, "branch", "--quiet", "pushed", "main");
		gitIn(repo, "config", "branch.pushed.remote", "origin");
		gitIn(repo, "config", "branch.pushed.merge", "refs/heads/pushed");
		gitIn(repo, "checkout", "--quiet", "--detach", "feature");
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain(outsideCheckout);
	});


	it("runs a head the reviewer vouches for with --trust-head, a fork's or one not checked out", async () => {
		const { io } = await open("octocat", { octocat: "read" });
		track("origin", "refs/pull/7/head");
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false, trustHead: true })).toBe(0);
		expect(ran()).toBe(1);
		gitIn(repo, "checkout", "--quiet", "main");
		expect(await review(io, "main...feature", { rerun: true, walkthrough: false, trustHead: true })).toBe(0);
	});
});

describe("static.mutation where the repository does not trust writers", { timeout: 60_000 }, () => {
	const untrusting = {
		"melian.yaml":
			"trust: { writers: false }\ntiers:\n  full: [static.mutation]\nstatic:\n  mutation: { enabled: true, timeout: 120 }\n",
	};

	it("does not run a writer's head, and says the policy is why", async () => {
		const { io, output } = await open("octocat", { octocat: "admin" }, {}, "static.mutation", {}, untrusting);
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain("trust.writers is false in the repository's policy;");
	});

	it("still runs the reviewer's own checked-out commit", async () => {
		const { io } = await open("octocat", { octocat: "read" }, {}, "static.mutation", {}, untrusting);
		await review(io, "main...feature", { rerun: false, walkthrough: false });
		expect(ran()).toBe(1);
	});
});

// A setup file that throws only while Stryker runs a mutant passes the dry run, so every mutant reads as killed and the
// mutation check reports nothing. The marker is spelt apart so that this file does not match the rule it tests.
const marker = ["__stryker", "__"].join("");
const mutantFlag = ["active", "Mutant"].join("");

describe("a head that forges mutation kills", { timeout: 60_000 }, () => {
	const forged = {
		"test/setup.ts": `if ((globalThis as { ${marker}?: { ${mutantFlag}?: unknown } }).${marker}?.${mutantFlag}) throw new Error("killed");\n`,
	};

	it("does not read as a clean review", async () => {
		const { io, output } = await open("octocat", { octocat: "admin" }, forged, "guardrails, static.mutation");
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).not.toBe(0);
		expect(ran()).toBe(1);
		expect(output()).not.toContain("Verdict: passed");
		expect(output()).toContain("test/setup.ts");
		expect(output()).toContain("active-mutant variable");
	});

	it("reads clean when nothing is forged, so the fixture proves the rule", async () => {
		const { io, output } = await open("octocat", { octocat: "admin" }, {}, "guardrails, static.mutation");
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).toBe(0);
		expect(output()).toContain("Verdict: passed");
	});
});

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
	it.each([
		{ repository: { owner: "fork-owner", name: "example" }, label: "a fork" },
		{ repository: null, label: "no head repository" },
	])("records no coverage for $label, even under --trust-head", async ({ repository }) => {
		const { io, output } = await open("maintainer", { maintainer: "admin" }, {}, "static.mutation", { repository });
		await review(io, "#7", { rerun: false, walkthrough: false, trustHead: true });
		expect(output()).toContain("Coverage: incomplete.");
		expect(output()).toContain("coverage is not recorded for a fork's head");
	});

	it("records coverage for a head in the base repository, whatever the case of its names", async () => {
		const { io, output } = await open("maintainer", { maintainer: "admin" }, {}, "static.mutation", {
			repository: { owner: "MELIAN-AGENT", name: "EXAMPLE" },
		});
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
		expect(output()).toContain("Coverage: complete, from r1.");
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
});

describe("static.mutation on a committed range", { timeout: 60_000 }, () => {
	const base = "https://github.com/melian-agent/melian.git";
	// A bare copy of the repository, standing in for a remote that git can fetch from.
	const bare = (name: string) => {
		const path = join(repo, "..", `${repo.split("/").at(-1)}-${name}.git`);
		gitIn(repo, "clone", "--quiet", "--bare", repo, path);
		cleanups.push(path);
		return path;
	};
	const cleanups: string[] = [];
	afterEach(() => {
		for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	// Each leaves the branch that holds the head checked out, and returns its name.
	const setups: [string, () => string][] = [
		["a branch with no upstream", () => "feature"],
		[
			"a branch that tracks the repository's own remote",
			() => {
				gitIn(repo, "remote", "add", "origin", base);
				gitIn(repo, "config", "branch.feature.remote", "origin");
				gitIn(repo, "config", "branch.feature.merge", "refs/heads/feature");
				return "feature";
			},
		],
		[
			"a branch that tracks a fork's remote, as gh pr checkout sets it up",
			() => {
				gitIn(repo, "remote", "add", "fork-owner", "https://github.com/fork-owner/melian.git");
				gitIn(repo, "config", "branch.feature.remote", "fork-owner");
				gitIn(repo, "config", "branch.feature.merge", "refs/heads/feature");
				return "feature";
			},
		],
		[
			"a branch fetched from the pull request ref, with no upstream",
			() => {
				const origin = bare("origin");
				gitIn(origin, "update-ref", "refs/pull/7/head", "feature");
				gitIn(repo, "remote", "add", "origin", origin);
				gitIn(repo, "checkout", "--quiet", "main");
				gitIn(repo, "fetch", "--quiet", "origin", "pull/7/head:pr-7");
				gitIn(repo, "checkout", "--quiet", "pr-7");
				return "pr-7";
			},
		],
		[
			"a branch of the repository that pulled a fork's commits",
			() => {
				const fork = bare("fork");
				gitIn(repo, "checkout", "--quiet", "-b", "contrib", "main");
				gitIn(repo, "pull", "--quiet", "--no-rebase", fork, "feature");
				return "contrib";
			},
		],
	];

	it.each(setups)("runs nothing on %s, and says how to opt in", async (_name, setup) => {
		const { io, output } = await open("octocat", { octocat: "admin" });
		const branch = setup();
		expect(await review(io, `main...${branch}`, { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain(
			"the head is a committed range, and nothing git records says whose code it is; pass --trust-head if you have read this code and want its tests run;",
		);
	});

	it.each(setups)("runs the head's tests on %s with --trust-head", async (_name, setup) => {
		const { io } = await open("octocat", { octocat: "read" });
		const branch = setup();
		expect(await review(io, `main...${branch}`, { rerun: false, walkthrough: false, trustHead: true })).toBe(0);
		expect(ran()).toBe(1);
	});

	it("runs a range that is not checked out with --trust-head", async () => {
		const { io } = await open("octocat", { octocat: "read" });
		gitIn(repo, "checkout", "--quiet", "main");
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false, trustHead: true })).toBe(0);
		expect(ran()).toBe(1);
	});

	// Base and head disagree on whether the check runs and for how long.
	const policies = (base: boolean) => {
		const policy = (enabled: boolean, timeout: number) =>
			`tiers:\n  full: [static.mutation]\nstatic:\n  mutation: { enabled: ${enabled}, timeout: ${timeout} }\n`;
		return { base: { "melian.yaml": policy(base, 120) }, head: { "melian.yaml": policy(!base, 600) } };
	};

	it("takes the working tree's enablement and timeout for a range vouched for", async () => {
		const { base, head } = policies(false);
		const { io } = await open("octocat", { octocat: "read" }, head, "static.mutation", {}, base);
		const selected = join(repo, "..", `${repo.split("/").at(-1)}-selected.json`);
		fakeTool(
			repo,
			"stryker",
			`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
cp "$2" '${selected}'
echo run >> '${calls}'
mkdir -p reports/mutation
echo '{"files":{}}' > reports/mutation/mutation.json`,
		);
		try {
			expect(await review(io, "main...feature", { rerun: false, walkthrough: false, trustHead: true })).toBe(0);
			expect(ran()).toBe(1);
			// Stryker's own limit follows Melian's timeout: 600 seconds is 10 minutes, where the base's 120 would be 2.
			expect(JSON.parse(readFileSync(selected, "utf8")).dryRunTimeoutMinutes).toBe(10);
		} finally {
			rmSync(selected, { force: true });
		}
	});

	it("takes a pull request's settings from the base GitHub names, not from the fork point", async () => {
		const disabled = "tiers:\n  full: [static.mutation]\nstatic:\n  mutation: { enabled: false, timeout: 120 }\n";
		const { io } = await open(
			"octocat",
			{ octocat: "admin" },
			{},
			"static.mutation",
			{},
			{ "melian.yaml": disabled },
		);
		// The base branch moves on after the fork point and turns the check on.
		gitIn(repo, "checkout", "--quiet", "main");
		writeFiles(repo, { "melian.yaml": disabled.replace("enabled: false", "enabled: true") });
		gitIn(repo, "commit", "--quiet", "-am", "enable mutation");
		const moved = gitIn(repo, "rev-parse", "HEAD");
		gitIn(repo, "checkout", "--quiet", "feature");
		const fetched = await targets.fetchedPullRequest(repo, {} as never, 7);
		vi.spyOn(targets, "fetchedPullRequest").mockResolvedValue({
			...fetched,
			pullRequest: { ...fetched.pullRequest, base: { ...fetched.pullRequest.base, sha: moved } },
		});
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(1);
	});

	it.each([
		[
			"off in the base and on in the working tree",
			false,
			"static.mutation  skipped: static.mutation.enabled is false",
		],
		["on in the base and off in the working tree", true, "pass --trust-head if you have read this code"],
	])("takes the base's enablement for a range not vouched for, %s", async (_name, enabled, reason) => {
		const { base, head } = policies(enabled);
		const { io, output } = await open("octocat", { octocat: "admin" }, head, "static.mutation", {}, base);
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).toBe(notReviewed);
		expect(ran()).toBe(false);
		expect(output()).toContain(reason);
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

	it("still runs a head the reviewer vouches for", async () => {
		const { io } = await open("octocat", { octocat: "read" }, {}, "static.mutation", {}, untrusting);
		await review(io, "main...feature", { rerun: false, walkthrough: false, trustHead: true });
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
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false, trustHead: true })).not.toBe(0);
		expect(ran()).toBe(1);
		expect(output()).not.toContain("Verdict: passed");
		expect(output()).toContain("test/setup.ts");
		expect(output()).toContain("active-mutant variable");
	});

	it("reads clean when nothing is forged, so the fixture proves the rule", async () => {
		const { io, output } = await open("octocat", { octocat: "admin" }, {}, "guardrails, static.mutation");
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false, trustHead: true })).toBe(0);
		expect(output()).toContain("Verdict: passed");
	});
});

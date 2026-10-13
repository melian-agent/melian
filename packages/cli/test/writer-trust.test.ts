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
		env: { ...process.env, MELIAN_TEST_SCRIPT: script, MELIAN_ISOLATED_RUNNER: "" } as NodeJS.ProcessEnv,
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
		expect(output()).toContain("the head is from a fork and this host is not an isolated runner");
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
		expect(output()).toContain(
			"the review's range head is not the checked-out commit, and this host is not an isolated runner",
		);
	});
});

describe("static.mutation on a host that declares itself an isolated runner", { timeout: 60_000 }, () => {
	const fork = { repository: { owner: "fork-owner", name: "example" } };

	it("runs a fork's head when the review is given the flag", async () => {
		const { io, output } = await open("stranger", { stranger: "read" }, {}, "static.mutation", fork);
		expect(await review(io, "#7", { rerun: false, walkthrough: false, isolatedRunner: true })).toBe(0);
		expect(ran()).toBe(1);
		expect(output()).toContain("Verdict: passed");
	});

	it("runs a fork's head when the host's environment declares it", async () => {
		const { io } = await open("stranger", { stranger: "read" }, {}, "static.mutation", fork);
		const declared = { ...io, env: { ...io.env, MELIAN_ISOLATED_RUNNER: "1" } };
		expect(await review(declared, "#7", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(1);
	});

	it.each(["true", "0", ""])("does not take MELIAN_ISOLATED_RUNNER=%j for the declaration", async (value) => {
		const { io, output } = await open("stranger", { stranger: "read" }, {}, "static.mutation", fork);
		const declared = { ...io, env: { ...io.env, MELIAN_ISOLATED_RUNNER: value } };
		expect(await review(declared, "#7", { rerun: false, walkthrough: false, isolatedRunner: false })).toBe(
			notReviewed,
		);
		expect(ran()).toBe(false);
		expect(output()).toContain("the head is from a fork and this host is not an isolated runner");
	});

	it("runs a range whose head is not checked out, and a head whose pusher could not be read", async () => {
		const range = await open("octocat", { octocat: "read" });
		gitIn(repo, "checkout", "--quiet", "main");
		expect(await review(range.io, "main...feature", { rerun: false, walkthrough: false, isolatedRunner: true })).toBe(
			0,
		);
		expect(ran()).toBe(1);
		rmSync(repo, { recursive: true, force: true });
		const unread = await open("maintainer", { maintainer: "admin" }, {}, "static.mutation", { failEvents: true });
		expect(await review(unread.io, "#7", { rerun: false, walkthrough: false, isolatedRunner: true })).toBe(0);
		expect(ran()).toBe(1);
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
		expect(output()).toContain(
			"trust.writers is false in the repository's policy, and this host is not an isolated runner",
		);
	});

	it("still runs the reviewer's own checked-out commit", async () => {
		const { io } = await open("octocat", { octocat: "read" }, {}, "static.mutation", {}, untrusting);
		await review(io, "main...feature", { rerun: false, walkthrough: false });
		expect(ran()).toBe(1);
	});

	it("still runs any head on an isolated runner", async () => {
		const { io } = await open("octocat", { octocat: "admin" }, {}, "static.mutation", {}, untrusting);
		await review(io, "#7", { rerun: false, walkthrough: false, isolatedRunner: true });
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

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { Sandbox } from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { fakeMutationProcesses } from "../../pipeline/test/fixtures/mutation-process.ts";
import { baseAndHead, fakeTool, gitIn, isolatedGitEnv, writeFiles } from "../../pipeline/test/fixtures/repo.ts";
import { unconfinedSandbox } from "../../pipeline/test/fixtures/sandbox.ts";
import { emptyVitestInstall } from "../../pipeline/test/fixtures/vitest-listing.ts";
import { review } from "../src/commands.ts";
import * as targets from "../src/target.ts";

let repo: string;
let calls: string;

beforeEach(() => {
	fakeMutationProcesses();
	// The fake Stryker records its calls in the checkout, which the real sandbox would not let it write.
	vi.spyOn(Sandbox, "detect").mockReturnValue(unconfinedSandbox);
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
) {
	repo = baseAndHead(
		{
			".gitignore": "node_modules\n",
			"src/a.ts": "export const a = 1;\n",
			"stryker.config.json": "{}\n",
			"melian.yaml": `tiers:\n  full: [${tier}]\nstatic:\n  mutation: { enabled: true, timeout: 120 }\n`,
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
		env: { ...process.env, MELIAN_TEST_SCRIPT: script },
		stdout: (text: string) => {
			output += text;
		},
		stderr: () => {},
		color: false,
	};
	return { io, output: () => output };
}

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
		"skips the check, with leave, and runs nothing for an author with %s permission",
		async (permission) => {
			const { io, output } = await open("octocat", { octocat: permission });
			expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
			expect(ran()).toBe(false);
			expect(output()).toContain("Verdict: passed");
			expect(output()).toContain(`the writer is not a trusted one (octocat has ${permission} permission`);
		},
	);

	it("skips the check when the provider names no author", async () => {
		const { io, output } = await open(undefined, {});
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(false);
		expect(output()).toContain("the provider names no author for the pull request");
	});

	it("skips the check when the author's permission cannot be read", async () => {
		const { io, output } = await open("octocat", { octocat: "surprise" });
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(false);
		expect(output()).toContain("octocat has no known permission on the repository");
	});

	it.each([
		{ owner: "fork-owner", name: "example" },
		{ owner: "melian-agent", name: "another" },
	])("refuses a maintainer's fork head %s", async (repository) => {
		const { io, output } = await open("maintainer", { maintainer: "admin" }, {}, "static.mutation", { repository });
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(false);
		expect(output()).toContain("head is in a fork");
	});
	it("refuses an absent head repository", async () => {
		const { io, output } = await open("maintainer", { maintainer: "admin" }, {}, "static.mutation", {
			repository: null,
		});
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
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
			expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
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
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
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
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(false);
		expect(output()).toContain("maintainer has no known permission");
	});
	it("refuses a failed pusher lookup rather than falling back to the writer author", async () => {
		const { io, output } = await open("maintainer", { maintainer: "admin" }, {}, "static.mutation", {
			failEvents: true,
		});
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(false);
		expect(output()).toContain("pushing identity could not be read");
	});

	it("runs the check for a range whose head is the checked-out commit, which the reviewer chose to run", async () => {
		const { io } = await open("octocat", { octocat: "read" });
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(1);
	});

	it("skips the check, with leave, for a range whose head is not the checked-out commit", async () => {
		const { io, output } = await open("octocat", { octocat: "admin" });
		gitIn(repo, "checkout", "--quiet", "main");
		expect(await review(io, "main...feature", { rerun: false, walkthrough: false })).toBe(0);
		expect(ran()).toBe(false);
		expect(output()).toContain("Verdict: passed");
		expect(output()).toContain(
			"the writer is not a trusted one (the review's range head is not the checked-out commit)",
		);
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

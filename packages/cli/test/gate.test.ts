import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Changeset,
	DirectoryRecordStore,
	pullRequestChangesetId,
	reviewPayloads,
	type SharedRecord,
} from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { configsFor } from "../../pipeline/src/configurations.ts";
import { ReviewRecords } from "../../pipeline/src/review-records.ts";
import { baseAndHead, gitIn, isolatedGitEnv } from "../../pipeline/test/fixtures/repo.ts";
import { main } from "../src/main.ts";
import * as targets from "../src/target.ts";

// A base that trusts writers, with a tier of one check, so a round accounts for little.
const trusting = "trust:\n  writers: true\ntiers:\n  full: [static.biome]\n";
const request = "d".repeat(64);
const cleanup: string[] = [];

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(): string {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "melian-gate-cli-")));
	cleanup.push(path);
	return path;
}

// A writer's pull request #7 whose base is `policy`, in a clone whose origin is a bare repository standing for GitHub's.
async function pullRequest(options: { policy?: string; origin?: string; decidedUnder?: string | null } = {}) {
	const repo = baseAndHead({ "melian.yaml": options.policy ?? trusting, "a.ts": "1\n" }, { "a.ts": "2\n" });
	cleanup.push(repo);
	const remote = join(scratch(), "origin.git");
	execFileSync("git", ["init", "--bare", "--quiet", remote], { env: { ...process.env, ...isolatedGitEnv } });
	gitIn(repo, "remote", "add", "origin", options.origin ?? remote);
	const range = await Changeset.resolve(repo, "main...feature");
	const changeset = range.withId(pullRequestChangesetId("github", { owner: "melian-agent", name: "example" }, 7));
	const state = pullRequestState();
	moveTo(state, changeset);
	state.author = "octocat";
	state.permissions = { octocat: "write" };
	state.activity = [
		{
			activity_type: "push",
			actor: { login: "octocat" },
			before: changeset.revision.base,
			after: changeset.revision.head,
			ref: `refs/heads/${state.pull.head.ref}`,
		},
	];
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test-token",
		fetch: fakeGitHub(state),
	});
	vi.spyOn(targets, "gitHubFor").mockResolvedValue(provider);
	vi.spyOn(targets, "fetchedPullRequest").mockResolvedValue({ pullRequest: await provider.pullRequest(7), changeset });
	const records = ReviewRecords.of(changeset.id, changeset.revision);
	const check = records.check(
		request,
		{ name: "static.biome", status: "ran", version: "2.0.0", findings: 0, notes: [] },
		[],
	);
	const account = records.account({
		checks: ["static.biome"],
		records: [check],
		filled: [],
		allowSkip: [],
		producers: [],
		// A round with no findings is decided under the base tip's policy, as a writer's round of it is.
		resolutionPolicy:
			options.decidedUnder !== undefined
				? options.decidedUnder
				: (await configsFor(repo, { kind: "revision", commit: state.pull.base.sha }, [])).fingerprint,
	});
	const round = records.round([check, account], undefined, [], []);
	let stdout = "";
	let stderr = "";
	const io = {
		cwd: repo,
		env: { ...process.env, MELIAN_STATE_DIR: scratch() } as NodeJS.ProcessEnv,
		stdout: (text: string) => {
			stdout += text;
		},
		stderr: (text: string) => {
			stderr += text;
		},
		color: false,
	};
	const relay = async (...written: SharedRecord[]) => {
		const directory = scratch();
		const store = await DirectoryRecordStore.open(directory, reviewPayloads);
		await store.add(written.map((record) => record.toJSON()));
		await store.close();
		const { base, head } = changeset.revision;
		const args = [
			"records",
			"relay",
			"#7",
			"--from",
			`dir:${directory}`,
			"--expect-base",
			base,
			"--expect-head",
			head,
		];
		expect(await main(args, io)).toBe(0);
		stdout = "";
		stderr = "";
	};
	const gate = (target = "#7") => main(["gate", target], io);
	return { changeset, check, account, round, relay, gate, out: () => stdout, err: () => stderr };
}

describe("melian gate", { timeout: 60_000 }, () => {
	it("lets a head merge that a round on melian/state reviewed whole", async () => {
		const { check, account, round, relay, gate, out, err } = await pullRequest();
		await relay(check, account, round);
		expect(await gate()).toBe(0);
		expect(err()).toBe(`melian: round ${round.id} counts, and covers 1 checks\n`);
		expect(out()).toContain("passed");
	});

	it("says no round reviewed the merge, and how to review it, when melian/state holds none", async () => {
		const { changeset, gate, out, err } = await pullRequest();
		expect(await gate()).toBe(2);
		expect(err()).toBe(
			`melian: the records cannot decide the merge: no round reviewed head ${changeset.revision.head} at a base the base tip holds\n` +
				"melian: the records cannot decide the merge. To review it again: gh workflow run melian-round.yml -f pull_request=7\n",
		);
		expect(out()).toContain("not reviewed");
	});

	it("names a counted round's own reason when it cannot stand as reviewed", async () => {
		const { check, account, round, relay, gate, err } = await pullRequest({ decidedUnder: null });
		await relay(check, account, round);
		expect(await gate()).toBe(2);
		expect(err()).toBe(
			`melian: round ${round.id} counts for its findings and covers no check: it was decided under no resolution policy, so no reader can decide it\n` +
				"melian: no counted round stands as reviewed of the merge's diff as it stands. To review it again: gh workflow run melian-round.yml -f pull_request=7\n",
		);
	});

	it("counts nothing when the base tip does not trust writers", async () => {
		const { gate, out, err } = await pullRequest({ policy: "tiers:\n  full: [static.biome]\n" });
		expect(await gate()).toBe(2);
		expect(err()).toBe(
			"melian: the base tip's melian.yaml does not set trust.writers: true, so no record in the store counts\n",
		);
		expect(out()).toBe("");
	});

	it("names only the store's code when melian/state cannot be read, never git's words", async () => {
		const { gate, err } = await pullRequest({ origin: join(scratch(), "missing.git") });
		expect(await gate()).toBe(2);
		expect(err()).toBe("melian: melian/state could not be read (unreachable), so nothing was decided\n");
	});

	it("takes a pull request alone", async () => {
		const { gate, err } = await pullRequest();
		expect(await gate("main...feature")).toBe(2);
		expect(err()).toBe('melian: gate takes a pull request such as "#12"\n');
	});
});

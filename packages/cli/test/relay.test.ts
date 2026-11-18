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
	const path = realpathSync(mkdtempSync(join(tmpdir(), "melian-relay-cli-")));
	cleanup.push(path);
	return path;
}

// A pull request #7 whose base is `policy`, pushed by octocat with `permission`, in a clone whose origin is a bare
// repository standing for GitHub's.
async function pullRequest(options: { policy?: string; permission?: string; fork?: boolean; origin?: string } = {}) {
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
	state.permissions = { octocat: options.permission ?? "write" };
	if (options.fork === true) state.headRepository = { owner: "someone", name: "example" };
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
		resolutionPolicy: null,
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
	const relay = (artefact: string, expect: { base: string; head: string } = changeset.revision, ...extra: string[]) =>
		main(
			[
				"records",
				"relay",
				"#7",
				"--from",
				`dir:${artefact}`,
				"--expect-base",
				expect.base,
				"--expect-head",
				expect.head,
				...extra,
			],
			io,
		);
	const onState = () => {
		try {
			return execFileSync("git", ["ls-tree", "-r", "--name-only", "melian/state"], {
				cwd: remote,
				env: { ...process.env, ...isolatedGitEnv },
			})
				.toString()
				.split("\n")
				.filter(Boolean);
		} catch {
			return undefined;
		}
	};
	return { changeset, check, account, round, relay, onState, out: () => stdout, err: () => stderr };
}

async function artefact(...written: SharedRecord[]): Promise<string> {
	const directory = scratch();
	const store = await DirectoryRecordStore.open(directory, reviewPayloads);
	await store.add(written.map((record) => record.toJSON()));
	await store.close();
	return directory;
}

describe("melian records relay", { timeout: 60_000 }, () => {
	it("adds a writer's round and the records it reads to melian/state", async () => {
		const { check, account, round, relay, onState, out } = await pullRequest();
		expect(await relay(await artefact(check, account, round))).toBe(0);
		expect(onState()?.sort()).toEqual([check.path, account.path, round.path].sort());
		expect(out()).toBe("melian: relayed 3 records of pull request #7 to melian/state\n");
	});

	it("checks a writer's batch with --check and writes nothing", async () => {
		const { check, account, round, relay, onState, out } = await pullRequest();
		expect(await relay(await artefact(check, account, round), undefined, "--check")).toBe(0);
		expect(onState()).toBeUndefined();
		expect(out()).toBe("melian: the relay would add 3 records of pull request #7 to melian/state\n");
	});

	it("refuses a round whose account the base's tier does not give", async () => {
		const policy = "trust:\n  writers: true\ntiers:\n  full: [static.biome, static.tsc]\n";
		const { check, account, round, relay, onState, err } = await pullRequest({ policy });
		expect(await relay(await artefact(check, account, round))).toBe(1);
		expect(onState()).toBeUndefined();
		expect(err()).toBe(
			`melian: melian records relay refused the batch: ${round.id}.json is a round whose account differs from what the base's tier and the round's own records give (otherChecks)\n`,
		);
	});

	it("refuses with --check what the relay refuses", async () => {
		const { round, relay, onState, err } = await pullRequest();
		expect(await relay(await artefact(round), undefined, "--check")).toBe(1);
		expect(onState()).toBeUndefined();
		expect(err()).toBe(
			`melian: melian records relay refused the batch: ${round.id}.json is a round that reads a record the batch does not hold\n`,
		);
	});

	it("refuses a fork's round, and melian/state is never created", async () => {
		const { check, round, relay, onState, err } = await pullRequest({ fork: true });
		expect(await relay(await artefact(check, round))).toBe(1);
		expect(onState()).toBeUndefined();
		expect(err()).toBe(
			`melian: melian records relay refused the batch: ${round.id}.json is a kind of record the head's job may not hand over\n`,
		);
	});

	it("hands over what a fork's head may when the pusher is no writer", async () => {
		const { check, round, relay, onState } = await pullRequest({ permission: "read" });
		expect(await relay(await artefact(check, round))).toBe(1);
		expect(await relay(await artefact(check))).toBe(0);
		expect(onState()).toEqual([check.path]);
	});

	it("refuses a pull request that moved from the approved head", async () => {
		const { changeset, check, relay, onState, err } = await pullRequest();
		expect(await relay(await artefact(check), { base: changeset.revision.base, head: "e".repeat(40) })).toBe(1);
		expect(onState()).toBeUndefined();
		expect(err()).toContain("so nothing was relayed");
	});

	it("refuses when the base does not trust writers", async () => {
		const { check, relay, onState, err } = await pullRequest({ policy: "tiers:\n  full: []\n" });
		expect(await relay(await artefact(check))).toBe(1);
		expect(onState()).toBeUndefined();
		expect(err()).toBe("melian: the base's melian.yaml does not set trust.writers: true, so nothing was relayed\n");
	});

	it("names only the store's code when the push fails, never git's words", async () => {
		const missing = join(scratch(), "missing.git");
		const { check, account, round, relay, err } = await pullRequest({ origin: missing });
		expect(await relay(await artefact(check, account, round))).toBe(1);
		expect(err()).toBe(
			"melian: melian/state refused or failed the relay (unreachable); repeat the relay, which completes a batch that landed in part\n",
		);
	});

	it.each([
		[["records"], "records takes a subcommand: relay"],
		[
			["records", "relay", "main...feature", "--from", "dir:x", "--expect-base", "a", "--expect-head", "b"],
			"not a range",
		],
		[["records", "relay", "#7", "--expect-base", "a", "--expect-head", "b"], "takes one --from"],
		[["records", "relay", "#7", "--from", "file:x", "--expect-base", "a", "--expect-head", "b"], "takes one --from"],
		[
			["records", "relay", "#7", "--from", "dir:x", "--from", "dir:y", "--expect-base", "a", "--expect-head", "b"],
			"takes one --from",
		],
		[["records", "relay", "#7", "--from", "dir:x"], "takes --expect-base and --expect-head"],
		[["review", "#7", "--check"], "--check is only available for records relay"],
	])("refuses %j as usage", async (args, said) => {
		let stderr = "";
		const code = await main(args, {
			cwd: "/unused",
			env: {},
			color: false,
			stdout: () => {},
			stderr: (text) => {
				stderr += text;
			},
		});
		expect(code).toBe(64);
		expect(stderr).toContain(said);
	});
});

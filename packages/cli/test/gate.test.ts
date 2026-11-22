import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Changeset,
	DirectoryRecordStore,
	Finding,
	pullRequestChangesetId,
	reviewPayloads,
	type SharedRecord,
	type StoredFinding,
} from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { RecordGate } from "@melian-agent/pipeline";
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

// A writer's pull request, #7 unless `number` says otherwise, whose base is `policy`, in a clone whose origin is a bare repository standing for GitHub's.
async function pullRequest(
	options: {
		policy?: string;
		origin?: string;
		decidedUnder?: string | null;
		sightings?: StoredFinding[];
		skipped?: string;
		state?: string;
		number?: number;
	} = {},
) {
	const number = options.number ?? 7;
	const repo = baseAndHead({ "melian.yaml": options.policy ?? trusting, "a.ts": "1\n" }, { "a.ts": "2\n" });
	cleanup.push(repo);
	const remote = join(scratch(), "origin.git");
	execFileSync("git", ["init", "--bare", "--quiet", remote], { env: { ...process.env, ...isolatedGitEnv } });
	gitIn(repo, "remote", "add", "origin", options.origin ?? remote);
	const range = await Changeset.resolve(repo, "main...feature");
	const changeset = range.withId(pullRequestChangesetId("github", { owner: "melian-agent", name: "example" }, number));
	const state = pullRequestState();
	state.pull.number = number;
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
	vi.spyOn(targets, "fetchedPullRequest").mockResolvedValue({
		pullRequest: await provider.pullRequest(number),
		changeset,
	});
	const records = ReviewRecords.of(changeset.id, changeset.revision);
	const check = records.check(
		request,
		{ name: "static.biome", status: "ran", version: "2.0.0", findings: options.sightings?.length ?? 0, notes: [] },
		options.sightings ?? [],
	);
	const facts = {
		checks: options.skipped === undefined ? ["static.biome"] : ["static.biome", options.skipped],
		records: [check],
		filled:
			options.skipped === undefined
				? []
				: [{ name: options.skipped, status: "skipped" as const, reason: "no TypeScript" }],
		allowSkip: [],
		producers: [{ check: "static.biome", version: "2.0.0" }],
	} as const;
	const account = records.account({
		...facts,
		// A round with no findings is decided under the base tip's policy, as a writer's round of it is.
		resolutionPolicy:
			options.decidedUnder !== undefined
				? options.decidedUnder
				: (
						await configsFor(
							repo,
							{ kind: "revision", commit: state.pull.base.sha },
							(options.sightings ?? []).map((each) => Finding.from(each)),
						)
					).fingerprint,
	});
	const round = records.round([check, account], undefined, [], []);
	let stdout = "";
	let stderr = "";
	const io = {
		cwd: repo,
		env: { ...process.env, MELIAN_STATE_DIR: options.state ?? scratch() } as NodeJS.ProcessEnv,
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
			`#${number}`,
			"--from",
			`dir:${directory}`,
			"--expect-base",
			base,
			"--expect-head",
			head,
		];
		expect(await main(args, io), stderr).toBe(0);
		stdout = "";
		stderr = "";
	};
	const gate = (target = `#${number}`) => main(["gate", target], io);
	// The same pull request, as GitHub answers once its head is a fork's: a writer can add a fork's round to melian/state by hand.
	const fromFork = async () => {
		state.headRepository = { owner: "someone", name: "example" };
		vi.spyOn(targets, "fetchedPullRequest").mockResolvedValue({
			pullRequest: await provider.pullRequest(number),
			changeset,
		});
	};
	return {
		changeset,
		records,
		facts,
		check,
		account,
		round,
		relay,
		gate,
		fromFork,
		out: () => stdout,
		err: () => stderr,
	};
}

// A P1 Biome finding on the head's changed line, which blocks under the default resolution.
const blocker = (): StoredFinding =>
	Finding.create({
		rule: "biome/suspicious/noDebugger",
		message: "Biome reports suspicious/noDebugger.",
		file: "a.ts",
		startLine: 1,
		snippet: "2",
		occurrence: 0,
		severity: "P1",
		cause: "introduced",
		source: { check: "static.biome", version: "2.0.0" },
		explanation: { what: "A debugger statement.", whyHere: "The change added it.", whatToDo: "Remove it." },
	}).toJSON();

describe("melian gate", { timeout: 60_000 }, () => {
	it("prints no dismiss command for a finding a pooled round of another revision holds live, and says only a push clears it", async () => {
		const { check, account, round, relay, gate, err } = await pullRequest();
		await relay(check, account, round);
		const decide = RecordGate.decide.bind(RecordGate);
		const heldBy = { round: "r9", revision: "older..head" };
		vi.spyOn(RecordGate, "decide").mockImplementation(async (...args) =>
			Object.assign(Object.create(RecordGate.prototype), await decide(...args), {
				ended: [
					{ finding: "0123456789abcdef", record: "r1", madeAt: "base..one", round: "r2", at: "base..two", heldBy },
				],
				unjudged: [{ finding: "fedcba9876543210", record: "r3", round: "r4", heldBy }],
			}),
		);
		await gate();
		vi.restoreAllMocks();
		const held =
			"Round r9 holds it live, and reviewed older..head, another revision of this head; a dismissal holds only at the revision it was made at, so no dismissal at this head clears it: today only a push, which starts a new head, clears it";
		expect(err().split("\n").slice(1, 3)).toEqual([
			`melian: finding 0123456789abcdef is live: it was dismissed at revision base..one, and round r2 reviewed base..two since, which ends it: any round of another revision does, a round of this head at another base included, such as a stacked parent's. ${held}`,
			`melian: finding fedcba9876543210 is live: dismissal r3 cannot be judged, since round r4 names a record or round the store does not hold. ${held}`,
		]);
	});

	it("lets a head merge that a round on melian/state reviewed whole", async () => {
		const { check, account, round, relay, gate, out, err } = await pullRequest();
		await relay(check, account, round);
		expect(await gate()).toBe(0);
		expect(err()).toBe(`melian: round ${round.id} counts, and covers 1 checks\n`);
		expect(out()).toContain("passed");
	});

	it("names each dismissal a round ended or cannot judge, and the command that dismisses it again", async () => {
		const { check, account, round, relay, gate, err } = await pullRequest();
		await relay(check, account, round);
		const decide = RecordGate.decide.bind(RecordGate);
		vi.spyOn(RecordGate, "decide").mockImplementation(async (...args) =>
			Object.assign(Object.create(RecordGate.prototype), await decide(...args), {
				ended: [{ finding: "0123456789abcdef", record: "r1", madeAt: "base..one", round: "r2", at: "base..two" }],
				unjudged: [{ finding: "fedcba9876543210", record: "r3", round: "r4" }],
			}),
		);
		expect(await gate()).toBe(0);
		expect(err()).toBe(
			[
				`melian: round ${round.id} counts, and covers 1 checks`,
				`melian: finding 0123456789abcdef is live: it was dismissed at revision base..one, and round r2 reviewed base..two since, which ends it: any round of another revision does, a round of this head at another base included, such as a stacked parent's. To dismiss it at this head, with a reason other than the one it was dismissed with, since the same dismissal made again records nothing new: melian dismiss "#7" 0123456789abcdef --reason "<text>" --records git:melian/state`,
				'melian: finding fedcba9876543210 is live: dismissal r3 cannot be judged, since round r4 names a record or round the store does not hold. To dismiss it at this head, with a reason other than the one it was dismissed with, since the same dismissal made again records nothing new: melian dismiss "#7" fedcba9876543210 --reason "<text>" --records git:melian/state',
				"",
			].join("\n"),
		);
	});

	it("prints every command it suggests so that a shell passes each argument whole, and escapes what the store wrote", async () => {
		const shell = (command: string) =>
			execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], { encoding: "utf8" })
				.split("\n")
				.slice(0, -1);
		const commands = (text: string) =>
			[...text.matchAll(/(?:records nothing new|To review it again): (.*)$/gm)].map(([, command]) =>
				shell(command!),
			);
		const dismissed = await pullRequest({ number: 12 });
		await dismissed.relay(dismissed.check, dismissed.account, dismissed.round);
		const decide = RecordGate.decide.bind(RecordGate);
		vi.spyOn(RecordGate, "decide").mockImplementation(async (...args) =>
			Object.assign(Object.create(RecordGate.prototype), await decide(...args), {
				ended: [
					{
						finding: "0123456789abcdef",
						record: "r1",
						madeAt: "base..one\u001b[2J",
						round: "r2",
						at: "base..two",
					},
				],
				unjudged: [{ finding: "fedcba9876543210", record: "r3", round: "r4" }],
			}),
		);
		expect(await dismissed.gate()).toBe(0);
		expect(dismissed.err()).toContain("dismissed at revision base..one\\u001b[2J, and");
		const dismiss = (finding: string) => [
			"melian",
			"dismiss",
			"#12",
			finding,
			"--reason",
			"<text>",
			"--records",
			"git:melian/state",
		];
		expect(commands(dismissed.err())).toEqual([dismiss("0123456789abcdef"), dismiss("fedcba9876543210")]);
		vi.restoreAllMocks();
		const unreviewed = await pullRequest({ number: 12 });
		expect(await unreviewed.gate()).toBe(2);
		expect(commands(unreviewed.err())).toEqual([
			["gh", "workflow", "run", "melian-round.yml", "-f", "pull_request=12"],
		]);
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
			`melian: round ${round.id} counts for its findings and covers no check: it was decided under no resolution policy, so no reader can decide it. Like a round whose verifier did not finish, it lowers nothing: its findings count as no verifier judged them, uncapped, and no later round's verdict clears one: to answer one, push a fix or dismiss it\n` +
				"melian: no counted round stands as reviewed of the merge's diff as it stands. To review it again: gh workflow run melian-round.yml -f pull_request=7\n",
		);
	});

	it("says a sound round of another revision keeps its verifier's verdicts, and one that is not sound lowers nothing", async () => {
		const { check, account, round, relay, gate, err } = await pullRequest();
		await relay(check, account, round);
		const decide = RecordGate.decide.bind(RecordGate);
		const refused = { refused: "reviewed base..head, not this merge's tip..head" };
		vi.spyOn(RecordGate, "decide").mockImplementation(async (...args) =>
			Object.assign(Object.create(RecordGate.prototype), await decide(...args), {
				rounds: [
					{ id: "r1", revision: "base..head", covers: refused, sound: true },
					{ id: "r2", revision: "base..head", covers: refused, sound: false },
				],
			}),
		);
		await gate();
		vi.restoreAllMocks();
		expect(err().split("\n").slice(0, 2)).toEqual([
			"melian: round r1 counts for its findings and covers no check: it reviewed base..head, not this merge's tip..head. Its verifier's verdicts stand",
			"melian: round r2 counts for its findings and covers no check: it reviewed base..head, not this merge's tip..head. Like a round whose verifier did not finish, it lowers nothing: its findings count as no verifier judged them, uncapped, and no later round's verdict clears one. It reviewed another revision of this head, and a dismissal holds only at the revision it was made at, so no dismissal at this head clears one: today only a push, which starts a new head, clears it",
		]);
	});

	it("passes no fork's head, though a round of it in melian/state found nothing, until a pinned key signs its records", async () => {
		const { check, account, round, relay, gate, fromFork, out, err } = await pullRequest();
		await relay(check, account, round);
		await fromFork();
		expect(await gate()).toBe(2);
		expect(err()).toBe(
			"melian: the head is not a writer's (the head is from a fork), and only a record the trusted host's pinned key signed counts for such a head; no key is pinned, so no record in the store counts\n",
		);
		expect(out()).toBe("");
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

	it("blocks a head whose round found a blocking finding, and prints it with its ID and what decided it", async () => {
		const sighting = blocker();
		const { check, account, round, relay, gate, out, err } = await pullRequest({ sightings: [sighting] });
		await relay(check, account, round);
		expect(await gate(), `${err()}${out()}`).toBe(1);
		expect(out()).toContain(`Finding ${sighting.properties.id}`);
		expect(out()).toContain("Decided by");
		expect(out()).not.toContain("\u001b[");
	});

	it("says a round that ran only part of the base tip's tier leaves the merge unreviewed", async () => {
		const policy = "trust:\n  writers: true\ntiers:\n  full: [static.biome, static.tsc]\n";
		const { check, account, round, relay, gate, err } = await pullRequest({ policy, skipped: "static.tsc" });
		await relay(check, account, round);
		expect(await gate()).toBe(2);
		expect(err()).toBe(
			`melian: round ${round.id} counts, and covers 1 checks\n` +
				"melian: no round that stands as reviewed ran every check the base tip's tier requires. To review it again: gh workflow run melian-round.yml -f pull_request=7\n",
		);
	});

	it("names the tier as unmet, not the rounds as stale, when one counted round stands and another does not", async () => {
		const policy = "trust:\n  writers: true\ntiers:\n  full: [static.biome, static.tsc]\n";
		const { records, facts, check, account, round, relay, gate, err } = await pullRequest({
			policy,
			skipped: "static.tsc",
		});
		const undecided = records.account({ ...facts, resolutionPolicy: null });
		const other = records.round([check, undecided], undefined, [], []);
		await relay(check, account, round);
		await relay(check, undecided, other);
		expect(await gate()).toBe(2);
		expect(err()).toContain(
			"melian: no round that stands as reviewed ran every check the base tip's tier requires. To review it again:",
		);
	});

	it("leaves out a finding the policy silences", async () => {
		const sighting = blocker();
		const quiet = Finding.create({
			rule: "biome/style/useConst",
			message: "Biome reports style/useConst.",
			file: "a.ts",
			startLine: 1,
			snippet: "2",
			occurrence: 0,
			severity: "nit",
			cause: "introduced",
			source: { check: "static.biome", version: "2.0.0" },
			explanation: { what: "A let.", whyHere: "The change added it.", whatToDo: "Use const." },
		}).toJSON();
		const { check, account, round, relay, gate, out } = await pullRequest({ sightings: [sighting, quiet] });
		await relay(check, account, round);
		expect(await gate()).toBe(1);
		expect(out()).toContain(`Finding ${sighting.properties.id}`);
		expect(out()).not.toContain(quiet.properties.id);
	});

	it("names only the store's code when its state directory cannot hold it", async () => {
		const state = join(scratch(), "state");
		writeFileSync(state, "not a directory\n");
		const { gate, err } = await pullRequest({ state });
		expect(await gate()).toBe(2);
		expect(err()).toMatch(/^melian: melian\/state could not be read \([a-zA-Z]+\), so nothing was decided\n$/);
	});

	it("reads the tier the base tip's pull-request stage names", async () => {
		const policy =
			"trust:\n  writers: true\nstages:\n  pull-request: quick\ntiers:\n  quick: [static.biome]\n  full: [static.biome, static.tsc]\n";
		const { check, account, round, relay, gate } = await pullRequest({ policy });
		await relay(check, account, round);
		expect(await gate()).toBe(0);
	});

	it("takes a pull request alone", async () => {
		const { gate, err } = await pullRequest();
		expect(await gate("main...feature")).toBe(2);
		expect(err()).toBe('melian: gate takes a pull request such as "#12"\n');
	});
});

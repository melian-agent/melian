import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Adjudication, defaultConfig, PullRequestMembership, pullRequestChangesetId } from "@melian-agent/core";
import {
	CompareHarness,
	backgroundContext as context,
	MembershipReader,
	openSqliteStorage,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, temporaryDirectory } from "../../core/test/fixtures/repo.ts";
import { VerdictDocument } from "../../pipeline/src/adjudication.ts";
import { PublisherDocument } from "../../pipeline/src/publish.ts";
import { legacyKey, RoundsDocument } from "../../pipeline/src/rounds.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import { storagePath } from "../src/repository.ts";

const changeset = "range-0123456789abcdef";
const round = `${changeset}.r1`;
const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
	.adjudicate()
	.toJSON();
let repo: string;
let io: Io;
let base: string;
let head: string;
let recording: string;
let store: string;
const output = () =>
	vi
		.mocked(io.stdout)
		.mock.calls.map(([text]) => text)
		.join("");
const errors = () =>
	vi
		.mocked(io.stderr)
		.mock.calls.map(([text]) => text)
		.join("");

function record(patch: { base?: string; head?: string; before?: string | null; associated?: number[] } = {}) {
	const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
	const pull = { baseRefOid: patch.base ?? base, headRefOid: patch.head ?? head, mergeCommit: null };
	writeFileSync(
		recording,
		JSON.stringify({
			owner: "owner",
			repo: "repo",
			graphql: {
				MelianRoundCommits: [
					{
						data: {
							repository: {
								pullRequest: { ...pull, commits: connection([{ commit: { oid: patch.head ?? head } }]) },
							},
						},
					},
				],
				MelianRoundPushes: [
					{
						data: {
							repository: {
								pullRequest: {
									...pull,
									timelineItems: connection(
										patch.before === undefined
											? []
											: [
													{
														beforeCommit: patch.before === null ? null : { oid: patch.before },
														afterCommit: { oid: patch.head ?? head },
													},
												],
									),
								},
							},
						},
					},
				],
				MelianRoundAssociations: [
					{
						data: {
							repository: {
								object: {
									associatedPullRequests: connection(
										(patch.associated ?? [7]).map((number) => ({
											number,
											repository: { name: "repo", owner: { login: "owner" } },
										})),
									),
								},
							},
						},
					},
				],
			},
		}),
	);
}
beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "base");
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "-qm", "base");
	base = gitIn(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "a.txt"), "head");
	gitIn(repo, "commit", "-qam", "head");
	head = gitIn(repo, "rev-parse", "HEAD");
	gitIn(repo, "remote", "add", "origin", "git@github.com:owner/repo.git");
	recording = join(repo, "github.json");
	io = {
		cwd: repo,
		env: { MELIAN_TEST_SCRIPT: "unused.json", MELIAN_TEST_GITHUB: recording, MELIAN_STATE_DIR: join(repo, "state") },
		color: false,
		stdout: vi.fn(),
		stderr: vi.fn(),
	};
	record();
	store = await storagePath(repo, changeset, io.env, true);
	const harness = await CompareHarness.open(await openSqliteStorage(store), createFakeModels().review, changeset);
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		const rounds = await tx.doc(RoundsDocument, root.id);
		rounds.items.r1 = { base, head, tasks: [], mintedAt: "2026-10-26T00:00:00Z", verdict };
		rounds.items.r2 = { base, head: base, tasks: [], mintedAt: "2026-10-26T00:01:00Z", verdict };
	}, context);
	await harness.importFindings({ base, head, round }, [], "2026-10-26T00:00:00Z");
	await harness.close();
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(repo, { recursive: true, force: true });
});

it.each(["json", "markdown"])(
	"refuses an offline %s export when a saved Git member gains foreign publication ownership",
	async (format) => {
		expect(await main(["compare", "#7"], io)).toBe(0);
		const pull = pullRequestChangesetId("github", { owner: "owner", name: "repo" }, 7);
		const path = await storagePath(repo, pull, io.env, true);
		const readHistory = async () => {
			const storage = await openSqliteStorage(path);
			try {
				return (await MembershipReader.open(storage).history()).versions;
			} finally {
				await storage.close(context);
			}
		};
		const before = await readHistory();
		expect(before[0]!.members[0]!.reason).toBe("exact pull request merge base");
		const harness = await CompareHarness.open(await openSqliteStorage(store), createFakeModels().review, changeset);
		try {
			const root = await harness.harness.root(context);
			await root.commit(async (tx) => {
				(await tx.doc(PublisherDocument, root.id)).target = {
					repository: "owner/repo",
					pullRequest: 8,
					baseRef: "main",
					baseTip: base,
					base,
					head,
					revision: `${base}..${head}`,
					roundId: "r1",
				};
			}, context);
		} finally {
			await harness.close();
		}
		rmSync(recording);
		const out = join(repo, "existing-export");
		writeFileSync(out, "previous export");
		vi.mocked(io.stdout).mockClear();
		expect(await main(["compare", "export", "#7", ...(format === "json" ? ["--json"] : []), "--out", out], io)).toBe(
			1,
		);
		expect(readFileSync(out, "utf8")).toBe("previous export");
		expect(output()).toBe("");
		for (const value of [round, 'compare refresh "#7"', "--accept"]) expect(errors()).toContain(value);
		expect(await readHistory()).toEqual(before);
	},
);

it("reads a range's rounds through #N, snapshots membership, and exports/stats entirely offline", async () => {
	expect(await main(["compare", "#7"], io), errors()).toBe(0);
	expect(output()).toContain(`Round 1: ${round}`);
	expect(output().split("\n")).toContain(`Round 1: ${round}`);
	expect(output()).toContain("1 added, 0 removed");
	expect(output()).toContain("Unattributed rounds in member-holding stores: 1.");
	rmSync(recording);
	gitIn(repo, "update-ref", "-d", "refs/heads/main");
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "export", "#7", "--json"], io), errors()).toBe(0);
	const exported = JSON.parse(output()) as {
		comparisons: Record<string, unknown>;
		membership: { members: { id: string; number: number }[]; unattributed: { id: string }[] };
		history: unknown[];
	};
	expect(Object.keys(exported.comparisons)).toEqual([round]);
	expect(exported.membership.members).toMatchObject([{ id: round, number: 1 }]);
	expect(exported.membership.unattributed).toMatchObject([{ id: `${changeset}.r2` }]);
	expect(exported.history).toHaveLength(1);
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "stats"], io), errors()).toBe(0);
	expect(output()).toContain("Unattributed pull request rounds: 1.");
	vi.mocked(io.stdout).mockClear();
	const path = join(repo, "export.md");
	expect(await main(["compare", "export", "#7", "--out", path], io), errors()).toBe(0);
	expect(readFileSync(path, "utf8")).toContain("https://github.com/owner/repo/pull/7");
});
it("keeps the old snapshot on rejected refresh, then audits an explicit acceptance", async () => {
	expect(await main(["compare", "#7"], io)).toBe(0);
	record({ base: head });
	const opened = vi.spyOn(CompareHarness, "open");
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "#7"], io)).toBe(1);
	expect(output()).toBe("");
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "refresh", "#7"], io)).toBe(1);
	expect(errors()).toContain("--accept");
	expect(output()).toBe("");
	expect(opened.mock.calls.length).toBe(0);
	vi.mocked(io.stderr).mockClear();
	expect(await main(["compare", "refresh", "#7", "--accept"], io), errors()).toBe(0);
	expect(output()).toContain("snapshot 2");
	expect(output()).toContain("0 added, 1 removed");
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "export", "#7", "--json"], io)).toBe(0);
	const exported = JSON.parse(output()) as {
		history: { members: { id: string }[]; audit: { round: string; by: string; reason: string }[] }[];
	};
	expect(exported.history[0]!.members).toMatchObject([{ id: round }]);
	expect(exported.history[1]!.audit).toMatchObject([
		{ round, by: "Melian Test <test@melian.invalid>", reason: "stored base is not an exact pull request merge base" },
	]);
});
it("retains a deleted member's store as unreachable and keeps missing-before warnings", async () => {
	record({ before: null });
	expect(await main(["compare", "#7"], io)).toBe(0);
	expect(output()).toContain("rounds at that head may be absent");
	rmSync(store);
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "refresh", "#7"], io), errors()).toBe(0);
	expect(output()).toContain(`Round 1: ${round} (unreachable)`);
});
it.each(
	[
		["compare", "#7", "--accept"],
		["compare", "refresh", "main"],
		["compare", "refresh", "#7", "--from", "github"],
		["compare", "refresh", "#7", "--round", round],
		["findings", "--accept"],
		["findings", "refresh", "--accept"],
	].map((args) => ({ args })),
)("scopes refresh arguments: %j", async ({ args }) => {
	expect(await main(args, io)).toBe(64);
});

it("retains prior ownership when its head is unavailable, then restores availability with the same number", async () => {
	const storage = await openSqliteStorage(store);
	const harness = await CompareHarness.open(storage, createFakeModels().review, changeset);
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(RoundsDocument, root.id)).items.r1!.provenance = {
			kind: "pull-request",
			repository: { owner: "owner", name: "repo" },
			pullRequest: 7,
			policy: "test",
			manifest: [],
			lenses: [],
		};
	}, context);
	await harness.close();
	const availability = vi.spyOn(PullRequestMembership.prototype, "headAvailable").mockResolvedValue(false);
	expect(await main(["compare", "#7"], io)).toBe(0);
	expect(availability).not.toHaveBeenCalled();
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "refresh", "#7"], io), errors()).toBe(0);
	expect(output()).toContain(`Round 1: ${round} (unreachable)`);
	expect(availability).toHaveBeenCalledExactlyOnceWith(head);
	availability.mockResolvedValue(true);
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "refresh", "#7"], io), errors()).toBe(0);
	expect(output()).toContain(`Round 1: ${round}`);
	expect(output()).not.toContain("(unreachable)");
});

it("creates an empty membership snapshot when the scripted state directory has no stores yet", async () => {
	rmSync(join(store, ".."), { recursive: true, force: true });
	expect(await main(["compare", "#7"], io), errors()).toBe(0);
	expect(output()).toContain("0 member rounds (snapshot 1)");
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "export", "#7", "--json"], io)).toBe(0);
	expect(JSON.parse(output()).membership.members).toEqual([]);
});

it("lists an exact-base round as ambiguous with other pull request numbers and excludes unrelated unattributed rounds", async () => {
	record({ associated: [7, 12, 19] });
	expect(await main(["compare", "#7"], io), errors()).toBe(0);
	expect(output()).toContain(`Ambiguous: ${round}: head is associated with other pull requests (#12, #19)`);
	expect(output()).toContain("0 member rounds");
	expect(output()).toContain("Unattributed rounds in member-holding stores: 0.");
});

it("exports existing pull-request comparisons and then reads membership through historical publication ownership", async () => {
	const id = pullRequestChangesetId("github", { owner: "owner", name: "repo" }, 7);
	const key = legacyKey(`${base}..${head}`);
	const path = await storagePath(repo, id, io.env, true);
	const storage = await openSqliteStorage(path);
	const harness = await CompareHarness.open(storage, createFakeModels().review, id);
	const root = await harness.harness.root(context);
	const latest = {
		repository: "owner/repo",
		pullRequest: 8,
		baseRef: "main",
		baseTip: base,
		base,
		head,
		revision: `${base}..${head}`,
		roundId: key,
	};
	await root.commit(async (tx) => {
		(await tx.doc(RoundsDocument, root.id)).items[key] = { base, head, tasks: [], verdict };
		(await tx.doc(PublisherDocument, root.id)).target = latest;
		(await tx.doc(VerdictDocument, root.id)).verdicts[`${base}..${head}`] = verdict;
	}, context);
	await storage.commit(
		[
			{
				type: "task",
				value: {
					id: await storage.mintId(),
					kind: "melian.publish",
					version: 6,
					conversationId: root.id,
					background: false,
					abortRequested: false,
					input: {
						root: root.id,
						publishedBy: { trustedWriters: true },
						target: { ...latest, pullRequest: 7 },
						lines: {},
					},
					state: {
						status: "terminal",
						outcome: {
							status: "completed",
							result: { kind: "superseded", reason: "a later target was recorded" },
						},
					},
				},
			},
		],
		context,
	);
	await harness.importFindings({ base, head, round: `${id}.${key}` }, [], "2026-10-26T00:00:00Z");
	await harness.close();
	rmSync(recording);
	expect(await main(["compare", "export", "#7", "--json"], io), errors()).toBe(0);
	const exported = JSON.parse(output()) as { comparisons: Record<string, unknown>; membership?: unknown };
	expect(Object.keys(exported.comparisons)).toEqual([`${id}.${key}`]);
	expect(exported.membership).toBeUndefined();
	record();
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "#7"], io), errors()).toBe(0);
	expect(output()).toContain("2 member rounds");
});

it("counts distinct unattributed rounds instead of dropped placeholder identities", async () => {
	const harness = await CompareHarness.open(await openSqliteStorage(store), createFakeModels().review, changeset);
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(RoundsDocument, root.id)).items.r3 = {
			base,
			head: base,
			tasks: [],
			mintedAt: "2026-10-26T00:02:00Z",
			verdict,
		};
	}, context);
	await harness.close();
	expect(await main(["compare", "#7"], io)).toBe(0);
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "stats"], io)).toBe(0);
	expect(output()).toContain("Unattributed pull request rounds: 2.");
});

it("exports a retained missing range head only as an unreachable member", async () => {
	expect(await main(["compare", "#7"], io)).toBe(0);
	rmSync(join(repo, ".git", "objects", head.slice(0, 2), head.slice(2)));
	// Fail the SSH transport before Git can make a network connection.
	vi.stubEnv("GIT_SSH_COMMAND", "false");
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "refresh", "#7"], io), errors()).toBe(0);
	expect(output()).toContain(`Round 1: ${round} (unreachable)`);
	expect(output()).not.toContain(`Foreign: ${round}`);
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "export", "#7", "--json"], io)).toBe(0);
	const exported = JSON.parse(output()) as {
		membership: { members: { id: string; status: string }[]; foreign: unknown[] };
	};
	expect(exported.membership.members).toMatchObject([{ id: round, status: "unreachable" }]);
	expect(exported.membership.foreign).toEqual([]);
});

it("writes an offline export to the requested file and reports its path", async () => {
	expect(await main(["compare", "#7"], io)).toBe(0);
	rmSync(recording);
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "export", "#7", "--json", "--out", "membership.json"], io)).toBe(0);
	expect(output()).toBe(`Exported comparison to ${join(repo, "membership.json")}.\n`);
	expect(JSON.parse(readFileSync(join(repo, "membership.json"), "utf8")).membership.members[0].id).toBe(round);
});
it("exports snapshot warnings and unattributed round reasons offline", async () => {
	const harness = await CompareHarness.open(await openSqliteStorage(store), createFakeModels().review, changeset);
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(RoundsDocument, root.id)).items.r2 = { base, head: base, tasks: [], verdict };
	}, context);
	await harness.close();
	record({ before: null });
	expect(await main(["compare", "#7"], io)).toBe(0);
	rmSync(recording);
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "export", "#7"], io)).toBe(0);
	expect(output()).toContain("A force push has no before commit; rounds at that head may be absent.");
	expect(output()).toContain(`Unattributed: ${changeset}.r2: GitHub no longer names this head`);
});

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PullRequestRoundHeads, RoundMembership } from "@melian-agent/core";
import {
	CompareHarness,
	backgroundContext as context,
	createMemoryStorage,
	MembershipReader,
	openSqliteStorage,
	PullRequestRoundHistory,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { defineDoc, type TaskId } from "../src/harness.ts";
import { PublisherDocument } from "../src/publish.ts";
import { PullRequestRoundsDocument } from "../src/pull-request-rounds.ts";
import { legacyKey, RoundsDocument } from "../src/rounds.ts";

const changeset = "range-0123456789abcdef";
const pull = "pull-0123456789abcdef";
const answer: PullRequestRoundHeads = {
	repository: { owner: "owner", name: "repo" },
	number: 7,
	base: "a".repeat(40),
	head: "b".repeat(40),
	merge: null,
	commits: ["b".repeat(40)],
	forcePushes: [],
	associated: {},
};
const at = "2026-10-26T01:00:00Z";
const member: RoundMembership = {
	id: `${changeset}.r1`,
	base: answer.base,
	head: answer.head,
	mintedAt: at,
	status: "member",
	reason: "exact pull request merge base",
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});

it("versions snapshots and refuses newly rejected members without changing storage", async () => {
	const storage = createMemoryStorage();
	const harness = await CompareHarness.open(storage, createFakeModels().review, pull);
	cleanup.push(() => harness.close());
	const first = await harness.refreshMembership(answer, [member], "Alice <alice@example.com>", at);
	expect(first).toEqual({
		version: 1,
		at,
		answer,
		members: [{ ...member, number: 1 }],
		foreign: [],
		ambiguous: [],
		unattributed: [],
		warnings: [],
		audit: [],
	});
	const rejected: RoundMembership = {
		...member,
		status: "foreign",
		reason: "stored base is not an exact pull request merge base",
	};
	await expect(harness.refreshMembership({ ...answer, base: member.head }, [rejected], "Bob", at)).rejects.toThrow(
		'compare refresh "#7" --accept',
	);
	expect((await MembershipReader.open(storage).history()).versions).toEqual([first]);
	const second = await harness.refreshMembership(answer, [rejected], "Bob", "2026-10-26T02:00:00Z", true);
	expect(second).toEqual({
		version: 2,
		at: "2026-10-26T02:00:00Z",
		answer,
		members: [],
		foreign: [rejected],
		ambiguous: [],
		unattributed: [],
		warnings: [],
		audit: [{ round: member.id, by: "Bob", at: "2026-10-26T02:00:00Z", reason: rejected.reason }],
	});
	expect((await MembershipReader.open(storage).history()).versions).toEqual([first, second]);
});
it("keeps missing stores and missing commits as unreachable members with reserved numbers", () => {
	const history = PullRequestRoundHistory.from([]);
	const second = { ...member, id: `${changeset}.r2`, mintedAt: "2026-10-26T02:00:00Z" };
	history.refresh(answer, [member, second], "Alice", at, false);
	const legacy: RoundMembership = { ...member, mintedAt: undefined, id: `${changeset}.k0123456789abcdef`, date: 1 };
	const absent = {
		...member,
		status: "foreign" as const,
		missingCommit: member.head,
		reason: `commit ${member.head} is missing after fetch`,
	};
	const snapshot = history.refresh(answer, [absent, legacy], "Bob", at, false);
	expect(snapshot.members.map(({ id, status, number }) => ({ id, status, number }))).toEqual([
		{ id: member.id, status: "unreachable", number: 1 },
		{ id: second.id, status: "unreachable", number: 2 },
		{ id: legacy.id, status: "member", number: 3 },
	]);
	expect(snapshot.audit).toEqual([]);
	expect(snapshot.foreign).toEqual([]);
	const fresh = PullRequestRoundHistory.from([]).refresh(answer, [absent], "Bob", at, false);
	expect(fresh.members).toEqual([]);
	expect(fresh.foreign).toEqual([absent]);
});
it("requires acceptance when a locally readable earlier member is no longer a GitHub head", () => {
	const history = PullRequestRoundHistory.from([]);
	history.refresh(answer, [member], "Alice", at, false);
	const rejected = { ...member, status: "unattributed" as const, reason: "GitHub no longer names this head" };
	expect(() => history.refresh(answer, [rejected], "Bob", at, false)).toThrow("old snapshot kept");
	expect(history.versions).toHaveLength(1);
	expect(history.refresh(answer, [rejected], "Bob", at, true)).toMatchObject({
		members: [],
		foreign: [{ ...rejected, status: "foreign" }],
		unattributed: [],
		audit: [{ round: member.id, by: "Bob", at, reason: rejected.reason }],
	});
});
it("numbers legacy before minted by date then ID and counts only member-holding stores", () => {
	const history = PullRequestRoundHistory.from([]);
	const legacy = { ...member, mintedAt: undefined, id: `${changeset}.k1111111111111111`, date: 100 };
	const earlier = { ...legacy, id: `${changeset}.k0000000000000000`, date: 50 };
	const sameDate = { ...legacy, id: `${changeset}.k2222222222222222` };
	const unknown = { ...legacy, id: `${changeset}.k3333333333333333`, date: undefined };
	const ambiguous = { ...member, id: `${changeset}.r3`, status: "ambiguous" as const, otherPullRequests: [8] };
	const unattributed = { ...member, id: `${changeset}.r4`, status: "unattributed" as const };
	const unrelated = { ...unattributed, id: "range-fedcba9876543210.r1" };
	const snapshot = history.refresh(
		{ ...answer, forcePushes: [{ before: null, after: answer.head }] },
		[unknown, member, sameDate, legacy, earlier, ambiguous, unattributed, unrelated],
		"Alice",
		at,
		false,
	);
	expect(snapshot.members.map(({ id, number }) => ({ id, number }))).toEqual(
		[earlier, legacy, sameDate, unknown, member].map(({ id }, i) => ({ id, number: i + 1 })),
	);
	expect(snapshot.ambiguous).toEqual([ambiguous]);
	expect(snapshot.unattributed).toEqual([unattributed]);
	expect(snapshot.warnings).toEqual(["A force push has no before commit; rounds at that head may be absent."]);
});
it("reopens the real version-1 SQLite snapshot with every answer, number and audit unchanged", async () => {
	const directory = mkdtempSync(join(tmpdir(), "melian-membership-"));
	cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "rounds.sqlite");
	const storage = await openSqliteStorage(path);
	const harness = await CompareHarness.open(storage, createFakeModels().review, pull);
	const first = await harness.refreshMembership(answer, [member], "Alice", at);
	const second = await harness.refreshMembership(
		answer,
		[{ ...member, status: "foreign", reason: "retargeted" }],
		"Bob",
		at,
		true,
	);
	await harness.close();
	const reopened = await openSqliteStorage(path);
	cleanup.push(() => reopened.close(context));
	expect(PullRequestRoundsDocument.definition.version).toBe(1);
	expect((await MembershipReader.open(reopened).history()).versions).toEqual([first, second]);
});
it("reads ownership through detached reads and binds a publication to one of two rounds at a revision", async () => {
	const storage = createMemoryStorage();
	const harness = await CompareHarness.open(storage, createFakeModels().review, changeset);
	cleanup.push(() => harness.close());
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		const rounds = await tx.doc(RoundsDocument, root.id);
		rounds.items.r1 = { base: answer.base, head: answer.head, tasks: [] };
		rounds.items.r2 = {
			base: answer.base,
			head: answer.head,
			tasks: [],
			provenance: {
				kind: "pull-request",
				repository: answer.repository,
				pullRequest: 8,
				policy: "test",
				manifest: [],
				lenses: [],
			},
		};
		(await tx.doc(PublisherDocument, root.id)).target = {
			repository: "owner/repo",
			pullRequest: 7,
			baseRef: "main",
			baseTip: answer.base,
			base: answer.base,
			head: answer.head,
			revision: `${answer.base}..${answer.head}`,
			roundId: "r1",
		};
	}, context);
	const commits = vi.spyOn(storage, "commit");
	expect(await MembershipReader.open(storage).candidates(changeset)).toEqual([
		{
			id: `${changeset}.r1`,
			base: answer.base,
			head: answer.head,
			publication: { repository: answer.repository, pullRequest: 7 },
		},
		{
			id: `${changeset}.r2`,
			base: answer.base,
			head: answer.head,
			provenance: {
				kind: "pull-request",
				repository: answer.repository,
				pullRequest: 8,
				policy: "test",
				manifest: [],
				lenses: [],
			},
		},
	]);
	expect((await MembershipReader.open(storage).history()).versions).toEqual([]);
	expect(commits).not.toHaveBeenCalled();
});

it("retains historical terminal publication targets past a full task page and after the latest target changes", async () => {
	const storage = createMemoryStorage();
	const harness = await CompareHarness.open(storage, createFakeModels().review, changeset);
	cleanup.push(() => harness.close());
	const root = await harness.harness.root(context);
	const target = {
		repository: "owner/repo",
		pullRequest: 8,
		baseRef: "main",
		baseTip: answer.base,
		base: answer.base,
		head: answer.head,
		revision: `${answer.base}..${answer.head}`,
		roundId: "r2",
	};
	await root.commit(async (tx) => {
		const rounds = await tx.doc(RoundsDocument, root.id);
		rounds.items.r1 = { base: answer.base, head: answer.head, mintedAt: at, tasks: [] };
		rounds.items.r2 = { base: answer.base, head: answer.head, mintedAt: at, tasks: [] };
		(await tx.doc(PublisherDocument, root.id)).target = target;
	}, context);
	for (let i = 0; i < 201; i++)
		await storage.commit(
			[
				{
					type: "task",
					value: {
						id: await storage.mintId<TaskId<string>>(),
						kind: "melian.publish",
						version: 6,
						conversationId: root.id,
						background: false,
						abortRequested: false,
						input: i === 200 ? { target: { ...target, roundId: "r1", pullRequest: 7 } } : {},
						state: { status: "terminal", outcome: { status: "completed", result: "published" } },
					},
				},
			],
			context,
		);
	const scan = vi.spyOn(storage, "scanTasks");
	const commits = vi.spyOn(storage, "commit");
	for (const number of [7, 8]) {
		const candidates = await MembershipReader.open(storage).candidates(changeset, {
			repository: answer.repository,
			pullRequest: number,
		});
		expect(candidates.map(({ id, publication }) => ({ id, publication }))).toEqual([
			{ id: `${changeset}.r1`, publication: { repository: answer.repository, pullRequest: 7 } },
			{ id: `${changeset}.r2`, publication: { repository: answer.repository, pullRequest: 8 } },
		]);
	}
	expect(scan).toHaveBeenCalledTimes(4);
	expect(scan.mock.calls[1]![2]).toBeDefined();
	expect(commits).not.toHaveBeenCalled();
});
it("keeps legacy publication ownership confined to its legacy round after a later mint at the same revision", async () => {
	const storage = createMemoryStorage();
	const harness = await CompareHarness.open(storage, createFakeModels().review, changeset);
	cleanup.push(() => harness.close());
	const root = await harness.harness.root(context);
	const revision = `${answer.base}..${answer.head}`;
	const key = legacyKey(revision);
	await root.commit(async (tx) => {
		(await tx.doc(RoundsDocument, root.id)).items[key] = { base: answer.base, head: answer.head, tasks: [] };
	}, context);
	await storage.commit(
		[
			{
				type: "task",
				value: {
					id: await storage.mintId<TaskId<string>>(),
					kind: "melian.publish",
					version: 5,
					conversationId: root.id,
					background: false,
					abortRequested: false,
					input: { target: { repository: "owner/repo", pullRequest: 7, revision } },
					state: { status: "terminal", outcome: { status: "completed", result: "published" } },
				},
			},
		],
		context,
	);
	expect((await MembershipReader.open(storage).candidates(changeset))[0]!.publication).toEqual({
		repository: answer.repository,
		pullRequest: 7,
	});
	await root.commit(async (tx) => {
		(await tx.doc(RoundsDocument, root.id)).items.r1 = {
			base: answer.base,
			head: answer.head,
			mintedAt: at,
			tasks: [],
		};
	}, context);
	expect((await MembershipReader.open(storage).candidates(changeset)).map(({ publication }) => publication)).toEqual([
		{ repository: answer.repository, pullRequest: 7 },
		undefined,
	]);
});

it("renumbers recovered members by the specified order when a new earlier legacy round arrived", () => {
	const history = PullRequestRoundHistory.from([]);
	history.refresh(answer, [member], "Alice", at, false);
	const legacy = { ...member, id: `${changeset}.k0123456789abcdef`, mintedAt: undefined, date: 1 };
	history.refresh(
		answer,
		[{ ...member, status: "unreachable", reason: "head unavailable after fetch" }, legacy],
		"Alice",
		at,
		false,
	);
	const recovered = history.refresh(answer, [member, legacy], "Alice", at, false);
	expect(recovered.members.map(({ id, number, status }) => ({ id, number, status }))).toEqual([
		{ id: legacy.id, number: 1, status: "member" },
		{ id: member.id, number: 2, status: "member" },
	]);
});

it("reads original pre-round publication ownership without migrating documents or resuming its pending task", async () => {
	const directory = mkdtempSync(join(tmpdir(), "melian-membership-legacy-"));
	cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "legacy.sqlite");
	copyFileSync(new URL("./fixtures/publish-rounds/main-36122eb2/pending.sqlite", import.meta.url), path);
	const storage = await openSqliteStorage(path);
	cleanup.push(() => storage.close(context));
	const commits = vi.spyOn(storage, "commit");
	const candidates = await MembershipReader.open(storage).candidates("range-8fb67dfe2bac6ead");
	expect(candidates).toHaveLength(1);
	expect(candidates[0]!.publication).toEqual({
		repository: { owner: "melian-agent", name: "example" },
		pullRequest: 7,
	});
	expect(candidates[0]!.id).toBe(
		`range-8fb67dfe2bac6ead.${legacyKey("f61f38089105716c5f1433047d014817b42b70ae..04c31b8d66a1a2d28b118014cfd8d46991ee246e")}`,
	);
	expect(commits).not.toHaveBeenCalled();
});
it("refuses a future snapshot version through detached reads", async () => {
	const storage = createMemoryStorage();
	const harness = await CompareHarness.open(storage, createFakeModels().review, pull);
	cleanup.push(() => harness.close());
	const root = await harness.harness.root(context);
	const future = defineDoc({
		...PullRequestRoundsDocument.definition,
		version: 2,
		scope: "conversation",
		history: "latest",
		fork: "current",
	});
	await root.commit(async (tx) => {
		await tx.doc(future, root.id);
	}, context);
	await expect(MembershipReader.open(storage).history()).rejects.toThrow(
		"melian.pull-request-rounds has newer version 2",
	);
});
it("handles a document disappearing between detached address and value reads", async () => {
	const storage = createMemoryStorage();
	const harness = await CompareHarness.open(storage, createFakeModels().review, pull);
	cleanup.push(() => harness.close());
	await harness.refreshMembership(answer, [member], "Alice", at);
	vi.spyOn(storage, "document").mockResolvedValueOnce(undefined);
	expect((await MembershipReader.open(storage).history()).versions).toEqual([]);
});

it("finishes assigning numbers around reserved unreachable ordinals", () => {
	const result = execFileSync(
		process.execPath,
		[
			"--conditions=@melian-agent/source",
			fileURLToPath(new URL("./fixtures/pull-request-numbering.ts", import.meta.url)),
			JSON.stringify({ answer, member, at }),
		],
		{ encoding: "utf8", timeout: 10000 },
	);
	expect(JSON.parse(result)).toEqual([1, 2, 3]);
}, 15000);

it("finishes detached publication scans when storage has no task continuation", () => {
	const result = execFileSync(
		process.execPath,
		["--conditions=@melian-agent/source", fileURLToPath(new URL("./fixtures/pull-request-scan.ts", import.meta.url))],
		{ encoding: "utf8", timeout: 10000 },
	);
	expect(JSON.parse(result)).toEqual([]);
}, 15000);

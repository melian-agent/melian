import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, expect, it, vi } from "vitest";
import { type FakeState, fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../src/adjudication.ts";
import {
	backgroundContext as context,
	createReviewRegistry,
	defineTask,
	type Harness,
	openHarness,
	openSqliteStorage,
	type TaskId,
} from "../src/index.ts";
import { PublisherDocument, publishExtension, publishReview } from "../src/publish.ts";
import { reviewChangeset } from "../src/review.ts";
import { RoundsDocument, RoundWriter } from "../src/rounds.ts";
import { createFakeModels } from "../src/testing.ts";
import { baseAndHead, isolatedGitEnv } from "./fixtures/repo.ts";

const directories: string[] = [];
const opened: Harness[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of opened.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

async function pendingPublication(rounds = "minted") {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	const repo = baseAndHead({ "a.ts": "export const n = 1;\n" }, { "a.ts": "export const n = 2;\n" });
	directories.push(repo);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const state = pullRequestState();
	moveTo(state, changeset);
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test-token",
		fetch: fakeGitHub(state),
	});
	const fake = createFakeModels();
	const registry = createReviewRegistry();
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-publish-pending-")));
	directories.push(directory);
	const path = join(directory, "state.sqlite");
	let harness = await openHarness(await openSqliteStorage(path), { models: fake.models, registry });
	opened.push(harness);
	await harness.root(context, { agent: { model: fake.ref() } });
	for (const status of ["ran", "failed"] as const)
		await reviewChangeset({
			harness,
			changeset,
			config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
			lenses: [],
			standards: [],
			models: fake.review,
			checks: [{ name: "static.mutation", status }],
			policy: { kind: "revision", commit: changeset.revision.base },
			origin: {
				kind: "pull-request",
				repository: { owner: state.owner, name: state.repo },
				pullRequest: 7,
				base: changeset.revision.base,
				head: changeset.revision.head,
			},
		});
	await harness.close(context);
	registry.install(publishExtension(provider));
	harness = await openHarness(await openSqliteStorage(path), { models: fake.models, registry });
	opened.push(harness);
	const root = await harness.root(context);
	if (rounds !== "minted")
		await root.commit(async (tx) => {
			const stored = await tx.doc(RoundsDocument, root.id);
			stored.current = {};
			if (rounds === "legacy") Object.assign(stored, RoundsDocument.definition.initial());
		}, context);
	const resume = vi.spyOn(harness, "resume").mockImplementation(() => undefined);
	const wait = vi.spyOn(harness, "waitForTask").mockRejectedValue(new Error("parked publication"));
	await expect(
		publishReview({
			harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: false,
		}),
	).rejects.toThrow("parked publication");
	resume.mockRestore();
	wait.mockRestore();
	const pending = (await harness.inspect(context)).tasks.find((each) => each.record.kind === "melian.publish")!;
	return { harness, root, pending, state, provider, changeset };
}

it("records the current round in both the publisher target and its pending task", async () => {
	const { harness, root, pending } = await pendingPublication();
	expect((await harness.snapshot(RoundsDocument, root.id, context))?.sequence).toBe(2);
	expect((await harness.snapshot(PublisherDocument, root.id, context))?.target).toMatchObject({ roundId: "r2" });
	expect(pending.record.input).toMatchObject({ target: { roundId: "r2" } });
});

it("supersedes a pending publication when only its recorded round changes", async () => {
	const { harness, root, pending, state, provider } = await pendingPublication();
	await root.commit(async (tx) => {
		Object.assign((await tx.doc(PublisherDocument, root.id)).target!, { roundId: "r3" });
	}, context);
	const posts = vi.spyOn(provider, "setStatus");
	harness.resume();
	const done = await harness.waitForTask(pending.record.id, context);
	expect(done.state.outcome).toMatchObject({
		status: "completed",
		result: { kind: "superseded", reason: "its roundId was r2, and is r3 now" },
	});
	expect(posts).not.toHaveBeenCalled();
	expect(state.reviews).toEqual([]);
});

it.each(["minted", "legacy"])(
	"publishes its recorded %s round after a later round deletes the live verdict",
	async (mode) => {
		const { harness, root, pending, provider } = await pendingPublication(mode);
		const state = (await harness.snapshot(RoundsDocument, root.id, context))!;
		const revision = Object.keys(state.current)[0]!;
		await root.commit((tx) => new RoundWriter(tx, root.id).mint(revision, 999, "2026-10-18T12:00:00Z"), context);
		const posted = vi.spyOn(provider, "postReview");
		harness.resume();
		const done = await harness.waitForTask(pending.record.id, context);
		expect(done.state.outcome).toMatchObject({ status: "completed", result: { kind: "published" } });
		expect(posted).toHaveBeenCalledOnce();
		expect(posted.mock.calls[0]![0].verdict.toJSON()).toEqual(state.items[state.current[revision]!]!.verdict);
	},
);

it.each(["round", "verdict"])(
	"refuses a minted target whose %s is missing instead of using the live verdict",
	async (missing) => {
		const { harness, root, pending, state, provider, changeset } = await pendingPublication();
		const revision = `${changeset.revision.base}..${changeset.revision.head}`;
		expect((await harness.snapshot(VerdictDocument, root.id, context))?.verdicts[revision]).toBeDefined();
		await root.commit(async (tx) => {
			const rounds = await tx.doc(RoundsDocument, root.id);
			if (missing === "round") delete rounds.items.r2;
			else delete rounds.items.r2!.verdict;
		}, context);
		const posted = vi.spyOn(provider, "postReview");
		harness.resume();
		const done = await harness.waitForTask(pending.record.id, context);
		expect(done.state.outcome).toMatchObject({
			status: "failed",
			error: { message: `no verdict is recorded for ${revision}` },
		});
		expect(posted).not.toHaveBeenCalled();
		expect(state.reviews).toEqual([]);
	},
);

it.each(["legacy", "unselected"])("records a legacy target when the round state is %s", async (mode) => {
	const { harness, root, pending, changeset } = await pendingPublication(mode);
	const revision = `${changeset.revision.base}..${changeset.revision.head}`;
	const legacy = `k${createHash("sha256").update(revision).digest("hex").slice(0, 16)}`;
	expect((await harness.snapshot(PublisherDocument, root.id, context))?.target?.roundId).toBe(legacy);
	expect(pending.record.input).toMatchObject({ target: { roundId: legacy } });
	if (mode === "legacy") {
		const rounds = await harness.snapshot(RoundsDocument, root.id, context);
		expect(rounds?.recorded[revision]).toBe(true);
		expect(rounds?.items[legacy]?.verdict).toEqual(
			(await harness.snapshot(VerdictDocument, root.id, context))?.verdicts[revision],
		);
	}
});

it("supersedes a bound task when its publisher target is unbound beside minted rounds", async () => {
	const { harness, root, pending, state } = await pendingPublication();
	await root.commit(async (tx) => {
		Reflect.deleteProperty((await tx.doc(PublisherDocument, root.id)).target!, "roundId");
	}, context);
	harness.resume();
	const done = await harness.waitForTask(pending.record.id, context);
	expect(done.state.outcome).toMatchObject({
		status: "completed",
		result: { kind: "superseded", reason: expect.stringContaining("round cannot be proven") },
	});
	expect(state.statuses).toEqual([]);
	expect(state.reviews).toEqual([]);
});

it.each(["task", "publisher"])("supersedes a publication with no %s target", async (missing) => {
	const { harness, root, pending, state } = await pendingPublication();
	let id = pending.record.id;
	if (missing === "task") {
		await harness.abortTask(id, context);
		const publisher = (await harness.snapshot(PublisherDocument, root.id, context))!;
		const input = { root: root.id, publishedBy: publisher.publishedBy!, lines: {} };
		const previous = defineTask<typeof input, { phase: "publish" }, never>({
			name: "melian.publish",
			version: 5,
			initial: () => ({ phase: "publish" }),
			phases: {
				publish: async () => {
					throw new Error("must use the installed publisher");
				},
			},
			abort: async () => {
				throw new Error("must use the installed publisher");
			},
		});
		id = await root.commit((tx) => tx.createTask(previous, input, { ownership: { kind: "conversation" } }), context);
	} else {
		await root.commit(async (tx) => {
			delete (await tx.doc(PublisherDocument, root.id)).target;
		}, context);
	}
	harness.resume();
	const done = await harness.waitForTask(id, context);
	expect(done.state.outcome).toMatchObject({
		status: "completed",
		result: {
			kind: "superseded",
			reason: missing === "task" ? "the task recorded no target" : "no target is recorded",
		},
	});
	expect(state.statuses).toEqual([]);
	expect(state.reviews).toEqual([]);
});

it("upgrades publisher trust only from version 1 and keeps absent targets absent", () => {
	const migrate = PublisherDocument.definition.migrate!;
	expect(migrate({}, 1)).toEqual({ publishedBy: { trustedWriters: true } });
	expect(migrate({ trustedWriters: false }, 1)).toEqual({ publishedBy: { trustedWriters: false } });
	const attribution = { trustedWriters: false, login: "original", permission: "read", authorPermission: "none" };
	expect(migrate({ publishedBy: attribution }, 2)).toEqual({ publishedBy: attribution });
});

it("upgrades targetless task inputs without losing newer attribution", () => {
	const provider = createGitHubProvider({
		owner: "example",
		repo: "repo",
		token: "test-token",
		fetch: fakeGitHub(pullRequestState()),
	});
	const migrate = publishExtension(provider).tasks![0]!.definition.migrate as (
		input: unknown,
		checkpoint: unknown,
		from: number,
	) => { input: unknown };
	expect(migrate({ root: 1, lines: {} }, { phase: "publish" }, 1).input).toEqual({
		root: 1,
		lines: {},
		publishedBy: { trustedWriters: true },
	});
	const input = {
		root: 1,
		lines: {},
		publishedBy: { trustedWriters: false, login: "original", permission: "read", authorPermission: "none" },
	};
	for (const version of [2, 3, 4, 5]) expect(migrate(input, { phase: "publish" }, version).input).toEqual(input);
});

it.each(["main-36122eb2", "main-other-revision", "main-preserved", "build1-6bd298c0", "build1-later-6bd298c0"])(
	"reopens %s without guessing an unbound publication round",
	async (name) => {
		const fixture = new URL(
			`./fixtures/publish-rounds/${name.startsWith("main-") ? "main-36122eb2" : name}/`,
			import.meta.url,
		);
		const previous = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
			pending: number;
			changeset: { revision: { base: string; head: string } };
			state: FakeState;
		};
		const { base, head } = previous.changeset.revision;
		const key = `${base}..${head}`;
		const legacy = `k${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-publish-rounds-")));
		directories.push(directory);
		const path = join(directory, "pending.sqlite");
		copyFileSync(new URL("pending.sqlite", fixture), path);
		const storage = await openSqliteStorage(path);
		const provider = createGitHubProvider({
			owner: previous.state.owner,
			repo: previous.state.repo,
			token: "test-token",
			fetch: fakeGitHub(previous.state),
		});
		const fake = createFakeModels();
		const registry = createReviewRegistry();
		registry.install(publishExtension(provider));
		const harness = await openHarness(storage, { models: fake.models, registry });
		opened.push(harness);
		const root = await harness.root(context);
		if (name === "main-other-revision")
			await root.commit(
				(tx) => new RoundWriter(tx, root.id).mint(`${head}..${base}`, 999, "2026-10-18T12:00:00Z"),
				context,
			);
		if (name === "main-preserved") await root.commit((tx) => new RoundWriter(tx, root.id).preserve(key), context);
		const rounds = await harness.snapshot(RoundsDocument, root.id, context);
		expect(rounds?.sequence ?? 0).toBe(
			name === "main-36122eb2" || name === "main-preserved"
				? 0
				: name === "main-other-revision"
					? 1
					: name === "build1-6bd298c0"
						? 2
						: 3,
		);
		if (name.startsWith("build1")) {
			expect(rounds?.current[key]).toBe(name === "build1-6bd298c0" ? "r2" : "r3");
			expect(rounds?.items.r1).toMatchObject({ base, head });
			expect(rounds?.items.r2).toMatchObject({ base, head });
		}
		const publisher = await harness.snapshot(PublisherDocument, root.id, context);
		expect(publisher?.target).toMatchObject({ revision: key });
		expect(publisher?.target).not.toHaveProperty("roundId");
		expect(publisher?.publishedBy?.trustedWriters).toBe(false);
		const done = await harness.waitForTask(previous.pending as TaskId, context);
		expect(done.input).not.toHaveProperty("target.roundId");
		if (name.startsWith("build1")) {
			expect(done.state.outcome).toMatchObject({
				status: "completed",
				result: { kind: "superseded", reason: expect.stringContaining("round cannot be proven") },
			});
			expect(previous.state.reviews).toEqual([]);
			expect(previous.state.statuses).toEqual([]);
			expect(fake.provider.state.callCount).toBe(0);
			return;
		}
		expect(done.state.outcome).toMatchObject({ status: "completed", result: { kind: "published" } });
		expect((await harness.snapshot(PublisherDocument, root.id, context))?.target?.roundId).toBe(legacy);
		expect(done.input).toMatchObject({ publishedBy: { trustedWriters: false } });
		expect(done.version).toBe(6);
		expect(previous.state.reviews).toHaveLength(1);
		expect(previous.state.statuses.at(-1)?.state).toBe("error");
		expect(fake.provider.state.callCount).toBe(0);
	},
);

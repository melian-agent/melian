import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Changeset, defaultConfig, Finding, type ReviewProvider } from "@melian-agent/core";
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
	upsertFinding,
} from "../src/index.ts";
import { PublisherDocument, PublishHarness, publishExtension, publishReview } from "../src/publish.ts";
import { reviewChangeset } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
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

async function pendingPublication(rounds = "minted", statuses: readonly ("ran" | "failed")[] = ["ran", "failed"]) {
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
	for (const status of statuses)
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
			else {
				const revision = `${changeset.revision.base}..${changeset.revision.head}`;
				const live = await tx.doc(VerdictDocument, root.id);
				await new RoundWriter(tx, root.id).record(
					revision,
					0,
					live.verdicts[revision]!,
					live.provenance![revision]!,
				);
				stored.current = {};
			}
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
	return { harness, root, pending, state, provider, changeset, path };
}

it("supersedes a pending publication when its publisher has no target", async () => {
	const { harness, root, pending, state, provider } = await pendingPublication();
	await root.commit(async (tx) => {
		delete (await tx.doc(PublisherDocument, root.id)).target;
	}, context);
	const posts = vi.spyOn(provider, "setStatus");
	harness.resume();
	const done = await harness.waitForTask(pending.record.id, context);
	expect(done.state.outcome).toMatchObject({
		status: "completed",
		result: { kind: "superseded", reason: "no target is recorded" },
	});
	expect(posts).not.toHaveBeenCalled();
	expect(state.reviews).toEqual([]);
});

it("supersedes a crashed passing publication after a review-only harness records a blocking round", async () => {
	const { harness, root, pending, state, provider, changeset, path } = await pendingPublication("minted", ["ran"]);
	const revision = `${changeset.revision.base}..${changeset.revision.head}`;
	expect((await harness.snapshot(RoundsDocument, root.id, context))?.items.r1?.verdict?.status).toBe("passed");
	await harness.close(context);
	const log = join(changeset.repoRoot, "publish-crash.log");
	const stateFile = join(changeset.repoRoot, "publish-state.json");
	writeFileSync(stateFile, JSON.stringify(state));
	const child = spawn(
		process.execPath,
		[
			"--conditions=@melian-agent/source",
			fileURLToPath(new URL("./fixtures/publish-round-crash.ts", import.meta.url)),
			path,
			stateFile,
			log,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise<string | number | null>((resolve) =>
		child.on("exit", (code, signal) => resolve(signal ?? code)),
	);
	try {
		const deadline = Date.now() + 15_000;
		while (!existsSync(log) || !readFileSync(log, "utf8").includes("before-verdict\n")) {
			if (child.exitCode !== null || child.signalCode !== null) throw new Error(`child exited: ${stderr}`);
			if (Date.now() > deadline) throw new Error(`child missed crash point: ${stderr}`);
			await sleep(20);
		}
	} finally {
		child.kill("SIGKILL");
		await exited;
	}
	expect(await exited).toBe("SIGKILL");
	const fake = createFakeModels();
	const reviewOnly = await openHarness(await openSqliteStorage(path), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	opened.push(reviewOnly);
	const reviewing = await reviewOnly.root(context);
	await reviewing.commit(
		(tx) =>
			upsertFinding(
				tx,
				reviewing.id,
				Finding.create({
					rule: "unsafe",
					file: "a.ts",
					startLine: 1,
					snippet: "export const n = 2;",
					occurrence: 0,
					cause: "introduced",
					severity: "P1",
					source: { check: "static.mutation" },
					message: "Blocking second review",
					explanation: { what: "Unsafe", whyHere: "New code", whatToDo: "Validate" },
				}),
				revision,
			),
		context,
	);
	const reviewed = await reviewChangeset({
		harness: reviewOnly,
		changeset,
		config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
		lenses: [],
		standards: [],
		models: fake.review,
		checks: [{ name: "static.mutation", status: "ran" }],
		policy: { kind: "revision", commit: changeset.revision.base },
		origin: {
			kind: "pull-request",
			repository: { owner: state.owner, name: state.repo },
			pullRequest: 7,
			base: changeset.revision.base,
			head: changeset.revision.head,
		},
	});
	expect(reviewed.verdict.blocking).toBe(true);
	expect((await reviewOnly.snapshot(PublisherDocument, reviewing.id, context))?.target?.roundId).toBe("r1");
	expect((await reviewOnly.snapshot(RoundsDocument, reviewing.id, context))?.current[revision]).toBe("r2");
	expect(
		(await reviewOnly.inspect(context)).tasks.find((each) => each.record.id === pending.record.id)?.state.kind,
	).toBe("blocked");
	await reviewOnly.close(context);
	const begin = vi.spyOn(provider, "beginPublish");
	const posts = vi.spyOn(provider, "postReview");
	const statuses = vi.spyOn(provider, "setStatus");
	const publisher = await PublishHarness.open(await openSqliteStorage(path), fake.review, provider);
	opened.push(publisher.harness);
	await publisher.harness.waitForIdle(context);
	const done = await publisher.harness.waitForTask(pending.record.id, context);
	expect(done.state.outcome).toMatchObject({
		status: "completed",
		result: { kind: "superseded", reason: expect.stringContaining("r2") },
	});
	expect(begin).not.toHaveBeenCalled();
	expect(posts).not.toHaveBeenCalled();
	expect(statuses).not.toHaveBeenCalled();
	expect(state.reviews).toEqual([]);
	expect(state.statuses).toEqual([]);
}, 30_000);

it("publishes without an optional provider session hook", async () => {
	const { harness, pending, provider, state } = await pendingPublication();
	const optional: ReviewProvider = provider;
	optional.beginPublish = undefined;
	harness.resume();
	const done = await harness.waitForTask(pending.record.id, context);
	expect(done.state.outcome).toMatchObject({ status: "completed", result: { kind: "published" } });
	expect(state.reviews).toHaveLength(1);
});

it("records the current round in both the publisher target and its pending task", async () => {
	const { harness, root, pending } = await pendingPublication();
	expect((await harness.snapshot(RoundsDocument, root.id, context))?.sequence).toBe(2);
	expect((await harness.snapshot(PublisherDocument, root.id, context))?.target).toMatchObject({ roundId: "r2" });
	expect(pending.record.input).toMatchObject({ target: { roundId: "r2" } });
});

it.each(["verdict", "provenance"])("refuses publication without live %s", async (missing) => {
	const { harness, root, pending, state, provider, changeset } = await pendingPublication();
	await harness.abortTask(pending.record.id, context);
	await root.commit(async (tx) => {
		delete (await tx.doc(PublisherDocument, root.id)).target;
		const live = await tx.doc(VerdictDocument, root.id);
		if (missing === "verdict") delete live.verdicts[`${changeset.revision.base}..${changeset.revision.head}`];
		else delete live.provenance;
	}, context);
	await expect(
		publishReview({
			harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: false,
		}),
	).rejects.toMatchObject({
		code: missing === "verdict" ? "notReviewed" : "notPublishable",
		message: expect.stringContaining(
			missing === "verdict" ? "Melian has no review" : "its review recorded no provenance",
		),
	});
	expect(state.reviews).toEqual([]);
	expect(state.statuses).toEqual([]);
	expect((await harness.snapshot(PublisherDocument, root.id, context))?.target).toBeUndefined();
});

it.each(["round", "identical round", "verdict", "missing round", "missing verdict"])(
	"refuses publication when its validated %s changes during permission reads",
	async (changed) => {
		const { harness, root, pending, state, provider, changeset } = await pendingPublication();
		await harness.abortTask(pending.record.id, context);
		await root.commit(async (tx) => {
			delete (await tx.doc(PublisherDocument, root.id)).target;
		}, context);
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const permission = provider.permission.bind(provider);
		vi.spyOn(provider, "permission").mockImplementationOnce(async (login) => {
			reached.resolve();
			await release.promise;
			return permission(login);
		});
		const publication = publishReview({
			harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: false,
		}).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		await reached.promise;
		if (changed === "round" || changed === "identical round") {
			await reviewChangeset({
				harness,
				changeset,
				config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
				lenses: [],
				standards: [],
				models: createFakeModels().review,
				checks: [{ name: "static.mutation", status: "ran" }],
				policy: { kind: "revision", commit: changeset.revision.base },
				origin: {
					kind: "pull-request",
					repository: { owner: state.owner, name: state.repo },
					pullRequest: 7,
					base: changeset.revision.base,
					head: changeset.revision.head,
				},
			});
			expect((await harness.snapshot(RoundsDocument, root.id, context))?.sequence).toBe(3);
			if (changed === "identical round")
				await root.commit(async (tx) => {
					const rounds = await tx.doc(RoundsDocument, root.id);
					rounds.items.r3!.verdict = rounds.items.r2!.verdict!;
				}, context);
		} else {
			await root.commit(async (tx) => {
				const rounds = await tx.doc(RoundsDocument, root.id);
				if (changed === "verdict") rounds.items.r2!.verdict = rounds.items.r1!.verdict!;
				else if (changed === "missing round") delete rounds.items.r2;
				else delete rounds.items.r2!.verdict;
			}, context);
		}
		release.resolve();
		expect(await publication).toMatchObject({
			error: { code: "notReviewed", message: expect.stringMatching(/newer round exists.*publish.*again/) },
		});
		expect(state.reviews).toEqual([]);
		expect(state.statuses).toEqual([]);
		expect((await harness.snapshot(PublisherDocument, root.id, context))?.target).toBeUndefined();
	},
);

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
	"publishes its current %s round from the saved copy when the live verdict is deleted",
	async (mode) => {
		const { harness, root, pending, provider } = await pendingPublication(mode);
		const state = (await harness.snapshot(RoundsDocument, root.id, context))!;
		const revision = Object.keys(state.current)[0]!;
		await root.commit(async (tx) => {
			delete (await tx.doc(VerdictDocument, root.id)).verdicts[revision];
		}, context);
		const posted = vi.spyOn(provider, "postReview");
		harness.resume();
		const done = await harness.waitForTask(pending.record.id, context);
		expect(done.state.outcome).toMatchObject({ status: "completed", result: { kind: "published" } });
		expect(posted).toHaveBeenCalledOnce();
		expect(posted.mock.calls[0]![0].verdict.toJSON()).toEqual(state.items[state.current[revision]!]!.verdict);
	},
);

it.each(["minted", "legacy"])("supersedes its %s target when a newer round is undecided", async (mode) => {
	const { harness, root, pending, provider, state, changeset } = await pendingPublication(mode);
	const revision = `${changeset.revision.base}..${changeset.revision.head}`;
	await root.commit((tx) => new RoundWriter(tx, root.id).mint(revision, 999, "2026-10-19T00:00:00Z"), context);
	const current = (await harness.snapshot(RoundsDocument, root.id, context))!.current[revision]!;
	const begin = vi.spyOn(provider, "beginPublish");
	const status = vi.spyOn(provider, "setStatus");
	harness.resume();
	const done = await harness.waitForTask(pending.record.id, context);
	expect(done.state.outcome).toMatchObject({
		status: "completed",
		result: { kind: "superseded", reason: expect.stringContaining(`current round is ${current}`) },
	});
	expect(begin).not.toHaveBeenCalled();
	expect(status).not.toHaveBeenCalled();
	expect(state.reviews).toEqual([]);
	expect(state.statuses).toEqual([]);
});

it.each(["round", "verdict", "current"])(
	"supersedes a minted target whose %s is missing instead of using the live verdict",
	async (missing) => {
		const { harness, root, pending, state, provider, changeset } = await pendingPublication();
		const revision = `${changeset.revision.base}..${changeset.revision.head}`;
		expect((await harness.snapshot(VerdictDocument, root.id, context))?.verdicts[revision]).toBeDefined();
		await root.commit(async (tx) => {
			const rounds = await tx.doc(RoundsDocument, root.id);
			if (missing === "round") delete rounds.items.r2;
			else if (missing === "current") delete rounds.current[revision];
			else delete rounds.items.r2!.verdict;
		}, context);
		const posted = vi.spyOn(provider, "postReview");
		harness.resume();
		const done = await harness.waitForTask(pending.record.id, context);
		expect(done.state.outcome).toMatchObject({
			status: "completed",
			result: {
				kind: "superseded",
				reason: `round r2 is superseded or undecided; current round is ${missing === "current" ? "missing" : "r2"}`,
			},
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

it.each([false, true])(
	"supersedes an unbound publisher beside minted rounds when trust changed is %s",
	async (trustChanged) => {
		const { harness, root, pending, state } = await pendingPublication();
		await root.commit(async (tx) => {
			const publisher = await tx.doc(PublisherDocument, root.id);
			Reflect.deleteProperty(publisher.target!, "roundId");
			if (trustChanged) publisher.publishedBy!.trustedWriters = true;
		}, context);
		harness.resume();
		const done = await harness.waitForTask(pending.record.id, context);
		expect(done.state.outcome).toMatchObject({
			status: "completed",
			result: { kind: "superseded", reason: expect.stringContaining("round cannot be proven") },
		});
		expect(state.statuses).toEqual([]);
		expect(state.reviews).toEqual([]);
	},
);

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

it.each(["adjudication", "revision"])(
	"supersedes a resumed publication during triage without indexed %s",
	async (missing) => {
		const { harness, root, pending, state, provider, changeset, path } = await pendingPublication("minted", ["ran"]);
		const revision = `${changeset.revision.base}..${changeset.revision.head}`;
		await root.commit(async (tx) => {
			const index = await tx.doc(ReviewIndex, root.id);
			if (missing === "revision") delete index.reviews[revision];
			else delete index.reviews[revision]!.adjudication;
			const verdicts = await tx.doc(VerdictDocument, root.id);
			await new RoundWriter(tx, root.id).preserve(revision);
			delete verdicts.verdicts[revision];
			delete verdicts.provenance![revision];
			delete verdicts.decisions![revision];
		}, context);
		await harness.close(context);
		const begin = vi.spyOn(provider, "beginPublish");
		const posts = vi.spyOn(provider, "postReview");
		const statuses = vi.spyOn(provider, "setStatus");
		const publisher = await PublishHarness.open(await openSqliteStorage(path), createFakeModels().review, provider);
		opened.push(publisher.harness);
		await expect(
			publishReview({
				harness: publisher.harness,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: false,
			}),
		).rejects.toMatchObject({ code: "notReviewed" });
		await publisher.harness.waitForIdle(context);
		const done = await publisher.harness.waitForTask(pending.record.id, context);
		expect(done.state.outcome).toMatchObject({
			status: "completed",
			result: { kind: "superseded", reason: `review is in progress for ${revision}; publish again` },
		});
		expect(begin).not.toHaveBeenCalled();
		expect(posts).not.toHaveBeenCalled();
		expect(statuses).not.toHaveBeenCalled();
		expect(state.reviews).toEqual([]);
		expect(state.statuses).toEqual([]);
	},
);

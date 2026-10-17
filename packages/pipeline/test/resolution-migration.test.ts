import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, dismissalVersion, type FindingDismissal, replyKey } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, expect, it, vi } from "vitest";
import { type FakeState, fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { VerdictDocument } from "../src/adjudication.ts";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	type Harness,
	type JsonObject,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import {
	LedgerDocument,
	PublishedDocument,
	PublisherDocument,
	publishExtension,
	publishReview,
} from "../src/publish.ts";
import { createFakeModels } from "../src/testing.ts";
import pendingV7 from "./fixtures/published-v7-dismissed-pending.json" with { type: "json" };
import resolvedV7 from "./fixtures/published-v7-dismissed-resolved.json" with { type: "json" };
import { baseAndHead, isolatedGitEnv } from "./fixtures/repo.ts";

type OldEntry = {
	ruleId: string;
	path: string;
	line: number;
	revision: string;
	thread?: string;
	dismissal?: FindingDismissal;
};
type OldRevision = { resolved: Record<string, OldEntry>; pending?: { resolved: Record<string, OldEntry> } };
let harness: Harness | undefined;
let dir: string | undefined;
let repo: string | undefined;
afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
	dir = undefined;
	repo = undefined;
	vi.unstubAllEnvs();
});

it.each([resolvedV7, pendingV7])(
	"reopens version-7 $phase dismissal and body-only resolution keys, then answers once",
	async (recorded) => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		vi.stubEnv("GIT_AUTHOR_DATE", "2026-10-18T00:00:00Z");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-10-18T00:00:00Z");
		repo = baseAndHead({ "src/a.ts": "old\n" }, { "src/a.ts": "new\n" });
		const changeset = await Changeset.resolve(repo, "main...feature");
		const head = changeset.revision.head;
		expect(head).toBe(recorded.github.pull.head.sha);
		dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-resolution-migration-")));
		const database = join(dir, "state.sqlite");
		const state: FakeState = { ...structuredClone(recorded.github), lines: changeset.revision.diffLines() };
		expect(state.lines).toEqual(recorded.github.lines);
		state.failReviews = false;
		state.failReplies = false;
		state.calls = [];
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test",
			fetch: fakeGitHub(state),
		});
		const fake = createFakeModels();
		const open = async () => {
			const registry = createRegistry();
			registry.install(publishExtension(provider));
			return openHarness(await openSqliteStorage(database), { models: fake.models, registry }, context);
		};
		const previous = defineDoc<JsonObject>({
			kind: "melian.published",
			version: recorded.version,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => JSON.parse(JSON.stringify(recorded.state)) as JsonObject,
		});
		harness = await open();
		let root = await harness.root(context);
		await root.commit(async (tx) => {
			await tx.doc(previous, root.id);
			Object.assign(await tx.doc(VerdictDocument, root.id), recorded.verdicts);
			Object.assign(await tx.doc(PublisherDocument, root.id), recorded.publisher);
			Object.assign(await tx.doc(LedgerDocument, root.id), recorded.ledger);
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		const migrated = (await harness.snapshot(PublishedDocument, root.id, context))!;
		const old = Object.values(recorded.state.revisions)[0] as OldRevision;
		const entries = old.pending?.resolved ?? old.resolved;
		const inline = entries[recorded.inlineId]!;
		const body = entries[recorded.bodyId]!;
		const key = replyKey(recorded.inlineId, inline.thread!, dismissalVersion(recorded.dismissal));
		const expected = {
			[key]: { ...inline, id: recorded.inlineId },
			[recorded.bodyId]: { ...body, id: recorded.bodyId },
		};
		const current = migrated.revisions[head]!;
		expect(current.pending?.resolved ?? current.resolved).toEqual(expected);
		if (old.pending !== undefined) expect(current.pending).toEqual({ ...old.pending, resolved: expected });
		expect(current.replies).toEqual({});
		await root.commit(async (tx) => {
			await tx.doc(PublishedDocument, root.id);
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		expect(await harness.snapshot(PublishedDocument, root.id, context)).toEqual(migrated);
		const options = {
			harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: true,
		};
		await publishReview(options);
		await publishReview(options);
		const replies = state.calls.filter(({ method, path }) => method === "POST" && path.endsWith("/replies"));
		expect(replies).toHaveLength(1);
		expect(state.comments.filter(({ in_reply_to_id }) => in_reply_to_id !== undefined)).toHaveLength(1);
		const published = (await harness.snapshot(PublishedDocument, root.id, context))!.revisions[head]!;
		expect(published.resolved).toEqual(expected);
		expect(published.replies).toEqual({ [key]: String(state.comments.at(-1)!.id) });
	},
);

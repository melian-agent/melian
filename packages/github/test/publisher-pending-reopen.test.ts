import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubProvider } from "@melian-agent/github";
import { backgroundContext as context, defineDoc, type Harness, openSqliteStorage } from "@melian-agent/pipeline";
import { expect, it } from "vitest";
import type { JsonObject } from "../../pipeline/src/harness.ts";
import { PublishedDocument } from "../../pipeline/src/publish.ts";
import { type FakeState, fakeGitHub } from "./fixtures/fake-github.ts";
import { openReviewOnlyHarness, scenarioModels } from "./fixtures/scenario.ts";

const recorded = JSON.parse(
	readFileSync(new URL("./fixtures/publisher-pending-v8-main.json", import.meta.url), "utf8"),
) as { version: number; published: JsonObject; publisher: { secret: string }; github: FakeState };

it("recovers main's version-8 pending review through its recorded publisher while /user fails", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-publisher-v8-")));
	const database = join(directory, "state.sqlite");
	let harness: Harness | undefined;
	try {
		const previous = defineDoc({
			kind: "melian.published",
			version: recorded.version,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => structuredClone(recorded.published),
		});
		harness = await openReviewOnlyHarness(await openSqliteStorage(database), scenarioModels());
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			await tx.doc(previous, root.id);
		}, context);
		await harness.close(context);
		harness = await openReviewOnlyHarness(await openSqliteStorage(database), scenarioModels());
		const state = structuredClone(recorded.github) as FakeState;
		state.calls = [];
		const transport = fakeGitHub(state);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test",
			fetch: async (input, init) =>
				new URL(String(input)).pathname === "/user" ? new Response("{}", { status: 502 }) : transport(input, init),
		});
		const reopened = (await harness.snapshot(PublishedDocument, root.id, context))!;
		const pending = reopened.revisions[state.pull.head.sha]!.pending!;
		expect(pending.ledger!.publishedBy!.login).toBe("alice");
		const found = await provider.findPublished(
			7,
			state.pull.head.sha,
			pending,
			recorded.publisher.secret!,
			pending.ledger!.publishedBy!.login,
		);
		expect(found.review).toBe(String(state.reviews[0]!.id));
		expect(Object.values(found.threads)).toEqual(state.comments.map(({ id }) => String(id)));
		expect(state.calls.filter(({ path }) => path === "/user")).toEqual([]);
		await (await harness.root(context)).commit(async (tx) => {
			await tx.doc(PublishedDocument, root.id);
		}, context);
		await harness.close(context);
		harness = await openReviewOnlyHarness(await openSqliteStorage(database), scenarioModels());
		expect(await harness.snapshot(PublishedDocument, root.id, context)).toEqual(reopened);
	} finally {
		await harness?.close(context);
		rmSync(directory, { recursive: true, force: true });
	}
});

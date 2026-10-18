import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubProvider } from "@melian-agent/github";
import { backgroundContext as context, defineDoc, type Harness, openSqliteStorage } from "@melian-agent/pipeline";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../pipeline/src/harness.ts";
import { PublishedDocument } from "../../pipeline/src/publish.ts";
import { type FakeState, fakeGitHub } from "./fixtures/fake-github.ts";
import { openReviewOnlyHarness, scenarioModels } from "./fixtures/scenario.ts";

type Recording = { version: number; published: JsonObject; publisher: { secret: string }; github: FakeState };

describe.each([4, 5, 6])("version-%s pending publisher recovery", (version) => {
	it.each(["Bot", "User"])("uses the unknown-publisher fallback for a recorded %s", async (type) => {
		const recorded = JSON.parse(
			readFileSync(new URL(`./fixtures/publisher-pending-v${version}.json`, import.meta.url), "utf8"),
		) as Recording;
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-legacy-publisher-")));
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
			const state = structuredClone(recorded.github);
			state.login = "bob";
			const original = state.reviews[0]!;
			state.reviews = [
				{ ...original, id: original.id + 1, user: { login: "copy[bot]", type } },
				{ ...original, user: { login: original.user!.login, type } },
			];
			const provider = createGitHubProvider({
				owner: state.owner,
				repo: state.repo,
				token: "test",
				fetch: fakeGitHub(state),
			});
			expect(await provider.login()).toBe("bob");
			state.calls = [];
			const reopened = (await harness.snapshot(PublishedDocument, root.id, context))!;
			const pending = reopened.revisions[state.pull.head.sha]!.pending!;
			expect(pending.ledger).toBeDefined();
			expect(pending.ledger!.publishedBy).toBeUndefined();
			const found = await provider.findPublished(
				7,
				state.pull.head.sha,
				pending,
				recorded.publisher.secret,
				pending.ledger!.publishedBy?.login,
			);
			expect(found).toEqual({ review: type === "Bot" ? String(original.id) : undefined, threads: {}, replies: {} });
			expect(state.calls.filter(({ path }) => path === "/user")).toEqual([]);
			expect(state.calls.every(({ method }) => method === "GET")).toBe(true);
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
});

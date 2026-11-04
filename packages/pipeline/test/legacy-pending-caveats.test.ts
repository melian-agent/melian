import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, type StoredVerdict } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../src/adjudication.ts";
import { backgroundContext as context, openSqliteStorage } from "../src/harness.ts";
import { openPublishHarness, PublishedDocument, publishReview } from "../src/publish.ts";
import { RoundsDocument } from "../src/rounds.ts";

const fixture = new URL("./fixtures/quiet-output-main/", import.meta.url);
const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
	published: { version: number; value: { ledgerRounds: { verdict: StoredVerdict }[] } };
};

it("posts the Reach caveat when retrying a version-9 pending verdict with only the legacy caller reason", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-legacy-pending-")));
	const database = join(directory, "state.sqlite");
	copyFileSync(new URL("previous.sqlite", fixture), database);
	const fake = createFakeModels();
	const state = pullRequestState();
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test-token",
		fetch: fakeGitHub(state),
	});
	try {
		const first = await openPublishHarness(await openSqliteStorage(database), fake.review, provider);
		let changeset: Changeset;
		try {
			const root = await first.harness.root(context);
			const verdicts = (await first.harness.snapshot(VerdictDocument, root.id, context))!;
			const [revision, upgraded] = Object.entries(verdicts.verdicts)[0]!;
			const [base, head] = revision.split("..") as [string, string];
			changeset = Changeset.from({
				kind: "range",
				id: "legacy-pending",
				repoRoot: directory,
				spec: { base, head, mode: "twoDot" },
				revision: { base, head, files: [], policyFiles: [] },
			});
			moveTo(state, changeset);
			const legacy = recorded.published.value.ledgerRounds[0]!.verdict;
			expect(recorded.published.version).toBe(9);
			expect(JSON.stringify(legacy)).not.toContain("caveats");
			await root.commit(async (tx) => {
				const rounds = await tx.doc(RoundsDocument, root.id);
				const round = rounds.items[rounds.current[revision]!]!;
				// Let the version-9 publisher plan from the verdict main recorded before caveats existed.
				round.verdict = structuredClone(legacy);
				(await tx.doc(VerdictDocument, root.id)).verdicts[revision] = structuredClone(legacy);
				Object.assign(await tx.doc(PublishedDocument, root.id), { order: [], revisions: {}, ledgerRounds: [] });
			}, context);
			state.failReviews = true;
			await expect(
				publishReview({
					harness: first.harness,
					provider,
					changeset,
					pullRequest: await provider.pullRequest(7),
					base,
					trustedWriters: true,
				}),
			).rejects.toThrow();
			const pending = (await first.harness.snapshot(PublishedDocument, root.id, context))!.revisions[head]!.pending!;
			expect(pending.verdict).toEqual(legacy);
			expect(state.reviews).toEqual([]);
			await root.commit(async (tx) => {
				const rounds = await tx.doc(RoundsDocument, root.id);
				rounds.items[rounds.current[revision]!]!.verdict = structuredClone(upgraded);
				(await tx.doc(VerdictDocument, root.id)).verdicts[revision] = structuredClone(upgraded);
			}, context);
		} finally {
			await first.close();
		}
		state.failReviews = false;
		state.calls = [];
		const second = await openPublishHarness(await openSqliteStorage(database), fake.review, provider);
		try {
			await publishReview({
				harness: second.harness,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: true,
			});
			const posts = state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/reviews"));
			expect(posts).toHaveLength(1);
			expect(posts[0]!.body).toMatchObject({
				body: expect.stringContaining(
					"Reach: callers were unavailable for every changed site, so no lens saw who calls the changed code: the host supplied no graph context.",
				),
			});
			expect(fake.provider.state.callCount).toBe(0);
		} finally {
			await second.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

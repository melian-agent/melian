import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adjudication, Changeset, defaultConfig, Finding, snippetHash } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	openPublishHarness,
	openSqliteStorage,
	publishReview,
	readFindings,
	revisionKey,
	upsertFinding,
} from "@melian-agent/pipeline";
import { expect, it } from "vitest";
import { VerdictDocument } from "../../pipeline/src/adjudication.ts";
import { FindingsDocument, replaceCheckFindings } from "../../pipeline/src/findings.ts";
import { PublishedDocument, PublisherDocument } from "../../pipeline/src/publish.ts";
import { type FakeState, fakeGitHub } from "./fixtures/fake-github.ts";
import { scenarioModels } from "./fixtures/scenario.ts";
import fixture from "./fixtures/step28-before.json" with { type: "json" };

it.each([false, true])(
	"reopens preceding-build state and remaps its publication after SQLite reopen (completed: %s)",
	async (completed) => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-acknowledge-upgrade-")));
		const path = join(dir, "review.sqlite");
		const state: FakeState = {
			...structuredClone(completed ? fixture.completed.state : fixture.state),
			lines: Changeset.from(fixture.changeset as Parameters<typeof Changeset.from>[0]).revision.diffLines(),
		};
		state.failReviews = false;
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		let opened = await openPublishHarness(await openSqliteStorage(path), scenarioModels().review, provider);
		try {
			const root = await opened.harness.root(context);
			await root.commit(async (tx) => {
				Object.assign(await tx.doc(FindingsDocument, root.id), fixture.findings);
				Object.assign(await tx.doc(VerdictDocument, root.id), fixture.verdicts);
				Object.assign(
					await tx.doc(PublishedDocument, root.id),
					completed ? fixture.completed.published : fixture.published,
				);
				Object.assign(
					await tx.doc(PublisherDocument, root.id),
					completed ? fixture.completed.publisher : fixture.publisher,
				);
			}, context);
			await opened.close(context);
			opened = await openPublishHarness(await openSqliteStorage(path), scenarioModels().review, provider);
			const changeset = Changeset.from(fixture.changeset as Parameters<typeof Changeset.from>[0]);
			const revision = revisionKey(changeset.revision);
			const reread = await opened.harness.root(context);
			const before = await readFindings(opened.harness, reread.id, revision, context);
			const notice = before.find((finding) => finding.ruleId === "guardrail/policy-change-review")!;
			expect(notice.properties.trigger).toBeUndefined();
			expect(notice.properties.status).toBe("dismissed");
			const result = await publishReview({
				harness: opened.harness,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: true,
			});
			expect(result.status).toEqual({
				state: "failure",
				description: "1 finding, 0 blocking, 1 unresolved acknowledgement",
			});
			expect(state.reviews).toHaveLength(1);
			if (completed) {
				expect(state.reviews[0]!.body).not.toContain("melian/review:");
			} else {
				expect(state.reviews[0]!.body).toContain(
					"melian/review: failure (1 finding, 0 blocking, 1 unresolved acknowledgement).",
				);
			}
			expect(state.ledgers[0]!.body).toContain("melian/review: failure");
			await publishReview({
				harness: opened.harness,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: true,
			});
			expect(state.reviews).toHaveLength(1);
			const reported = Finding.from({
				...notice.toJSON(),
				properties: {
					...notice.properties,
					trigger: { file: "AGENTS.md", index: 0, hash: snippetHash("blob:new") },
				},
			});
			await reread.commit((tx) => upsertFinding(tx, reread.id, reported, revision), context);
			await opened.close(context);
			opened = await openPublishHarness(await openSqliteStorage(path), scenarioModels().review, provider);
			const after = await readFindings(opened.harness, (await opened.harness.root(context)).id, revision, context);
			expect(after.find((finding) => finding.id === notice.id)!.properties.status).toBe("new");
		} finally {
			await opened.close(context);
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("reopens a preceding-build dismissal through check replacement and publishes failure", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-check-upgrade-")));
	const path = join(dir, "review.sqlite");
	const changeset = Changeset.from(fixture.changeset as Parameters<typeof Changeset.from>[0]);
	const revision = revisionKey(changeset.revision);
	const state: FakeState = {
		...structuredClone(fixture.state),
		lines: changeset.revision.diffLines(),
		failReviews: false,
	};
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test-token",
		fetch: fakeGitHub(state),
	});
	let opened = await openPublishHarness(await openSqliteStorage(path), scenarioModels().review, provider);
	try {
		const root = await opened.harness.root(context);
		await root.commit(async (tx) => {
			Object.assign(await tx.doc(FindingsDocument, root.id), fixture.findings);
			Object.assign(await tx.doc(VerdictDocument, root.id), fixture.verdicts);
		}, context);
		await opened.close(context);
		opened = await openPublishHarness(await openSqliteStorage(path), scenarioModels().review, provider);
		const reopened = await opened.harness.root(context);
		const before = await readFindings(opened.harness, reopened.id, revision, context);
		const notice = before.find((finding) => finding.ruleId === "guardrail/policy-change-review")!;
		expect(notice.properties.status).toBe("dismissed");
		expect(notice.properties.trigger).toBeUndefined();
		const reported = Finding.from({
			...notice.toJSON(),
			properties: {
				...notice.properties,
				source: { ...notice.properties.source, version: "next" },
				trigger: { file: "AGENTS.md", index: 0, hash: snippetHash("blob:new") },
			},
		});
		await reopened.commit((tx) => replaceCheckFindings(tx, reopened.id, "guardrails", revision, [reported]), context);
		const findings = await readFindings(opened.harness, reopened.id, revision, context);
		const current = findings.find((finding) => finding.id === notice.id)!;
		expect(current.properties.status).toBe("new");
		expect(current.properties.pastDismissals).toEqual([
			expect.objectContaining({ reason: "Guidance reviewed.", reopenedRevision: revision }),
		]);
		const verdict = new Adjudication({
			findings: [current],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		await reopened.commit(async (tx) => {
			(await tx.doc(VerdictDocument, reopened.id)).verdicts[revision] = verdict.toJSON();
		}, context);
		const result = await publishReview({
			harness: opened.harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: true,
		});
		expect(result.status).toEqual({
			state: "failure",
			description: "1 finding, 0 blocking, 1 unresolved acknowledgement",
		});
		expect(state.statuses.at(-1)?.state).toBe("failure");
	} finally {
		await opened.close(context);
		rmSync(dir, { recursive: true, force: true });
	}
});

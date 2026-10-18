import { rmSync } from "node:fs";
import { Adjudication, Changeset, defaultConfig, Finding, snippetHash, type Verification } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	createMemoryStorage,
	dismissFinding,
	publishReview,
	readFindings,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../src/adjudication.ts";
import { FindingsDocument, revisionKey, upsertVerification } from "../src/findings.ts";
import { RoundWriter } from "../src/rounds.ts";
import { RecordedReview } from "./fixtures/recorded-review.ts";
import { baseAndHead, commit, isolatedGitEnv } from "./fixtures/repo.ts";

it.each(["plausible", "refuted"] as const)(
	"publishes failure for a %s protected claim until its exact content is dismissed",
	async (verdict) => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		const repo = baseAndHead({ "src/a.ts": "guard()\ncache: base\n" }, { "src/a.ts": "guard()\ncache: A\n" });
		const state = pullRequestState();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		const fake = createFakeModels();
		const opened = await RecordedReview.open(createMemoryStorage(), fake.review, provider);
		try {
			const root = await opened.harness.root(context);
			const judgement: Verification = {
				verdict,
				reason: "Needs hostile configuration.",
				executor: "llm",
				model: "faux/judge",
				version: "1",
				...(verdict === "plausible"
					? { lowered: { from: "P2", to: "P3", reason: "Needs hostile configuration." } }
					: {}),
			};
			const report = (content: string) =>
				Finding.create({
					rule: "fail-open",
					file: "src/a.ts",
					startLine: 1,
					snippet: "guard()",
					occurrence: 0,
					severity: "P2",
					cause: "introduced",
					source: { check: "lens.trust-boundary", version: "1" },
					message: "The guard reuses a planted kill.",
					failureScenario: "The head plants a kill in the cache before the guard reads it.",
					evidence: [{ file: "src/a.ts", startLine: 2, role: "cause", revision: "head", snippet: content }],
					explanation: { what: "Planted kill", whyHere: "Cache reused", whatToDo: "Rerun" },
					trigger: { file: "src/a.ts", index: 0, snippet: content },
				});
			let changeset = await Changeset.resolve(repo, "main...feature");
			const first = report("cache: A");
			const decide = async () => {
				const revision = revisionKey(changeset.revision);
				const findings = await readFindings(opened.harness, root.id, revision, context);
				const decided = new Adjudication({
					findings,
					config: defaultConfig,
					checks: [],
					manifest: [],
				}).adjudicate();
				await root.commit(async (tx) => {
					const document = await tx.doc(VerdictDocument, root.id);
					document.verdicts[revision] = decided.toJSON();
					document.provenance = {
						...document.provenance,
						[revision]: {
							kind: "pull-request",
							manifest: [],
							lenses: [],
							repository: { owner: state.owner, name: state.repo },
							pullRequest: 7,
							base: changeset.revision.base,
							head: changeset.revision.head,
							policy: `revision:${changeset.revision.base}`,
						},
					};
					await new RoundWriter(tx, root.id).record(revision, 0, decided.toJSON(), document.provenance[revision]!);
				}, context);
				await opened.record(revision);
				return decided;
			};
			const publish = async () => {
				moveTo(state, changeset);
				return publishReview({
					harness: opened.harness,
					provider,
					changeset,
					pullRequest: await provider.pullRequest(7),
					base: changeset.revision.base,
					trustedWriters: true,
				});
			};
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, first, revisionKey(changeset.revision));
				await upsertVerification(
					tx,
					root.id,
					revisionKey(changeset.revision),
					first.id,
					first.properties.source,
					judgement,
				);
			}, context);
			expect((await decide()).findings.acknowledge).toHaveLength(1);
			expect((await publish()).status).toEqual({
				state: "failure",
				description: "1 finding, 0 blocking, 1 unresolved acknowledgement",
			});
			await root.commit(
				(tx) =>
					dismissFinding(
						tx,
						root.id,
						first.id,
						{ by: "Maintainer", at: "2026-10-18T00:00:00Z", reason: "Accepted cache A." },
						revisionKey(changeset.revision),
					),
				context,
			);
			await decide();
			const accepted = (await opened.harness.snapshot(FindingsDocument, root.id, context))!.items[first.id]!
				.lifecycle.dismissedTrigger;
			expect((await publish()).status).toEqual({ state: "success", description: "0 findings, 1 dismissed" });
			expect(state.ledgers.at(-1)!.body).toContain("Accepted cache A.");
			commit(repo, { "unrelated.txt": "same accepted content\n" });
			changeset = await Changeset.resolve(repo, "main...feature");
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, first, revisionKey(changeset.revision));
				await upsertVerification(
					tx,
					root.id,
					revisionKey(changeset.revision),
					first.id,
					first.properties.source,
					judgement,
				);
			}, context);
			await decide();
			expect((await publish()).status.state).toBe("success");
			commit(repo, { "src/a.ts": "guard()\ncache: B\n" });
			changeset = await Changeset.resolve(repo, "main...feature");
			const changed = report("cache: B");
			expect(changed.id).toBe(first.id);
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, changed, revisionKey(changeset.revision));
				await upsertVerification(
					tx,
					root.id,
					revisionKey(changeset.revision),
					changed.id,
					changed.properties.source,
					judgement,
				);
			}, context);
			const after = await decide();
			expect(after.findings.acknowledge[0]!.properties.verification?.verdict).toBe(verdict);
			expect(after.findings.acknowledge[0]!.properties.pastDismissals).toMatchObject([
				{ reason: "Accepted cache A." },
			]);
			expect((await publish()).status.state).toBe("failure");
			expect(state.statuses.at(-1)!.state).toBe("failure");
			expect(accepted).toEqual({ hash: snippetHash("cache: A"), proof: [] });
		} finally {
			await opened.close(context);
			rmSync(repo, { recursive: true, force: true });
			vi.unstubAllEnvs();
		}
	},
);

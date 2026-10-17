import { Changeset, loadConfig } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	openReviewHarness,
	type ReviewHarness,
	recordDismissal,
	reviewChangeset,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findingsVersion, revisionKey } from "../src/findings.ts";
import { commit, createRepository, isolatedGitEnv, lines, removeRepository } from "./fixtures/repo.ts";

let repo: string;
let opened: ReviewHarness[];
beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = createRepository();
	opened = [];
});
afterEach(async () => {
	await Promise.all(opened.map((each) => each.close()));
	vi.unstubAllEnvs();
	removeRepository(repo);
});

const dismissal = { by: "Maintainer", at: "2026-10-17T00:00:00Z", reason: "Comment only." };

async function scenario() {
	const base = commit(repo, {
		"melian.yaml": lines("tiers:", "  full: [guardrails]"),
		"docs/melian.yaml": "# base\n",
	});
	const fake = createFakeModels();
	const harness = await openReviewHarness(createMemoryStorage(), fake.review, { retry: false, checkout: repo });
	opened.push(harness);
	const policy = { kind: "revision", commit: base } as const;
	const { config } = await loadConfig(repo, policy, ".");
	const review = async (head: string) => {
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		const result = await reviewChangeset({
			harness,
			changeset,
			policy,
			config,
			lenses: [],
			standards: [],
			models: fake.review,
		});
		return { changeset, verdict: result.verdict };
	};
	const dismiss = async (head: string, id: string) => {
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		return recordDismissal({ harness: harness.harness, revision: changeset.revision, id, dismissal, repoRoot: repo });
	};
	return { base, review, dismiss, harness };
}

const noticeOf = (verdict: Awaited<ReturnType<Awaited<ReturnType<typeof scenario>>["review"]>>["verdict"]) =>
	[...verdict.attention(), ...verdict.dismissed].find((each) => each.ruleId === "guardrail/policy-change-review")!;

describe("dismissal content across revisions", { timeout: 120_000 }, () => {
	it("reopens an earlier head whose content differs from the dismissed head", async () => {
		const { review, dismiss, harness } = await scenario();
		const a = commit(repo, { "docs/melian.yaml": "resolution: { P2: advisory }\n" });
		const first = await review(a);
		expect(first.verdict.reviewStatus().state).toBe("failure");
		const b = commit(repo, { "docs/melian.yaml": "# comment only\n" });
		const second = await review(b);
		const id = noticeOf(second.verdict).properties.id;
		expect(noticeOf(first.verdict).properties.id).toBe(id);
		const recorded = await dismiss(b, id);
		expect(recorded.verdict.reviewStatus().state).toBe("success");
		const root = await harness.harness.root(context);
		const version = await findingsVersion(harness.harness, root.id, revisionKey(second.changeset.revision), context);
		expect((await review(b)).verdict.reviewStatus().state).toBe("success");
		expect(await findingsVersion(harness.harness, root.id, revisionKey(second.changeset.revision), context)).toBe(
			version,
		);
		const same = commit(repo, { "unrelated.txt": "same trigger\n" });
		expect((await review(same)).verdict.reviewStatus().state).toBe("success");
		const again = await review(a);
		expect(again.verdict.reviewStatus().state).toBe("failure");
	});

	it("dismissed at A, then the file changes, is deleted, or is renamed: each fails", async () => {
		for (const change of ["edit", "delete", "rename"] as const) {
			removeRepository(repo);
			repo = createRepository();
			const { review, dismiss } = await scenario();
			const a = commit(repo, { "docs/melian.yaml": "# comment only\n" });
			const first = await review(a);
			const id = noticeOf(first.verdict).properties.id;
			const recorded = await dismiss(a, id);
			expect(recorded.verdict.reviewStatus().state).toBe("success");
			expect((await review(a)).verdict.reviewStatus()).toEqual({
				state: "success",
				description: "0 findings, 1 dismissed",
			});
			const b =
				change === "edit"
					? commit(repo, { "docs/melian.yaml": "resolution: { P2: advisory }\n" })
					: change === "delete"
						? commit(repo, {}, ["docs/melian.yaml"])
						: commit(repo, { "other/melian.yaml": "# comment only\n" }, ["docs/melian.yaml"]);
			const after = await review(b);
			expect(after.verdict.reviewStatus().state).toBe("failure");
		}
	});
});

import {
	CompareHarness,
	backgroundContext as context,
	createMemoryStorage,
	MembershipReader,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { expect, it, vi } from "vitest";
import type { TaskId } from "../src/harness.ts";
import { PublisherDocument } from "../src/publish.ts";
import { RoundsDocument } from "../src/rounds.ts";

it("selects historical ownership by both repository and pull request and scopes every task page", async () => {
	const storage = createMemoryStorage();
	const changeset = "range-0123456789abcdef";
	const harness = await CompareHarness.open(storage, createFakeModels().review, changeset);
	try {
		const root = await harness.harness.root(context);
		const mintedAt = "2026-10-26T01:00:00Z";
		const provenance = {
			kind: "pull-request" as const,
			repository: { owner: "owner", name: "repo" },
			pullRequest: 7,
			policy: "test",
			manifest: [],
			lenses: [],
		};
		const target = {
			repository: "other/repo",
			pullRequest: 7,
			baseRef: "main",
			baseTip: "a".repeat(40),
			base: "a".repeat(40),
			head: "b".repeat(40),
			revision: `${"a".repeat(40)}..${"b".repeat(40)}`,
			roundId: "r1",
		};
		await root.commit(async (tx) => {
			(await tx.doc(RoundsDocument, root.id)).items.r1 = {
				base: target.base,
				head: target.head,
				tasks: [],
				mintedAt,
				provenance,
			};
			(await tx.doc(RoundsDocument, root.id)).items.r2 = { base: target.base, head: target.head, tasks: [] };
			(await tx.doc(PublisherDocument, root.id)).target = target;
		}, context);
		for (let i = 0; i < 202; i++)
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
							input:
								i >= 200
									? { target: { ...target, repository: "owner/repo", pullRequest: i === 200 ? 7 : 8 } }
									: {},
							state: { status: "terminal", outcome: { status: "completed", result: "published" } },
						},
					},
				],
				context,
			);
		const scan = vi.spyOn(storage, "scanTasks");
		for (const ownership of [
			{ repository: { owner: "owner", name: "repo" }, pullRequest: 7 },
			{ repository: { owner: "OWNER", name: "Repo" }, pullRequest: 8 },
			{ repository: { owner: "other", name: "repo" }, pullRequest: 7 },
		]) {
			const rounds = await MembershipReader.open(storage).candidates(changeset, ownership);
			expect(rounds[0]).toStrictEqual({
				id: `${changeset}.r1`,
				base: target.base,
				head: target.head,
				mintedAt,
				provenance,
				publication: {
					...ownership,
					repository: { owner: ownership.repository.owner.toLowerCase(), name: "repo" },
				},
			});
			expect(rounds[1]).toStrictEqual({ id: `${changeset}.r2`, base: target.base, head: target.head });
		}
		expect(scan).toHaveBeenCalledTimes(6);
		for (const call of scan.mock.calls) expect(call[0]).toEqual({ kind: "melian.publish" });
	} finally {
		await harness.close();
	}
});

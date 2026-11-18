import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset } from "@melian-agent/core";
import { expect, it } from "vitest";
import { AdjudicationTask, replacedReason, VerdictDocument } from "../src/adjudication.ts";
import {
	backgroundContext as context,
	createRegistry,
	defineTask,
	type JsonObject,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import { createReviewRegistry } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { createFakeModels } from "../src/testing.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

const recorded = JSON.parse(
	readFileSync(new URL("./fixtures/adjudication-v7-static/recorded.json", import.meta.url), "utf8"),
) as {
	repoRoot: string;
	base: string;
	head: string;
	verdict: string;
	task: { kind: string; version: number; input: JsonObject; initial: { phase: string } & JsonObject };
};

it("reads main's version 7 adjudication's counted static check as replaced, since that input names no run", {
	timeout: 60_000,
}, async () => {
	const repo = createRepository();
	commit(repo, {
		"melian.yaml": lines("tiers:", "  fast: [static.tsc]"),
		"tsconfig.json": JSON.stringify({
			compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext" },
		}),
		"src/a.ts": lines("export const a: number = 1;"),
	});
	commit(repo, { "src/a.ts": lines("export const a: number = 'one';") });
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-adjudication-v7-")));
	const file = join(directory, "state.sqlite");
	try {
		const { revision: reviewed } = await Changeset.resolve(repo, "HEAD~1..HEAD");
		const input = JSON.parse(
			JSON.stringify(recorded.task.input)
				.replaceAll(recorded.repoRoot, repo)
				.replaceAll(recorded.base, reviewed.base)
				.replaceAll(recorded.head, reviewed.head),
		) as JsonObject;
		// Its policy fingerprint names the capture's base commit, which this repository's commits cannot reproduce, and an
		// input without one, as an older Melian stored, skips the comparison.
		expect(input.resolutionPolicy).toEqual(expect.stringMatching(/^3:/));
		delete input.resolutionPolicy;
		expect(recorded.task.version).toBe(7);
		expect(recorded.verdict).toBe("findings");
		expect(input.run).toBeUndefined();
		const revision = `${reviewed.base}..${reviewed.head}`;
		const fake = createFakeModels();
		const first = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createRegistry(),
		});
		const root = await first.root(context);
		const old = defineTask<JsonObject, { phase: string } & JsonObject, null>({
			name: recorded.task.kind,
			version: recorded.task.version,
			initial: () => recorded.task.initial,
			abort: async (_task, runtime, abortContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
			phases: {
				[recorded.task.initial.phase]: async () => {
					throw new Error("old definition must not execute");
				},
			},
		});
		const id = await root.commit(async (tx) => {
			const task = await tx.createTask(old, input, { ownership: { kind: "conversation" } });
			(await tx.doc(ReviewIndex, root.id)).reviews[revision] = {
				task,
				lenses: [],
				adjudication: { task, input: "old" },
			};
			return task;
		}, context);
		await first.close(context);
		const second = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		try {
			second.resume();
			await second.waitForTask(id, context);
			expect(await second.getTask(id, context)).toMatchObject({
				version: AdjudicationTask.definition.version,
				input,
				state: { status: "terminal", outcome: { status: "completed", result: "recorded" } },
			});
			const verdict = (await second.snapshot(VerdictDocument, root.id, context))!.verdicts[revision]!;
			expect(verdict.status).toBe("not-reviewed");
			expect(verdict.notRun).toContainEqual({ name: "static.tsc", status: "failed", reason: replacedReason });
		} finally {
			await second.close(context);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
		removeRepository(repo);
	}
});

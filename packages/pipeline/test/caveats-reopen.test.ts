import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, Verdict } from "@melian-agent/core";
import { renderReviewBody } from "@melian-agent/github";
import { expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	defineTask,
	type JsonObject,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import { createReviewRegistry } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { RoundsDocument } from "../src/rounds.ts";
import { createFakeModels, fauxAssistantMessage } from "../src/testing.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";

// Written by main at 460f68f0 before caveats existed; the README says how.
const fixture = new URL("./fixtures/quiet-output-main/", import.meta.url);
// Main recorded the caller note on the lens record, which the upgrade reads as the caveat it stands for.
const blindHost =
	"callers were unavailable for every changed site, so no lens saw who calls the changed code: the host supplied no graph context";
type Check = { name: string; reason?: string; caveats?: string[] };
const withCaveats = (checks: Check[]) =>
	checks.map((check) => (check.name === "lens.correctness" ? { ...check, caveats: [blindHost] } : check));

const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
	tasks: { kind: string; version: number; input: JsonObject; initial: { phase: string } & JsonObject }[];
};

it.each([
	["melian.lenses", 4, 5],
	["melian.adjudication", 5, 6],
] as const)("reopens main's version-%s %s input, reading its caller note as a caveat", async (kind, from, to) => {
	const repo = crashRepository();
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-caveats-reopen-")));
	const file = join(directory, "state.sqlite");
	const previous = recorded.tasks.find((task) => task.kind === kind)!;
	expect(previous.version).toBe(from);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const old = recorded.tasks.find((task) => task.kind === "melian.lenses")!.input.revision as {
		repoRoot: string;
		base: string;
		head: string;
	};
	const input = JSON.parse(
		JSON.stringify(previous.input)
			.replaceAll(old.repoRoot, repo)
			.replaceAll(old.base, changeset.revision.base)
			.replaceAll(old.head, changeset.revision.head),
	) as JsonObject;
	const fake = createFakeModels({ models: [{ id: "scripted" }] });
	fake.provider.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("Done.")));
	try {
		const first = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createRegistry(),
		});
		const root = await first.root(context);
		const token = defineTask<JsonObject, { phase: string } & JsonObject, null>({
			name: kind,
			version: from,
			initial: () => previous.initial,
			abort: async (_task, runtime, abortContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
			phases: {
				[previous.initial.phase]: async () => {
					throw new Error("old definition must not execute");
				},
			},
		});
		const id = await root.commit(
			(tx) => tx.createTask(token, input, { ownership: { kind: "conversation" } }),
			context,
		);
		await first.close(context);
		const second = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		try {
			second.resume();
			await second.waitForTask(id, context);
			const migrated = await second.getTask(id, context);
			const expected = structuredClone(input) as JsonObject & { checks?: Check[]; callers?: JsonObject };
			if (expected.checks !== undefined) expected.checks = withCaveats(expected.checks);
			if (expected.callers !== undefined) expected.callers = { ...expected.callers, caveat: blindHost };
			expect(JSON.stringify(input)).not.toContain("caveat");
			expect(migrated).toMatchObject({ version: to, input: expected });
		} finally {
			await second.close(context);
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(directory, { recursive: true, force: true });
	}
});

it.each([
	["melian.reviews", 3, 4],
	["melian.verdicts", 12, 13],
] as const)(
	"reopens main's version-%s %s document twice, reading its caller note as a caveat",
	async (kind, from, to) => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-caveats-doc-")));
		const file = join(directory, "state.sqlite");
		copyFileSync(new URL("previous.sqlite", fixture), file);
		const fake = createFakeModels();
		try {
			const first = await openHarness(await openSqliteStorage(file), {
				models: fake.models,
				registry: createRegistry(),
			});
			const root = await first.root(context);
			const old =
				kind === "melian.verdicts"
					? defineDoc<JsonObject>({
							kind,
							version: from,
							scope: "conversation",
							history: "rewindable",
							fork: "asOf",
							initial: () => ({}),
						})
					: defineDoc<JsonObject>({
							kind,
							version: from,
							scope: "conversation",
							history: "latest",
							fork: "current",
							initial: () => ({}),
						});
			const previous = await first.snapshot(old, root.id, context);
			expect(JSON.stringify(previous)).not.toContain("caveat");
			await first.close(context);
			for (let pass = 0; pass < 2; pass++) {
				const storage = await openSqliteStorage(file);
				const opened = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
				try {
					const snapshot =
						kind === "melian.verdicts"
							? await opened.snapshot(VerdictDocument, root.id, context)
							: await opened.snapshot(ReviewIndex, root.id, context);
					expect(snapshot).toEqual(upgraded(kind, previous!));
					await opened.commit(async (tx) => {
						if (kind === "melian.verdicts") await tx.doc(VerdictDocument, root.id);
						else await tx.doc(ReviewIndex, root.id);
					}, context);
					const document = await storage.findDocument(
						{ kind, scope: { kind: "conversation", conversationId: root.id } },
						"current",
						context,
					);
					expect((await storage.document(document!.id, "current", context))!.version).toBe(to);
				} finally {
					await opened.close(context);
				}
			}
			expect(fake.provider.state.callCount).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

function upgraded(kind: string, previous: JsonObject): JsonObject {
	const value = structuredClone(previous) as {
		verdicts?: Record<string, { ran: Check[]; notRun: Check[] }>;
		reviews?: Record<string, { callers?: JsonObject }>;
	};
	for (const verdict of Object.values(value.verdicts ?? {})) {
		verdict.ran = withCaveats(verdict.ran);
		verdict.notRun = withCaveats(verdict.notRun);
	}
	for (const entry of Object.values(value.reviews ?? {}))
		if (entry.callers !== undefined) entry.callers = { ...entry.callers, caveat: blindHost };
	expect(kind === "melian.verdicts" ? value.verdicts : value.reviews).toBeDefined();
	return value as JsonObject;
}

it("reopens main's version-1 rounds with each round's verdict upgraded as the verdict document is", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-caveats-rounds-")));
	const file = join(directory, "state.sqlite");
	copyFileSync(new URL("previous.sqlite", fixture), file);
	const fake = createFakeModels();
	try {
		const opened = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createReviewRegistry(),
		});
		try {
			const root = await opened.root(context);
			const rounds = (await opened.snapshot(RoundsDocument, root.id, context))!;
			const verdicts = (await opened.snapshot(VerdictDocument, root.id, context))!;
			const items = Object.values(rounds.items).filter((round) => round.verdict !== undefined);
			expect(items.length).toBeGreaterThan(0);
			for (const round of items) {
				// Publish refuses a round whose copy differs from the verdict document's, so the two must upgrade alike.
				expect(Object.values(verdicts.verdicts)).toContainEqual(round.verdict);
				const body = renderReviewBody(
					{
						pullRequest: 7,
						revision: round.head,
						base: round.base,
						fingerprint: "0123456789abcdef",
						round: 1,
						verdict: Verdict.from(round.verdict!),
						findings: [],
						stillOpen: 0,
						resolved: [],
						secret: "11".repeat(32),
					},
					{ web: "https://github.com/melian-agent/example" },
				);
				expect(body).toContain(`Reach: ${blindHost}.`);
			}
		} finally {
			await opened.close(context);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

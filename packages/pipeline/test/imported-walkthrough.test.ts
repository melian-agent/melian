import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	Revision,
	reviewPayloads,
	SharedRecord,
	type WalkthroughPayload,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
	reviewChangeset,
	summarizeReview,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { ImportedRecords } from "../src/imported-records.ts";
import { baseAndHead, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const walkthroughPrompt = "You write Melian's walkthrough";
const checks = [{ name: "guardrails", status: "ran" as const, findings: 0, notes: [] }];
const writing = (summary: string) =>
	fauxAssistantMessage(
		[fauxToolCall("record_walkthrough", { summary, files: [{ path: "src/a.ts", summary: "Sets a to 2." }] })],
		{ stopReason: "toolUse" },
	);

let repo: string;
let opened: Harness[];

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead({ "src/a.ts": lines("export const a = 1;") }, { "src/a.ts": lines("export const a = 2;") });
	opened = [];
});

afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

// One host's review of a pull request, on a store of its own, whose summariser would write `summary`.
async function review(
	summary: string,
	options: { readonly imported?: readonly RecordEnvelope[]; readonly rerun?: boolean } = {},
) {
	const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }, { id: "light" }] });
	const route = (id: string) => ({ model: `${fake.ref(id).provider}/${id}` });
	const config: MelianConfig = {
		...defaultConfig,
		tiers: twoLensTiers,
		models: { heavy: route("heavy"), light: route("light") },
	};
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	opened.push(harness);
	const done = fauxAssistantMessage("No findings.");
	const requests = scriptConversations(fake, [
		{ match: correctness, replies: [done, done] },
		{ match: walkthroughPrompt, replies: [writing(summary)] },
	]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const imported = options.imported === undefined ? undefined : ImportedRecords.from(changeset.id, options.imported);
	const store = new MemoryRecordStore({ payloads: reviewPayloads });
	await reviewChangeset({
		harness,
		changeset,
		config,
		lenses: (await Lens.builtins()).filter(({ name }) => name === "correctness"),
		standards: [],
		models: fake.review,
		checks,
		records: store,
		...(imported === undefined ? {} : { imported }),
		lensesStarted: () =>
			summarizeReview({
				harness,
				changeset,
				config,
				models: fake.review,
				origin: {
					kind: "pull-request",
					repository: { owner: "melian-agent", name: "example" },
					pullRequest: 7,
					base: changeset.revision.base,
					head: changeset.revision.head,
				},
				...(options.rerun === undefined ? {} : { rerun: options.rerun }),
				...(imported === undefined ? {} : { imported }),
			}),
	});
	const root = (await harness.root(context)).id;
	const state = await harness.snapshot(VerdictDocument, root, context);
	const stored = await store.list(changeset.id);
	return {
		asked: requests[walkthroughPrompt]?.length ?? 0,
		written: state?.routedWalkthroughs?.[Revision.key(changeset.revision)],
		stored,
		walkthroughs: stored.filter(({ kind }) => kind === "walkthrough"),
		round: stored.find(({ kind }) => kind === "round")!.payload as {
			walkthrough: { key: string; id: string } | null;
		},
	};
}

describe("a review that imports a walkthrough record", () => {
	it("asks no summariser for the request the record answers, and stores and exports that walkthrough", async () => {
		const first = await review("Changes a.");
		expect(first.asked).toBe(1);

		const second = await review("Something else.", { imported: first.stored });
		expect(second.asked).toBe(0);
		expect(second.written).toEqual(first.written);
		expect(second.walkthroughs).toEqual(first.walkthroughs);
		expect(second.round.walkthrough).toEqual({
			key: first.walkthroughs[0]!.key,
			id: SharedRecord.parseEnvelope(first.walkthroughs[0]!).id,
		});
	});

	it.each([
		[
			"names another request",
			(record: RecordEnvelope): RecordEnvelope => ({ ...record, key: `${record.key.slice(0, -1)}0` }),
		],
		[
			"was written on another light route",
			(record: RecordEnvelope): RecordEnvelope => ({
				...record,
				payload: { ...(record.payload as WalkthroughPayload), route: "faux/heavy@" } as RecordEnvelope["payload"],
			}),
		],
	] as const)("asks the summariser when the only walkthrough record %s", async (_, plant) => {
		const first = await review("Changes a.");
		const records = first.stored.map((record) => (record.kind === "walkthrough" ? plant(record) : record));

		const second = await review("Something else.", { imported: records });
		expect(second.asked).toBe(1);
		expect(Object.values(second.written ?? {}).map(({ summary }) => summary)).toEqual(["Something else."]);
	});

	it("asks the summariser on a rerun, which asks for a walkthrough of its own", async () => {
		const first = await review("Changes a.");
		const second = await review("Something else.", { imported: first.stored, rerun: true });
		expect(second.asked).toBe(1);
		expect(Object.values(second.written ?? {}).map(({ summary }) => summary)).toEqual(["Something else."]);
	});
});

describe("ImportedRecords.walkthrough", () => {
	it("answers only under the record's key and on the route that wrote it", async () => {
		const first = await review("Changes a.");
		const [record] = first.walkthroughs;
		const changeset = record!.changeset;
		const revision = record!.revision!;
		const imported = ImportedRecords.from(changeset, first.stored);
		expect(imported.walkthrough(record!.key, revision, "faux/light@")).toEqual({
			summary: "Changes a.",
			files: [{ path: "src/a.ts", summary: "Sets a to 2." }],
		});
		expect(imported.walkthrough(record!.key, revision, "faux/heavy@")).toBeUndefined();
		expect(imported.walkthrough("f".repeat(64), revision, "faux/light@")).toBeUndefined();
	});
});

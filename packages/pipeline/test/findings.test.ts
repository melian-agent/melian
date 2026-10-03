import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFinding, type Finding, FindingError, type FindingInput } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	dismissFinding,
	type Harness,
	openHarness,
	openSqliteStorage,
	readFindings,
	type Storage,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FindingsDocument } from "../src/findings.ts";

const input: FindingInput = {
	rule: "no-eval",
	message: "eval runs request input",
	file: "src/run.ts",
	startLine: 12,
	snippet: "eval(input)",
	occurrence: 0,
	cause: "introduced",
	severity: "P1",
	resolution: "block",
	explanation: {
		what: "The handler passes the request body to eval.",
		whyHere: "This change routes the body into run().",
		whatToDo: "Parse the body with JSON.parse.",
	},
	source: { check: "lens.security", version: "1" },
};

const evalFinding = createFinding(input);

let dir: string;
let opened: Harness[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "melian-findings-"));
	opened = [];
});

afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	rmSync(dir, { recursive: true, force: true });
});

async function open(storage: Storage) {
	const fake = createFakeModels();
	const harness = await openHarness(storage, { models: fake.models, registry: createRegistry() });
	opened.push(harness);
	return { harness, root: await harness.root(context, { agent: { model: fake.ref() } }) };
}

describe("the findings document", () => {
	it("reads as empty before anything is reported", async () => {
		const { harness, root } = await open(createMemoryStorage());
		expect(await readFindings(harness, root.id, context)).toEqual([]);
	});

	it("stores a finding upserted twice under one ID once", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const reworded = createFinding({ ...input, message: "eval runs the request body" });
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		expect(await readFindings(harness, root.id, context)).toEqual([evalFinding]);

		await root.commit((tx) => upsertFinding(tx, root.id, reworded, "rev1"), context);
		expect(await readFindings(harness, root.id, context)).toEqual([reworded]);
	});

	it("keeps findings with different IDs apart, in ID order", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const other = createFinding({ ...input, snippet: "eval(body)" });
		await root.commit(async (tx) => {
			await upsertFinding(tx, root.id, evalFinding, "rev1");
			await upsertFinding(tx, root.id, other, "rev1");
		}, context);
		const ids = [evalFinding, other].map((finding) => finding.properties.id).sort();
		expect((await readFindings(harness, root.id, context)).map((finding) => finding.properties.id)).toEqual(ids);
	});

	it("stores a finding with nested undefined values as its JSON form", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const loose = { ...evalFinding, message: { text: evalFinding.message.text, markdown: undefined } } as Finding;
		await root.commit((tx) => upsertFinding(tx, root.id, loose, "rev1"), context);
		expect(await readFindings(harness, root.id, context)).toEqual([evalFinding]);
	});

	it("refuses an invalid finding and commits nothing", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const invalid: Finding = { ...evalFinding, level: "note" };
		const committed = root.commit(async (tx) => {
			await upsertFinding(tx, root.id, evalFinding, "rev1");
			await upsertFinding(tx, root.id, invalid, "rev1");
		}, context);
		await expect(committed).rejects.toBeInstanceOf(FindingError);
		expect(await readFindings(harness, root.id, context)).toEqual([]);
	});

	describe("lifecycle", () => {
		const dismissal = { by: "tal", reason: "eval input is a constant here", at: "2026-10-03T00:00:00.000Z" };
		const triggered = (snippet: string) =>
			createFinding({
				...input,
				trigger: { file: "src/run.ts", index: 0, snippet },
			});

		async function lifecycle(harness: Harness, id: string) {
			return (await harness.snapshot(FindingsDocument, root.id, context))?.items[id]?.lifecycle;
		}

		let harness: Harness;
		let root: Awaited<ReturnType<typeof open>>["root"];

		beforeEach(async () => {
			({ harness, root } = await open(createMemoryStorage()));
		});

		it("is new when an ID is first seen, and tracks the revisions that report it", async () => {
			await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
			await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev2"), context);
			expect(await lifecycle(harness, evalFinding.properties.id)).toEqual({
				status: "new",
				firstSeenRevision: "rev1",
				lastSeenRevision: "rev2",
				history: [],
			});
		});

		it("keeps a dismissal when the same report is replayed", async () => {
			const finding = triggered("eval(input)");
			await root.commit((tx) => upsertFinding(tx, root.id, finding, "rev1"), context);
			await root.commit((tx) => dismissFinding(tx, root.id, finding.properties.id, dismissal), context);
			await root.commit((tx) => upsertFinding(tx, root.id, finding, "rev1"), context);
			await root.commit((tx) => upsertFinding(tx, root.id, finding, "rev2"), context);
			expect((await readFindings(harness, root.id, context)).map((each) => each.properties.status)).toEqual([
				"dismissed",
			]);
			expect(await lifecycle(harness, finding.properties.id)).toEqual({
				status: "dismissed",
				dismissedBy: "tal",
				dismissedReason: "eval input is a constant here",
				dismissedAt: "2026-10-03T00:00:00.000Z",
				firstSeenRevision: "rev1",
				lastSeenRevision: "rev2",
				history: [],
			});
		});

		it("keeps a dismissal when the trigger only moves or is rewrapped", async () => {
			const finding = triggered("eval(input)");
			const moved = createFinding({
				...input,
				trigger: { file: "src/run.ts", index: 2, snippet: "  eval(\n    input\n  )\n" },
			});
			await root.commit((tx) => upsertFinding(tx, root.id, finding, "rev1"), context);
			await root.commit((tx) => dismissFinding(tx, root.id, finding.properties.id, dismissal), context);
			await root.commit((tx) => upsertFinding(tx, root.id, moved, "rev2"), context);
			expect((await lifecycle(harness, finding.properties.id))?.status).toBe("dismissed");
		});

		it("reopens a dismissed finding whose trigger's code changed, keeping the dismissal in its history", async () => {
			const finding = triggered("run(eval(input))");
			const changed = triggered("run(eval(input), { strict: true })");
			await root.commit((tx) => upsertFinding(tx, root.id, finding, "rev1"), context);
			await root.commit((tx) => dismissFinding(tx, root.id, finding.properties.id, dismissal), context);
			await root.commit((tx) => upsertFinding(tx, root.id, changed, "rev2"), context);
			await root.commit((tx) => upsertFinding(tx, root.id, changed, "rev2"), context);
			expect(await readFindings(harness, root.id, context)).toEqual([changed]);
			expect(await lifecycle(harness, finding.properties.id)).toEqual({
				status: "new",
				firstSeenRevision: "rev1",
				lastSeenRevision: "rev2",
				history: [
					{
						dismissedBy: "tal",
						dismissedReason: "eval input is a constant here",
						dismissedAt: "2026-10-03T00:00:00.000Z",
						reopenedRevision: "rev2",
					},
				],
			});
		});

		it("refuses to dismiss a finding nobody reported", async () => {
			const dismissed = root.commit((tx) => dismissFinding(tx, root.id, "0123456789abcdef", dismissal), context);
			await expect(dismissed).rejects.toMatchObject({ code: "unknownFinding" });
		});
	});

	it("survives a reopen", async () => {
		const path = join(dir, "findings.sqlite");
		const first = await open(await openSqliteStorage(path));
		await first.root.commit((tx) => upsertFinding(tx, first.root.id, evalFinding, "rev1"), context);
		await first.harness.close(context);

		const { harness, root } = await open(await openSqliteStorage(path));
		expect(root.id).toBe(first.root.id);
		expect(await readFindings(harness, root.id, context)).toEqual([evalFinding]);
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFinding, type Finding, FindingError, type FindingInput } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	type Harness,
	openHarness,
	openSqliteStorage,
	readFindings,
	type Storage,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding), context);
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding), context);
		expect(await readFindings(harness, root.id, context)).toEqual([evalFinding]);

		await root.commit((tx) => upsertFinding(tx, root.id, reworded), context);
		expect(await readFindings(harness, root.id, context)).toEqual([reworded]);
	});

	it("keeps findings with different IDs apart, in ID order", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const other = createFinding({ ...input, snippet: "eval(body)" });
		await root.commit(async (tx) => {
			await upsertFinding(tx, root.id, evalFinding);
			await upsertFinding(tx, root.id, other);
		}, context);
		const ids = [evalFinding, other].map((finding) => finding.properties.id).sort();
		expect((await readFindings(harness, root.id, context)).map((finding) => finding.properties.id)).toEqual(ids);
	});

	it("refuses an invalid finding and commits nothing", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const invalid: Finding = { ...evalFinding, level: "note" };
		const committed = root.commit(async (tx) => {
			await upsertFinding(tx, root.id, evalFinding);
			await upsertFinding(tx, root.id, invalid);
		}, context);
		await expect(committed).rejects.toBeInstanceOf(FindingError);
		expect(await readFindings(harness, root.id, context)).toEqual([]);
	});

	it("survives a reopen", async () => {
		const path = join(dir, "findings.sqlite");
		const first = await open(await openSqliteStorage(path));
		await first.root.commit((tx) => upsertFinding(tx, first.root.id, evalFinding), context);
		await first.harness.close(context);

		const { harness, root } = await open(await openSqliteStorage(path));
		expect(root.id).toBe(first.root.id);
		expect(await readFindings(harness, root.id, context)).toEqual([evalFinding]);
	});
});

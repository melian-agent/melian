import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	type Harness,
	openHarness,
	openSqliteStorage,
	readVerdict,
	type Storage,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { ChecksDocument } from "../src/checks.ts";

// Documents of earlier versions, written raw, so the test stores the shape a released Melian left behind.
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Legacy = { [key: string]: Json };
const recorded = JSON.parse(
	readFileSync(new URL("./fixtures/stored-checks-v3/review.json", import.meta.url), "utf8"),
) as { revision: string; status: string; checks: Legacy; verdicts: Legacy };
const legacy = (kind: string, version: number) =>
	defineDoc<Legacy>({
		kind,
		version,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => ({}),
	});

let dir: string;
let opened: Harness[];
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-checks-reopen-")));
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

it("reads what version-3 checks and version-8 verdicts wrote after an SQLite reopen", async () => {
	const path = join(dir, "reopen.sqlite");
	const first = await open(await openSqliteStorage(path));
	await first.root.commit(async (tx) => {
		Object.assign(await tx.doc(legacy("melian.checks", 3), first.root.id), recorded.checks);
		Object.assign(await tx.doc(legacy("melian.verdicts", 8), first.root.id), recorded.verdicts);
	}, context);
	await first.harness.close(context);
	opened = [];

	const second = await open(await openSqliteStorage(path));
	expect(await second.harness.snapshot(ChecksDocument, second.root.id, context)).toEqual(recorded.checks);
	const verdict = (await readVerdict(second.harness, second.root.id, recorded.revision, context))!;
	expect(verdict.status).toBe(recorded.status);
	expect(verdict.notRun).toEqual([]);
	expect(await second.harness.snapshot(VerdictDocument, second.root.id, context)).toMatchObject({
		verdicts: (recorded.verdicts as { verdicts: Legacy }).verdicts,
	});
	// What the current versions wrote, the versions before refuse, so they never take a provisional record as a run.
	await second.root.commit(async (tx) => {
		(await tx.doc(ChecksDocument, second.root.id)).tasks.extra = 1;
		(await tx.doc(VerdictDocument, second.root.id)).walkthroughNotes = { [recorded.revision]: "written again" };
	}, context);
	await expect(second.harness.snapshot(legacy("melian.checks", 3), second.root.id, context)).rejects.toThrow(
		/newer version 4 than 3/,
	);
	await expect(second.harness.snapshot(legacy("melian.verdicts", 8), second.root.id, context)).rejects.toThrow(
		/newer version 13 than 8/,
	);
});

it.each([1, 2])("refuses a version-%i checks document rather than read it as the current shape", async (version) => {
	const path = join(dir, `v${version}.sqlite`);
	const first = await open(await openSqliteStorage(path));
	await first.root.commit(async (tx) => {
		Object.assign(await tx.doc(legacy("melian.checks", version), first.root.id), { runs: {}, tasks: {} });
	}, context);
	await first.harness.close(context);
	opened = [];
	const second = await open(await openSqliteStorage(path));
	await expect(second.harness.snapshot(ChecksDocument, second.root.id, context)).rejects.toThrow(
		`the checks document needs migrating from version ${version}, which Melian cannot do`,
	);
});

it("reads a version-3 static.mutation record as a run, never as provisional, after an SQLite reopen", async () => {
	const mutation = JSON.parse(
		readFileSync(new URL("./fixtures/stored-mutation-checks-v3/checks.json", import.meta.url), "utf8"),
	) as { checks: Legacy; records: Json[] };
	const path = join(dir, "mutation.sqlite");
	const first = await open(await openSqliteStorage(path));
	await first.root.commit(async (tx) => {
		Object.assign(await tx.doc(legacy("melian.checks", 3), first.root.id), mutation.checks);
	}, context);
	await first.harness.close(context);
	opened = [];
	const second = await open(await openSqliteStorage(path));
	const stored = (await second.harness.snapshot(ChecksDocument, second.root.id, context))!;
	expect(stored).toEqual(mutation.checks);
	const [record] = Object.values(stored.runs).map((run) => run["static.mutation"]);
	expect(record).toMatchObject({ name: "static.mutation", status: "ran", version: "10.0.0" });
	expect(record).toEqual(mutation.records[0]);
});

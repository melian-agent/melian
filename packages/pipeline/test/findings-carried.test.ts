import { Finding, type FindingInput, type Verification } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	type Harness,
	openHarness,
	readFindings,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearVerifications, FindingsDocument, upsertVerification } from "../src/findings.ts";

const input = (check: string, version: string | undefined = "1@careful"): FindingInput => ({
	rule: "null-dereference",
	message: `m from ${check}@${version}`,
	file: "src/a.ts",
	startLine: 3,
	snippet: "A 3",
	occurrence: 0,
	cause: "introduced",
	severity: "P2",
	source: version === undefined ? { check } : { check, version },
	failureScenario: "It throws.",
	explanation: { what: `w from ${check}@${version}`, whyHere: "h", whatToDo: "t" },
});
const verdict = (version: string): Verification => ({
	verdict: "confirmed",
	reason: "r",
	executor: "llm",
	model: "faux/judge",
	version,
});

let harness: Harness;
let root: Awaited<ReturnType<Harness["root"]>>["id"];

beforeEach(async () => {
	const fake = createFakeModels();
	harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
	root = (await harness.root(context, { agent: { model: fake.ref() } })).id;
});

afterEach(async () => {
	await harness.close(context);
});

const store = (findings: Finding[], revision = "B..H") =>
	harness.root(context).then((root_) =>
		root_.commit(async (tx) => {
			for (const each of findings) await upsertFinding(tx, root, each, revision);
		}, context),
	);

describe("a carried sighting beside its lens's own", () => {
	it("lets the lens's own sighting speak on a tie, and orders tied producers by check then version", async () => {
		const own = Finding.create(input("lens.correctness"));
		await store([Finding.create(input("carried/lens.correctness")), own]);
		const [merged] = await readFindings(harness, root, "B..H", context);
		expect(merged!.properties.source).toEqual({ check: "lens.correctness", version: "1@careful" });
		expect(merged!.properties.reportedBy).toEqual([
			{ check: "lens.correctness", version: "1@careful" },
			{ check: "carried/lens.correctness", version: "1@careful" },
		]);
		await store(
			[
				Finding.create(input("lens.correctness", "2@careful")),
				Finding.create(input("lens.correctness", "1@careful")),
			],
			"B..I",
		);
		const [versions] = await readFindings(harness, root, "B..I", context);
		expect(versions!.properties.source.version).toBe("1@careful");
		await store(
			[
				Finding.create(input("lens.correctness", "1@careful")),
				Finding.create({ ...input("lens.correctness"), source: { check: "lens.correctness" } }),
			],
			"B..J",
		);
		const [empty] = await readFindings(harness, root, "B..J", context);
		expect(empty!.properties.source.version).toBeUndefined();
	});
});

describe("clearVerifications", () => {
	it("keeps the verdicts the predicate names, deletes a revision left with none, and counts a change only when one happened", async () => {
		const a = Finding.create(input("lens.correctness"));
		const b = Finding.create(input("carried/lens.correctness"));
		await store([a, b]);
		const top = await harness.root(context);
		await top.commit(async (tx) => {
			await upsertVerification(tx, root, "B..H", a.id, a.properties.source, verdict("1"));
			await upsertVerification(tx, root, "B..H", b.id, b.properties.source, verdict("1"));
		}, context);
		const versions = async () => (await harness.snapshot(FindingsDocument, root, context))!.versions["B..H"]!;
		const before = await versions();
		await top.commit((tx) => clearVerifications(tx, root, "B..H", () => true), context);
		expect(await versions()).toBe(before);
		await top.commit(
			(tx) => clearVerifications(tx, root, "B..H", (_id, producer) => producer.startsWith("carried/")),
			context,
		);
		const state = (await harness.snapshot(FindingsDocument, root, context))!;
		expect(b.id).toBe(a.id);
		expect(Object.keys(state.items[a.id]!.verifications!["B..H"]!)).toEqual(["carried/lens.correctness@1@careful"]);
		expect(await versions()).toBe(before + 1);
		await top.commit((tx) => clearVerifications(tx, root, "B..H"), context);
		expect(
			(await harness.snapshot(FindingsDocument, root, context))!.items[b.id]!.verifications?.["B..H"],
		).toBeUndefined();
	});
});

import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Finding, type FindingInput } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	dismissFinding,
	type Harness,
	openHarness,
	openSqliteStorage,
	readFindings,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FindingsDocument,
	findingsVersion,
	inheritedDismisser,
	replaceInheritances,
	sightingVerification,
	upsertVerification,
} from "../src/findings.ts";
import recorded from "./fixtures/stored-v10/findings.json" with { type: "json" };

const at = "base..head";

const finding = (rule: string, snippet: string, overrides: Partial<FindingInput> = {}) =>
	Finding.create({
		rule,
		file: "src/review.ts",
		startLine: 3,
		snippet,
		occurrence: 0,
		severity: "P2",
		cause: "pre-existing",
		message: `${rule} message`,
		source: { check: "lens.correctness", version: "1@careful" },
		explanation: { what: "What", whyHere: "Why", whatToDo: "Fix" },
		failureScenario: "A cold run reads a cached kill.",
		evidence: [{ file: "src/review.ts", startLine: 3, role: "context", revision: "head", snippet }],
		...overrides,
	});

const root = finding("fail-open", "if (cached) return cached;");
const restated = finding("fail-open", "return cached;");
const other = finding("fail-open", "cache.read()");
const dismissal = { by: "Tal <tal@melian.invalid>", reason: "Cold runs never read it.", at: "2026-11-08T00:00:00Z" };

describe("restatement links", () => {
	let harness: Harness;
	let id: Awaited<ReturnType<Harness["root"]>>["id"];

	beforeEach(async () => {
		const fake = createFakeModels();
		harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
		const owner = await harness.root(context, { agent: { model: fake.ref() } });
		id = owner.id;
		await owner.commit(async (tx) => {
			for (const each of [root, restated, other]) await upsertFinding(tx, id, each, at);
			await dismissFinding(tx, id, root.id, dismissal, at, "P2");
		}, context);
	});

	afterEach(async () => {
		await harness.close(context);
	});

	const link = async (links: Parameters<typeof replaceInheritances>[3]) => {
		const owner = await harness.root(context);
		return owner.commit((tx) => replaceInheritances(tx, id, at, links), context);
	};
	const read = async (asReported = false) =>
		Object.fromEntries((await readFindings(harness, id, at, context, { asReported })).map((each) => [each.id, each]));

	it("records the severity a dismissal was made at, and drops it when the dismissal reopens", async () => {
		const state = await harness.snapshot(FindingsDocument, id, context);
		expect(state!.items[root.id]!.lifecycle.dismissedSeverity).toBe("P2");
		const owner = await harness.root(context);
		await owner.commit(async (tx) => {
			await dismissFinding(tx, id, other.id, dismissal, at);
		}, context);
		const after = await harness.snapshot(FindingsDocument, id, context);
		expect(after!.items[other.id]!.lifecycle).not.toHaveProperty("dismissedSeverity");
	});

	it("keeps a severity a repeated dismissal now records, without adding history", async () => {
		const owner = await harness.root(context);
		const version = await findingsVersion(harness, id, at, context);
		await owner.commit(async (tx) => {
			await dismissFinding(tx, id, other.id, dismissal, at);
		}, context);
		const replaced = await owner.commit((tx) => dismissFinding(tx, id, other.id, dismissal, at, "P3"), context);
		expect(replaced).toBeUndefined();
		const state = await harness.snapshot(FindingsDocument, id, context);
		expect(state!.items[other.id]!.lifecycle).toMatchObject({ dismissedSeverity: "P3", history: [] });
		expect(await findingsVersion(harness, id, at, context)).toBe(version + 2);
		const again = await owner.commit((tx) => dismissFinding(tx, id, other.id, dismissal, at, "P3"), context);
		expect(again).toBeUndefined();
		expect(await findingsVersion(harness, id, at, context)).toBe(version + 2);
	});

	it("replaces a dismissal's severity with the new one, or none, when it is dismissed again", async () => {
		const owner = await harness.root(context);
		await owner.commit((tx) => dismissFinding(tx, id, root.id, { ...dismissal, reason: "Another." }, at), context);
		const state = await harness.snapshot(FindingsDocument, id, context);
		expect(state!.items[root.id]!.lifecycle).not.toHaveProperty("dismissedSeverity");
	});

	it("reads an inherited finding dismissed under the root's reason and time, never naming its dismisser", async () => {
		expect(await link({ [restated.id]: { from: root.id, kind: "inherited", dismissedAt: dismissal.at } })).toBe(true);
		const findings = await read();
		expect(findings[restated.id]!.properties.status).toBe("dismissed");
		expect(findings[restated.id]!.properties.dismissal).toEqual({
			by: inheritedDismisser,
			reason: dismissal.reason,
			at: dismissal.at,
			inheritedFrom: root.id,
		});
		expect(JSON.stringify(findings[restated.id])).not.toContain("Tal");
		expect(findings[other.id]!.properties.status).toBe("new");
	});

	it("reads a proposal live, naming the likely root", async () => {
		await link({ [restated.id]: { from: root.id, kind: "proposed", dismissedAt: dismissal.at } });
		const findings = await read();
		expect(findings[restated.id]!.properties.status).toBe("new");
		expect(findings[restated.id]!.properties.dismissal).toBeUndefined();
		expect(findings[restated.id]!.properties.likelyDismissedAs).toEqual({ id: root.id });
	});

	it("applies no link to a read as reported, so candidates never flip between rounds", async () => {
		await link({
			[restated.id]: { from: root.id, kind: "inherited", dismissedAt: dismissal.at },
			[other.id]: { from: root.id, kind: "proposed", dismissedAt: dismissal.at },
		});
		const findings = await read(true);
		expect(findings[restated.id]!.properties.status).toBe("new");
		expect(findings[restated.id]!.properties.dismissal).toBeUndefined();
		expect(findings[other.id]!.properties.likelyDismissedAs).toBeUndefined();
	});

	it("lets a finding's own dismissal speak before an inherited one", async () => {
		await link({ [restated.id]: { from: root.id, kind: "inherited", dismissedAt: dismissal.at } });
		const owner = await harness.root(context);
		const own = { by: "Ana <ana@melian.invalid>", reason: "Its own reason.", at: "2026-11-09T00:00:00Z" };
		await owner.commit((tx) => dismissFinding(tx, id, restated.id, own, at), context);
		expect((await read())[restated.id]!.properties.dismissal).toEqual(own);
	});

	it("lapses when the root's dismissal is replaced, or the root reopens, and bumps the inheritor's revision", async () => {
		await link({ [restated.id]: { from: root.id, kind: "inherited", dismissedAt: dismissal.at } });
		const owner = await harness.root(context);
		const elsewhere = "base..later";
		// The root's sightings are all at `at`; a link recorded at another revision is bumped as the root changes.
		await owner.commit(async (tx) => {
			await upsertFinding(tx, id, restated, elsewhere);
			await replaceInheritances(tx, id, elsewhere, {
				[restated.id]: { from: root.id, kind: "inherited", dismissedAt: dismissal.at },
			});
		}, context);
		const before = await findingsVersion(harness, id, elsewhere, context);
		await owner.commit(
			(tx) =>
				dismissFinding(
					tx,
					id,
					root.id,
					{ ...dismissal, reason: "Replaced.", at: "2026-11-10T00:00:00Z" },
					at,
					"P2",
				),
			context,
		);
		expect((await read())[restated.id]!.properties.status).toBe("new");
		expect(await findingsVersion(harness, id, elsewhere, context)).toBe(before + 1);
		await link({ [restated.id]: { from: root.id, kind: "inherited", dismissedAt: "2026-11-10T00:00:00Z" } });
		expect((await read())[restated.id]!.properties.status).toBe("dismissed");
		const reopening = Finding.create({
			rule: "fail-open",
			file: "src/review.ts",
			startLine: 3,
			snippet: "if (cached) return cached;",
			occurrence: 0,
			severity: "P2",
			cause: "introduced",
			message: "fail-open message",
			source: { check: "lens.correctness", version: "1@careful" },
			explanation: { what: "What", whyHere: "Why", whatToDo: "Fix" },
			failureScenario: "A cold run reads a cached kill.",
			evidence: [{ file: "src/review.ts", startLine: 3, role: "cause", revision: "head", snippet: "x" }],
			trigger: { file: "src/review.ts", index: 0, snippet: "changed code" },
		});
		const lapsing = await findingsVersion(harness, id, elsewhere, context);
		await owner.commit((tx) => upsertFinding(tx, id, reopening, at), context);
		const state = await harness.snapshot(FindingsDocument, id, context);
		expect(state!.items[root.id]!.lifecycle.status).toBe("new");
		expect((await read())[restated.id]!.properties.status).toBe("new");
		expect(await findingsVersion(harness, id, elsewhere, context)).toBe(lapsing + 1);
	});

	it("bumps only the revisions that sighted a changed root or link to it", async () => {
		const owner = await harness.root(context);
		await owner.commit(async (tx) => {
			await upsertFinding(tx, id, other, "base..linked");
			await replaceInheritances(tx, id, "base..linked", {
				[other.id]: { from: root.id, kind: "inherited", dismissedAt: dismissal.at },
			});
			await upsertFinding(tx, id, restated, "base..unrelated");
			await replaceInheritances(tx, id, "base..unrelated", {
				[restated.id]: { from: other.id, kind: "inherited", dismissedAt: dismissal.at },
			});
		}, context);
		const versions = async () =>
			Promise.all(["base..linked", "base..unrelated"].map((each) => findingsVersion(harness, id, each, context)));
		const [linked, unrelated] = await versions();
		await owner.commit(
			(tx) => dismissFinding(tx, id, root.id, { ...dismissal, reason: "Another reason." }, at, "P2"),
			context,
		);
		expect(await versions()).toEqual([linked + 1, unrelated]);
		// A sighting that reopens nothing bumps only its own revision.
		await owner.commit((tx) => upsertFinding(tx, id, root, "base..again"), context);
		expect(await versions()).toEqual([linked + 1, unrelated]);
	});

	it("replaces the whole map, bumping the version only when it changed", async () => {
		const start = await findingsVersion(harness, id, at, context);
		const links = { [restated.id]: { from: root.id, kind: "inherited" as const, dismissedAt: dismissal.at } };
		expect(await link(links)).toBe(true);
		expect(await link({ ...links })).toBe(false);
		expect(await findingsVersion(harness, id, at, context)).toBe(start + 1);
		expect(await link({ [other.id]: { from: root.id, kind: "proposed", dismissedAt: dismissal.at } })).toBe(true);
		const state = await harness.snapshot(FindingsDocument, id, context);
		expect(state!.inherited).toEqual({
			[at]: { [other.id]: { from: root.id, kind: "proposed", dismissedAt: dismissal.at } },
		});
		expect(await link({})).toBe(true);
		expect((await harness.snapshot(FindingsDocument, id, context))!.inherited).toEqual({});
		expect(await findingsVersion(harness, id, at, context)).toBe(start + 3);
	});

	it("drops a producer's own claim of a likely root", async () => {
		const owner = await harness.root(context);
		const claimed = Finding.from({
			...other.toJSON(),
			properties: { ...other.properties, likelyDismissedAs: { id: root.id } },
		});
		await owner.commit((tx) => upsertFinding(tx, id, claimed, "base..third"), context);
		const state = await harness.snapshot(FindingsDocument, id, context);
		expect(
			state!.items[other.id]!.sightings["base..third"]!["lens.correctness@1@careful"]!.properties,
		).not.toHaveProperty("likelyDismissedAs");
	});
});

it("reopens main's version 10 store, keeping its dismissal and verification, with no recorded severity", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-main-v10-reopen-")));
	const path = join(directory, "state.sqlite");
	copyFileSync(new URL("./fixtures/stored-v10/state.sqlite", import.meta.url), path);
	const fake = createFakeModels();
	const open = async () =>
		openHarness(await openSqliteStorage(path), { models: fake.models, registry: createRegistry() });
	const harnesses: Harness[] = [];
	try {
		const first = await open();
		harnesses.push(first);
		const owner = await first.root(context);
		expect(owner.id).toBe(recorded.root);
		expect(recorded.version).toBe(10);
		expect(await first.snapshot(FindingsDocument, owner.id, context)).toEqual(recorded.findings);
		const [dismissed] = Object.keys(recorded.findings.items);
		const lifecycle = (await first.snapshot(FindingsDocument, owner.id, context))!.items[dismissed!]!.lifecycle;
		expect(lifecycle.status).toBe("dismissed");
		expect(lifecycle).not.toHaveProperty("dismissedSeverity");
		const source = { check: "lens.correctness", version: "1@careful" };
		const verification = await sightingVerification(
			first,
			owner.id,
			"base..accepted",
			dismissed!,
			source,
			"4190289e598badf0",
			context,
		);
		expect(verification).toMatchObject({ verdict: "confirmed", model: "faux/judge" });
		// A write stores version 11, which reads back as it was written.
		await owner.commit(async (tx) => {
			await upsertVerification(tx, owner.id, "base..accepted", dismissed!, source, {
				verdict: "confirmed",
				reason: "Reread.",
				matches: { "0123456789abcdef": "different" },
				executor: "llm",
				model: "faux/judge",
				version: "next",
			});
		}, context);
		await first.close(context);
		const second = await open();
		harnesses.push(second);
		const reread = (await second.snapshot(FindingsDocument, owner.id, context))!;
		expect(reread.items[dismissed!]!.lifecycle).toEqual(lifecycle);
		expect(
			await sightingVerification(second, owner.id, "base..accepted", dismissed!, source, "next", context),
		).toMatchObject({ matches: { "0123456789abcdef": "different" } });
		const [read] = await readFindings(second, owner.id, "base..accepted", context);
		expect(read!.properties.dismissal).toEqual({
			by: "Maintainer <maintainer@melian.invalid>",
			reason: "Cold runs never read it.",
			at: "2026-11-08T00:00:00Z",
		});
	} finally {
		for (const harness of harnesses) await harness.close(context);
		rmSync(directory, { recursive: true, force: true });
	}
});

it("reads version 10 unchanged", () => {
	expect(FindingsDocument.definition.migrate!(recorded.findings, 10)).toBe(recorded.findings);
});

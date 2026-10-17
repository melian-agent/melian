import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Finding, snippetHash } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	defineDoc,
	dismissFinding,
	openHarness,
	openSqliteStorage,
	readFindings,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";
import { FindingsDocument, findingsVersion, reopenDismissals, upsertVerification } from "../src/findings.ts";
import recorded from "./fixtures/stored-v8/findings.json" with { type: "json" };

const answer = { by: "Maintainer", at: "2026-10-17T00:00:00Z", reason: "Constant input." };
const report = (code: string, affected = false) =>
	Finding.create({
		rule: "no-eval",
		file: "src/run.ts",
		startLine: 1,
		snippet: "eval(input)",
		occurrence: 0,
		severity: "P1",
		cause: affected ? "affected" : "introduced",
		message: "Unsafe input",
		source: { check: "lens.security", version: "1" },
		explanation: { what: "Unsafe", whyHere: "New call", whatToDo: "Validate" },
		...(affected
			? {
					evidence: [
						{
							file: "src/cause.ts",
							startLine: 1,
							role: "cause" as const,
							revision: "head" as const,
							proves: true,
							snippet: code,
						},
					],
				}
			: {}),
		trigger: {
			file: "src/run.ts",
			index: 0,
			snippet: code,
			hash: snippetHash(code),
			...(affected ? { proof: [{ file: "src/cause.ts", hash: snippetHash(code) }] } : {}),
		},
	});

it.each([false, true])(
	"ties a code dismissal to its content, even on an older revision (affected: %s)",
	async (affected) => {
		const fake = createFakeModels();
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
		try {
			const root = await harness.root(context, { agent: { model: fake.ref() } });
			const a = report("eval(input)", affected);
			const b = report("eval(constant)", affected);
			const proofA = a.properties.trigger!.proof ?? [];
			const proofB = b.properties.trigger!.proof ?? [];
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, a, "A", proofA);
				await upsertFinding(tx, root.id, b, "B", proofB);
				await upsertFinding(tx, root.id, b, "C", proofB);
				await dismissFinding(tx, root.id, b.id, answer, "B");
			}, context);
			const before = await findingsVersion(harness, root.id, "C", context);
			await root.commit((tx) => upsertFinding(tx, root.id, b, "B", proofB), context);
			expect((await readFindings(harness, root.id, "B", context))[0]!.properties.status).toBe("dismissed");
			await root.commit((tx) => upsertFinding(tx, root.id, a, "A", proofA), context);
			const [reopened] = await readFindings(harness, root.id, "A", context);
			expect(reopened!.properties.status).toBe("new");
			expect(reopened!.properties.pastDismissals).toEqual([{ ...answer, reopenedRevision: "A" }]);
			expect(
				(await harness.snapshot(FindingsDocument, root.id, context))!.items[a.id]!.lifecycle.lastSeenRevision,
			).toBe("C");
			expect(await findingsVersion(harness, root.id, "C", context)).toBeGreaterThan(before);
			await root.commit(async (tx) => {
				await dismissFinding(tx, root.id, a.id, { ...answer, reason: "Reviewed A." }, "A");
				await upsertFinding(tx, root.id, a, "A", proofA);
			}, context);
			expect((await readFindings(harness, root.id, "A", context))[0]!.properties.status).toBe("dismissed");
		} finally {
			await harness.close(context);
		}
	},
);

it.each([false, true])(
	"accepts the dismissed revision rather than the last sighting, including the same reason (affected: %s)",
	async (affected) => {
		const fake = createFakeModels();
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
		try {
			const root = await harness.root(context, { agent: { model: fake.ref() } });
			const a = report("eval(input)", affected);
			const b = report("eval(constant)", affected);
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, a, "A", a.properties.trigger!.proof ?? []);
				await upsertFinding(tx, root.id, b, "B", b.properties.trigger!.proof ?? []);
				await dismissFinding(tx, root.id, b.id, answer, "B");
				await dismissFinding(tx, root.id, a.id, answer, "A");
			}, context);
			expect((await harness.snapshot(FindingsDocument, root.id, context))!.items[a.id]!.lifecycle).toMatchObject({
				dismissedTrigger: {
					hash: snippetHash("eval(input)"),
					proof: [...(a.properties.trigger!.proof ?? []), ...(b.properties.trigger!.proof ?? [])].toSorted(
						(left, right) => left.hash.localeCompare(right.hash),
					),
				},
			});
			await root.commit(
				(tx) =>
					upsertFinding(tx, root.id, a, "A", [
						...(a.properties.trigger!.proof ?? []),
						...(b.properties.trigger!.proof ?? []),
					]),
				context,
			);
			expect((await readFindings(harness, root.id, "A", context))[0]!.properties.status).toBe("dismissed");
			await root.commit((tx) => upsertFinding(tx, root.id, b, "B", b.properties.trigger!.proof ?? []), context);
			expect((await readFindings(harness, root.id, "B", context))[0]!.properties.status).toBe("new");
		} finally {
			await harness.close(context);
		}
	},
);

it("compares affected proof hashes even when the primary trigger hash stays equal", async () => {
	const fake = createFakeModels();
	const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
	try {
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		const a = report("same primary trigger", true);
		const b = Finding.from({
			...a.toJSON(),
			properties: {
				...a.properties,
				trigger: {
					...a.properties.trigger!,
					proof: [{ file: "src/cause.ts", hash: snippetHash("changed cause") }],
				},
			},
		});
		await root.commit(async (tx) => {
			await upsertFinding(tx, root.id, a, "A", a.properties.trigger!.proof);
			await upsertFinding(tx, root.id, b, "B", b.properties.trigger!.proof);
			await dismissFinding(tx, root.id, b.id, answer, "B");
			await upsertFinding(tx, root.id, a, "A", a.properties.trigger!.proof);
		}, context);
		expect((await readFindings(harness, root.id, "A", context))[0]!.properties.status).toBe("new");
	} finally {
		await harness.close(context);
	}
});

it("keeps version-8 dismissal behaviour through SQLite migration and a second reopen", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-v8-dismissal-")));
	const path = join(dir, "state.sqlite");
	const fake = createFakeModels();
	const old = defineDoc({
		kind: "melian.findings",
		version: 8,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => recorded.findings,
	});
	const open = async () =>
		openHarness(await openSqliteStorage(path), { models: fake.models, registry: createRegistry() });
	try {
		const first = await open();
		try {
			const root = await first.root(context, { agent: { model: fake.ref() } });
			await root.commit(async (tx) => {
				Object.assign(await tx.doc(old, root.id), recorded.findings);
			}, context);
		} finally {
			await first.close(context);
		}
		const second = await open();
		try {
			const root = await second.root(context);
			const [a] = await readFindings(second, root.id, "A", context);
			expect(a!.properties.dismissal).toEqual(answer);
			await root.commit((tx) => reopenDismissals(tx, root.id, "A", []), context);
			await root.commit((tx) => reopenDismissals(tx, root.id, "absent", []), context);
			await root.commit((tx) => upsertFinding(tx, root.id, a!, "A"), context);
			expect((await readFindings(second, root.id, "A", context))[0]!.properties.status).toBe("dismissed");
			await root.commit((tx) => upsertFinding(tx, root.id, a!, "C"), context);
			expect((await readFindings(second, root.id, "C", context))[0]!.properties.status).toBe("new");
			await root.commit((tx) => dismissFinding(tx, root.id, a!.id, answer, "C"), context);
		} finally {
			await second.close(context);
		}
		const third = await open();
		try {
			const root = await third.root(context);
			expect((await readFindings(third, root.id, "C", context))[0]!.properties.pastDismissals).toEqual([
				{ ...answer, reopenedRevision: "C" },
			]);
			const [b] = await readFindings(third, root.id, "B", context);
			await root.commit((tx) => upsertFinding(tx, root.id, b!, "B"), context);
			expect((await readFindings(third, root.id, "B", context))[0]!.properties.status).toBe("new");
		} finally {
			await third.close(context);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([false, true])(
	"reopens cached sightings without clearing either producer’s verification (affected: %s)",
	async (affected) => {
		const fake = createFakeModels();
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
		try {
			const root = await harness.root(context, { agent: { model: fake.ref() } });
			const a = report("eval(input)", affected);
			const other = Finding.from({
				...a.toJSON(),
				properties: { ...a.properties, source: { ...a.properties.source, version: "2" } },
			});
			const b = report("eval(constant)", affected);
			const verification = {
				verdict: "confirmed",
				reason: "Traced code.",
				executor: "llm",
				model: "faux/judge",
				version: "probe",
			} as const;
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, a, "A", a.properties.trigger!.proof ?? []);
				await upsertFinding(tx, root.id, other, "A", a.properties.trigger!.proof ?? []);
				await upsertFinding(tx, root.id, b, "B", b.properties.trigger!.proof ?? []);
				await dismissFinding(tx, root.id, b.id, answer, "B");
				await upsertVerification(tx, root.id, "A", a.id, a.properties.source, verification);
				await upsertVerification(tx, root.id, "A", a.id, other.properties.source, verification);
			}, context);
			const before = structuredClone(
				(await harness.snapshot(FindingsDocument, root.id, context))!.items[a.id]!.verifications,
			);
			const beforeA = await findingsVersion(harness, root.id, "A", context);
			const beforeB = await findingsVersion(harness, root.id, "B", context);
			await root.commit((tx) => reopenDismissals(tx, root.id, "A", a.properties.trigger!.proof ?? []), context);
			const record = (await harness.snapshot(FindingsDocument, root.id, context))!.items[a.id]!;
			expect(record.lifecycle.status).toBe("new");
			expect(record.lifecycle.history).toHaveLength(1);
			expect(record.verifications).toEqual(before);
			expect(record.lifecycle.proof).toEqual(a.properties.trigger!.proof ?? []);
			expect(record.lifecycle.dismissedTrigger).toBeUndefined();
			expect(await findingsVersion(harness, root.id, "A", context)).toBe(beforeA + 1);
			expect(await findingsVersion(harness, root.id, "B", context)).toBe(beforeB + 1);
		} finally {
			await harness.close(context);
		}
	},
);

it("keeps absent legacy dismissal attribution when reopening", async () => {
	const fake = createFakeModels();
	const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
	try {
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		const a = report("eval(input)");
		const b = report("eval(constant)");
		await root.commit(async (tx) => {
			await upsertFinding(tx, root.id, a, "A");
			(await tx.doc(FindingsDocument, root.id)).items[a.id]!.lifecycle.status = "dismissed";
			await upsertFinding(tx, root.id, b, "B");
		}, context);
		expect((await readFindings(harness, root.id, "B", context))[0]!.properties.pastDismissals).toEqual([
			{ by: "", reason: "", at: "", reopenedRevision: "B" },
		]);
	} finally {
		await harness.close(context);
	}
});

it("keeps every accumulated cause when a dismissal accepts a narrower citation", async () => {
	const fake = createFakeModels();
	const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
	try {
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		const a = report("X", true);
		const b = report("Y", true);
		const c = report("X2", true);
		const x = a.properties.trigger!.proof!;
		const y = b.properties.trigger!.proof!;
		await root.commit(async (tx) => {
			await upsertFinding(tx, root.id, a, "A", x);
			await upsertFinding(tx, root.id, b, "B", [...x, ...y]);
			await dismissFinding(tx, root.id, b.id, answer, "B");
		}, context);
		const accepted = structuredClone(
			(await harness.snapshot(FindingsDocument, root.id, context))!.items[a.id]!.lifecycle,
		);
		await root.commit((tx) => upsertFinding(tx, root.id, c, "C", [...c.properties.trigger!.proof!, ...y]), context);
		const [reopened] = await readFindings(harness, root.id, "C", context);
		expect(reopened!.properties.status).toBe("new");
		expect(reopened!.properties.pastDismissals).toEqual([{ ...answer, reopenedRevision: "C" }]);
		expect(accepted.proof).toHaveLength(2);
		expect(accepted.proof).toEqual(expect.arrayContaining([...x, ...y]));
		expect(accepted.dismissedTrigger!.proof).toEqual(accepted.proof);
	} finally {
		await harness.close(context);
	}
});

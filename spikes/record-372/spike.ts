// Issue #372: can a fresh host seed a review from records and run only what is missing? Run from the worktree root:
// node --conditions=@melian-agent/source spikes/record-372/spike.ts

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Lens, Revision } from "@melian-agent/core";
import { type CheckRunRecord, backgroundContext as context, reviewChangeset, runChecks } from "@melian-agent/pipeline";
import { DirectoryRecordStore, recordId, Signer, verified, winners } from "./records.mjs";
import { reference } from "./reference.ts";
import { config, fakeModels, lensRequests, open, repository, type Setup, scratch, setup } from "./scenario.ts";
import { checkKey, exportFinished, type Imported, type SeedLog, seedChecks, seededLensExtension } from "./seed.ts";

const repo = repository();
const scene = await setup(repo);
const revision = Revision.key(scene.changeset.revision);
const changesetId = revision;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// The check policy hash of a store's run, from a tier that names no check: runChecks computes the identity and runs
// nothing. runIdentity in packages/pipeline/src/checks.ts is not exported.
async function checkPolicy(harness: Awaited<ReturnType<typeof open>>, policy: ReturnType<typeof config>) {
	const root = (await harness.root(context)).id;
	const run = await runChecks(
		harness,
		{
			rootConversationId: root,
			changeset: scene.changeset,
			config: { ...policy, tiers: { ...policy.tiers, "only.none": [] } },
			source: scene.source,
			tier: "only.none",
		},
		context,
	);
	return run.identity.policy;
}

async function checksOf(
	harness: Awaited<ReturnType<typeof open>>,
	policy: ReturnType<typeof config>,
	names: readonly string[],
) {
	const root = (await harness.root(context)).id;
	const records: CheckRunRecord[] = [];
	let identity: string | undefined;
	for (const name of names) {
		const run = await runChecks(
			harness,
			{
				rootConversationId: root,
				changeset: scene.changeset,
				config: policy,
				source: scene.source,
				tier: `only.${name}`,
			},
			context,
		);
		identity = run.identity.policy;
		records.push(...run.records);
	}
	return { records, policy: identity };
}

// ---- Store A: checks guardrails and static.tsc finish, static.biome never starts; correctness and conventions
// finish, contracts holds its first request forever.
const a = fakeModels(scene.lenses, ["contracts"]);
const harnessA = await open(repo, join(mkdtempSync(join(scratch, "a-")), "store.sqlite"), a.fake);
const policyA = config(scene, a.fake);
const checksA = await checksOf(harnessA, policyA, ["guardrails", "static.tsc"]);
const policyHashA = await checkPolicy(harnessA, policyA);
void reviewChangeset({
	harness: harnessA,
	changeset: scene.changeset,
	config: policyA,
	lenses: scene.lenses,
	standards: [],
	models: a.fake.review,
	checks: checksA.records,
}).catch((error: unknown) => console.error("A ended:", error));
const lensesOf = (requests: Record<string, unknown[]>) => lensRequests(requests as never, scene.lenses);
for (let waited = 0; ; waited += 50) {
	const seen = lensesOf(a.requests);
	if (seen.correctness === 2 && seen.conventions === 1 && seen.contracts === 1 && (seen.verifier ?? 0) >= 1) break;
	if (waited > 60_000) throw new Error(`A never reached the stop point: ${JSON.stringify(seen)}`);
	await sleep(50);
}
await sleep(500);
const requestsA = lensesOf(a.requests);

// ---- Export A's finished results as signed records into a directory store.
const signer = new Signer();
const recordsDir = mkdtempSync(join(scratch, "records-"));
const store = await DirectoryRecordStore.open({ root: recordsDir });
const exported = await exportFinished(harnessA, { records: checksA.records, policy: policyHashA });
for (const each of exported) await store.add(signer.record(changesetId, each.kind, each.key, each.payload));

// Reads the store as B does: only records signed by a trusted key, the lowest ID per kind and key.
async function importable(): Promise<Imported[]> {
	const trusted = new Map([[signer.id, signer.raw]]);
	const listed = await store.list(changesetId);
	const signed = listed.filter((record: Parameters<typeof verified>[0]) => verified(record, trusted));
	return winners(signed).map((record: { kind: string; key: string; payload: Record<string, unknown> }) => ({
		kind: record.kind,
		key: record.key,
		id: recordId(record),
		payload: record.payload,
	}));
}

// ---- Store B: empty, seeded from the records, then the same review.
async function seeded(
	label: string,
	lenses: Lens[],
	adjust: (scene: Setup, policy: ReturnType<typeof config>) => ReturnType<typeof config> = (_, p) => p,
) {
	const imported = await importable();
	const log: SeedLog = { used: [], missed: [] };
	const b = fakeModels(lenses);
	const harness = await open(
		repo,
		join(mkdtempSync(join(scratch, `${label}-`)), "store.sqlite"),
		b.fake,
		seededLensExtension(imported, log),
	);
	const policy = adjust(scene, config(scene, b.fake));
	const policyHash = await checkPolicy(harness, policy);
	const tierChecks = ["guardrails", "static.tsc", "static.biome"];
	const byKey = new Map(imported.filter((record) => record.kind === "check").map((record) => [record.key, record]));
	const usedChecks = tierChecks.filter((name) => byKey.has(checkKey(name, policyHash)));
	await seedChecks(
		harness,
		revision,
		usedChecks.map((name) => byKey.get(checkKey(name, policyHash))!),
	);
	const missing = tierChecks.filter((name) => !usedChecks.includes(name));
	const ran = await checksOf(harness, policy, missing);
	const records = tierChecks.map(
		(name) =>
			(byKey.get(checkKey(name, policyHash))?.payload.record as CheckRunRecord | undefined) ??
			ran.records.find((record) => record.name === name)!,
	);
	const review = await reviewChangeset({
		harness,
		changeset: scene.changeset,
		config: policy,
		lenses,
		standards: [],
		models: b.fake.review,
		checks: records,
	});
	await harness.close(context);
	return {
		verdict: review.verdict.toJSON(),
		requests: lensRequests(b.requests, lenses),
		checks: { imported: usedChecks, ran: missing },
		lenses: log,
		firstRequests: Object.fromEntries(
			Object.entries(b.requests).map(([match, seen]) => [
				lenses.find((lens) => lens.instructions === match)?.name ?? "verifier",
				seen.map((messages) => messages.filter((m) => m.role === "user").length),
			]),
		),
	};
}

const ref = await reference(repo);
const b = await seeded("b", scene.lenses);
const bumped = scene.lenses.map((lens) =>
	lens.name === "correctness" ? Lens.from({ ...lens.toJSON(), version: "bumped000000" }) : lens,
);
const version = await seeded("b-version", bumped);
const level = await seeded("b-level", scene.lenses, (_, policy) => ({
	...policy,
	lenses: {
		...policy.lenses,
		correctness: { ...policy.lenses.correctness, level: { floor: "deep", ceiling: "deep" } },
	},
}));
const budgeted = scene.lenses.map((lens) => {
	if (lens.name !== "correctness") return lens;
	const fields = lens.toJSON();
	const careful = fields.levels.careful;
	return Lens.from({
		...fields,
		levels: { ...fields.levels, careful: { ...careful, budget: { ...careful.budget, findings: 7 } } },
	});
});
const policyRun = await seeded("b-policy", budgeted);
const checkPolicyRun = await seeded("b-check-policy", scene.lenses, (_, policy) => ({
	...policy,
	guardrails: {
		...policy.guardrails,
		"forbidden-patterns": {
			...policy.guardrails["forbidden-patterns"],
			rules: { ...policy.guardrails["forbidden-patterns"].rules, fixme: { pattern: "FIXME", message: "fix it" } },
		},
	},
}));

const summary = {
	revision,
	A: { requests: requestsA, exported: exported.map((each) => ({ kind: each.kind, key: each.key })) },
	reference: { requests: ref.requests },
	B: {
		requests: b.requests,
		checks: b.checks,
		lenses: b.lenses,
		verdictEqualsReference: isDeepStrictEqual(b.verdict, ref.verdict),
	},
	mismatch: Object.fromEntries(
		Object.entries({ version, level, policy: policyRun, checkPolicy: checkPolicyRun }).map(([name, run]) => [
			name,
			{
				requests: run.requests,
				checks: run.checks,
				used: run.lenses.used,
				missed: run.lenses.missed.map((each) => each.key),
			},
		]),
	),
};
const out = mkdtempSync(join(scratch, "out-"));
writeFileSync(join(out, "verdicts.json"), JSON.stringify({ reference: ref.verdict, b: b.verdict }, null, 2));
writeFileSync(join(out, "records.json"), JSON.stringify(await store.list(changesetId), null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`verdicts and records in ${out}`);
process.exit(0);

// One conformance script for both adapters. Usage:
//   node conformance.mjs git <remote> <ref>
//   node conformance.mjs dir <root>
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { canonical, openStore, recordId, Signer } from "./store.mjs";

const [kind, ...rest] = process.argv.slice(2);
const options = kind === "git" ? { remote: rest[0], ref: rest[1] } : { root: rest[0] };
const store = await openStore(kind, options);
const signer = new Signer();
const fresh = () => `spike370-${randomBytes(6).toString("hex")}`;
const ids = (records) => records.map(recordId).sort();
const results = [];

async function check(name, body) {
	const changeset = fresh();
	try {
		await body(changeset);
		results.push({ name, ok: true });
	} catch (error) {
		results.push({ name, ok: false, error: error.message.split("\n")[0] });
	} finally {
		await store.dispose(changeset).catch(() => {});
	}
}

await check("add then list returns the same canonical bytes", async (cs) => {
	const record = signer.record(cs, "check", "static.biome", { status: "ran", findings: [] });
	await store.add(record);
	const listed = await store.list(cs);
	assert.equal(listed.length, 1);
	assert.equal(canonical(listed[0]), canonical(record));
});

await check("the same bytes added twice are one record", async (cs) => {
	const record = signer.record(cs, "lens", "correctness@abc@careful", { findings: 2 });
	await store.add(record);
	await store.add(structuredClone(record));
	assert.deepEqual(ids(await store.list(cs)), [recordId(record)]);
});

await check("two different records under one kind and key are both kept", async (cs) => {
	const a = signer.record(cs, "lens", "design@1@careful", { findings: 1 });
	const b = signer.record(cs, "lens", "design@1@careful", { findings: 3 });
	await store.add(a);
	await store.add(b);
	assert.deepEqual(ids(await store.list(cs)), [recordId(a), recordId(b)].sort());
});

await check("a list names only its own changeset", async (cs) => {
	const other = fresh();
	try {
		await store.add(signer.record(other, "check", "guardrails", {}));
		await store.add(signer.record(cs, "check", "guardrails", { mine: true }));
		const listed = await store.list(cs);
		assert.equal(listed.length, 1);
		assert.equal(listed[0].changeset, cs);
	} finally {
		await store.dispose(other);
	}
});

await check("a key with slashes, spaces and non-ASCII text, and a Unicode payload, round-trip", async (cs) => {
	const record = signer.record(cs, "dismissal", "src/a b/ü.ts:12 ../../etc", { reason: "ok — 日本語   \0", n: 1.5 });
	await store.add(record);
	const [listed] = await store.list(cs);
	assert.equal(recordId(listed), recordId(record));
});

await check("key order in the payload does not change the record's ID", async (cs) => {
	const a = signer.record(cs, "post", "k", { b: 1, a: { d: 2, c: 3 } });
	const b = { ...a, payload: { a: { c: 3, d: 2 }, b: 1 } };
	await store.add(a);
	await store.add(b);
	assert.equal((await store.list(cs)).length, 1);
});

await check("an empty changeset lists nothing and reads an empty cell", async (cs) => {
	assert.deepEqual(await store.list(cs), []);
	assert.deepEqual(await store.readCell(cs), {});
});

await check("writeCell compares and sets", async (cs) => {
	assert.equal(await store.writeCell(cs, undefined, "lease A"), true);
	const first = await store.readCell(cs);
	assert.equal(first.value, "lease A");
	assert.ok(first.version);
	assert.equal(await store.writeCell(cs, undefined, "lease B"), false, "absent expected on a set cell");
	assert.equal(await store.writeCell(cs, "not-a-version", "lease B"), false, "wrong expected");
	assert.equal(await store.writeCell(cs, first.version, "lease B"), true);
	assert.equal(await store.writeCell(cs, first.version, "lease C"), false, "stale expected");
	assert.equal((await store.readCell(cs)).value, "lease B");
});

await check("writeCell refuses a write that would leave the version unchanged", async (cs) => {
	assert.equal(await store.writeCell(cs, undefined, "same"), true);
	const { version } = await store.readCell(cs);
	assert.equal(await store.writeCell(cs, version, "same"), false);
});

await check("the cell is not a record", async (cs) => {
	await store.writeCell(cs, undefined, "lease");
	await store.add(signer.record(cs, "round", "r1", {}));
	assert.equal((await store.list(cs)).length, 1);
});

await check("dispose removes records and the cell, and leaves other changesets", async (cs) => {
	const other = fresh();
	try {
		await store.add(signer.record(cs, "check", "x", {}));
		await store.writeCell(cs, undefined, "lease");
		await store.add(signer.record(other, "check", "x", {}));
		await store.dispose(cs);
		assert.deepEqual(await store.list(cs), []);
		assert.deepEqual(await store.readCell(cs), {});
		assert.equal((await store.list(other)).length, 1);
	} finally {
		await store.dispose(other);
	}
});

await store.close();
for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${kind}  ${r.name}${r.ok ? "" : `: ${r.error}`}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);

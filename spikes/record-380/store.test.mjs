// Cases 4 (the lease race), 7 and 9, and our own, on the git adapter over a local bare repository and the directory adapter.
// Run: node --experimental-strip-types --no-warnings --test --test-concurrency=1 spikes/record-380/store.test.mjs
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { envelope, Publisher, standing } from "./rules.mjs";
import { DirectoryRecordStore as Directory370 } from "./store370.mjs";
import { DirectoryRecordStore, GitRecordStore, git, localRemote, recordId, UnknownFile } from "./stores.mjs";

const opened = [];
async function remote() {
	const r = await localRemote();
	opened.push(r);
	return r;
}
async function gitStore(r, options = {}) {
	const store = await GitRecordStore.open({ remote: r.url, ...options });
	opened.push(store);
	return store;
}
const dirStore = async () => DirectoryRecordStore.open({ root: await mkdtemp(join(tmpdir(), "spike-380-dir-")) });
after(async () => {
	for (const each of opened) await each.close();
});

const batch = (changeset, n, tag = "") =>
	Array.from({ length: n }, (_, i) => envelope(changeset, "lens", `lens-${tag}${i}`, { i, tag }));

// Commits a tree by hand onto the remote's branch, as a writer who does not use the adapter would.
async function commitByHand(r, files) {
	const work = await mkdtemp(join(tmpdir(), "spike-380-hand-"));
	await git(work, ["init", "-q"]);
	await git(work, ["fetch", "-q", r.url, "refs/heads/melian/state"]).catch(() => {});
	const parent = (await git(work, ["rev-parse", "FETCH_HEAD"]).catch(() => "")).trim();
	if (parent) await git(work, ["read-tree", parent]);
	for (const [path, bytes] of Object.entries(files)) {
		const blob = (await git(work, ["hash-object", "-w", "--stdin"], { input: bytes })).trim();
		await git(work, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
	}
	const tree = (await git(work, ["write-tree"])).trim();
	const commit = (
		await git(work, [
			"-c",
			"user.name=h",
			"-c",
			"user.email=h@invalid",
			"commit-tree",
			tree,
			...(parent ? ["-p", parent] : []),
			"-m",
			"by hand",
		])
	).trim();
	await git(work, ["push", "-q", r.url, `${commit}:refs/heads/melian/state`]);
}

const leaseStore = (store, changeset) =>
	new Publisher({ store, changeset, octokit: undefined, owner: "o", repo: "r", number: 1, holder: undefined });

describe("case 4: two publishers race for the cell's lease", () => {
	test("4c, git adapter: exactly one of two separate handles takes it, in each of five trials", async () => {
		const r = await remote();
		for (let trial = 0; trial < 5; trial++) {
			const changeset = `pull-race-${trial}`;
			const [a, b] = [await gitStore(r), await gitStore(r)];
			const results = await Promise.all(
				[a, b].map((store, i) => Object.assign(leaseStore(store, changeset), { holder: `host-${i}` }).take()),
			);
			assert.equal(results.filter((each) => each.lease).length, 1, JSON.stringify(results));
		}
	});

	test("4c, directory adapter: exactly one of two handles takes it, in each of fifty trials", async () => {
		const root = await mkdtemp(join(tmpdir(), "spike-380-dir-"));
		for (let trial = 0; trial < 50; trial++) {
			const stores = [await DirectoryRecordStore.open({ root }), await DirectoryRecordStore.open({ root })];
			const results = await Promise.all(
				stores.map((store, i) => Object.assign(leaseStore(store, `pull-${trial}`), { holder: `host-${i}` }).take()),
			);
			assert.equal(results.filter((each) => each.lease).length, 1);
		}
	});

	test("4d, directory adapter: a holder that dies inside the cell's lock stops every later write, lease or not", async () => {
		const store = await dirStore();
		await assert.rejects(store.writeCell("pull-1", undefined, "lease", { dieInsideLock: true }), { code: "died" });
		// FINDING (adapter): no expiry frees a mkdir lock; only a person removing the directory does.
		await assert.rejects(store.writeCell("pull-1", undefined, "lease", { lockWaitMs: 200 }), { code: "lockHeld" });
	});

	test("own case 4e: the #370 adapters' version is a hash of the value, so a stale writer gets through after A-B-A", async () => {
		const store = await Directory370.open({ root: await mkdtemp(join(tmpdir(), "spike-380-370-")) });
		await store.writeCell("pull-1", undefined, "free");
		const stale = (await store.readCell("pull-1")).version;
		assert.equal(await store.writeCell("pull-1", stale, "held by b"), true);
		const b = (await store.readCell("pull-1")).version;
		assert.equal(await store.writeCell("pull-1", b, "free"), true);
		// Rule 3 forbids this version; the spike adapter on #370 has it, and its "refuse the same value" guard does not help.
		assert.equal(await store.writeCell("pull-1", stale, "held by a, from a stale read"), true);
		const ours = await dirStore();
		await ours.writeCell("pull-1", undefined, "free");
		const oursStale = (await ours.readCell("pull-1")).version;
		await ours.writeCell("pull-1", oursStale, "held by b");
		await ours.writeCell("pull-1", (await ours.readCell("pull-1")).version, "free");
		assert.equal(await ours.writeCell("pull-1", oursStale, "held by a"), false);
	});
});

describe("case 7: the git adapter", () => {
	test("7a, a file the adapter does not know refuses the whole branch, for every changeset", async () => {
		const r = await remote();
		const store = await gitStore(r);
		await store.add(batch("pull-1", 2));
		await commitByHand(r, { "README.md": "notes\n" });
		await assert.rejects(store.list("pull-1"), UnknownFile);
		await assert.rejects(store.list("pull-2"), UnknownFile);
		await assert.rejects(store.add(batch("pull-2", 1)), UnknownFile);
		await assert.rejects(store.writeCell("pull-2", undefined, "lease"), UnknownFile);
	});

	test("own case 7b, a known path whose bytes are another changeset's record is listed under the path's changeset", async () => {
		const r = await remote();
		const store = await gitStore(r);
		const other = envelope("pull-9", "dismissal", "finding-1", { reason: "written for #9" });
		const id = recordId(other);
		await commitByHand(r, {
			[`changesets/pull-1/dismissal/${"0".repeat(64)}/${"1".repeat(64)}.json`]: JSON.stringify(other),
		});
		const listed = await store.list("pull-1");
		// FINDING: the adapter accepts the path; the record names pull-9, another key and another ID than its path says.
		assert.equal(listed.length, 1);
		assert.equal(listed[0].changeset, "pull-9");
		assert.notEqual(id, "1".repeat(64));
	});

	test("7c, a batch of 200 records lands in one commit and one push", async () => {
		const r = await remote();
		const store = await gitStore(r);
		const started = Date.now();
		await store.add(batch("pull-1", 200));
		const ms = Date.now() - started;
		assert.equal(store.stats.pushes, 1);
		assert.equal((await store.list("pull-1")).length, 200);
		assert.equal((await git(r.dir, ["rev-list", "--count", "refs/heads/melian/state"])).trim(), "1");
		console.log(`# 7c: 200 records in ${ms} ms`);
	});

	test("7d, two writers adding batches to two changesets at once both land, with a 0.5 s push", async () => {
		const r = await remote();
		await r.delay("pre-receive", 0.5);
		const [a, b] = [await gitStore(r), await gitStore(r)];
		await Promise.all([a.add(batch("pull-1", 50, "a")), b.add(batch("pull-2", 50, "b"))]);
		assert.equal((await a.list("pull-1")).length, 50);
		assert.equal((await a.list("pull-2")).length, 50);
		console.log(`# 7d: lost races a=${a.stats.lostRaces} b=${b.stats.lostRaces}`);
	});

	test("own case 7e, eight and then twelve writers at once with a 3.3 s push, as on GitHub: who gives up after ten lost races?", async () => {
		for (const writers of [8, 12]) {
			const r = await remote();
			await r.delay("pre-receive", 3.3);
			const stores = await Promise.all(Array.from({ length: writers }, () => gitStore(r)));
			const outcomes = await Promise.allSettled(stores.map((store, i) => store.add(batch(`pull-${i}`, 5, `w${i}`))));
			const gaveUp = outcomes.filter((each) => each.status === "rejected").map((each) => each.reason.code);
			console.log(
				`# 7e: ${writers} writers: gave up ${gaveUp.length}; lost races ${stores.map((s) => s.stats.lostRaces).join(",")}`,
			);
			assert.ok(gaveUp.every((code) => code === "gaveUp"));
			// Each round of pushes lands one writer, and the backoff never outlasts a push, so the rest all lose again.
			assert.equal(gaveUp.length, Math.max(0, writers - 10));
		}
	});

	test("7f, a push stopped at its deadline whose commit landed counts as landed", async () => {
		const r = await remote();
		await r.delay("post-receive", 3);
		const store = await gitStore(r, { deadlineMs: 1500 });
		await store.add(batch("pull-1", 3));
		assert.equal(store.stats.deadlines, 1);
		assert.equal(store.stats.landedAtDeadline, 1);
		await r.delay("post-receive", 0);
		assert.equal((await store.list("pull-1")).length, 3);
	});

	test("own case 7g, a cell write that landed, then another writer's commit on top, reads as a lost write", async () => {
		for (const landedWhen of ["tip", "ancestor"]) {
			const r = await remote();
			await r.delay("post-receive", 3);
			const a = await gitStore(r, { deadlineMs: 1500, landedWhen });
			const b = await gitStore(r);
			const taking = a.writeCell("pull-1", undefined, "lease held by a");
			await new Promise((resolve) => setTimeout(resolve, 600));
			await b.add(batch("pull-2", 1));
			const won = await taking;
			await r.delay("post-receive", 0);
			const cell = await b.readCell("pull-1");
			assert.equal(cell.value, "lease held by a", "a's write is on the branch");
			// FINDING under "the tip is the commit it sent": a believes it lost a lease it holds, until the lease expires.
			assert.equal(won, landedWhen === "ancestor");
		}
	});
});

describe("case 9: dispose while another host adds", () => {
	test("9a, git adapter: an add that lands after the dispose leaves a part of the changeset that nothing disposes", async () => {
		const r = await remote();
		await r.delay("pre-receive", 0.3);
		const [a, b] = [await gitStore(r), await gitStore(r)];
		await a.add(batch("pull-1", 3, "round1-"));
		await Promise.all([
			a.dispose("pull-1"),
			new Promise((resolve) => setTimeout(resolve, 50)).then(() => b.add(batch("pull-1", 2, "late-"))),
		]);
		const left = await a.list("pull-1");
		console.log(
			`# 9a: after dispose and a racing add, ${left.length} records remain: ${left.map((each) => each.payload.tag).join(",")}`,
		);
		assert.ok(left.length === 2 || left.length === 0);
	});

	test("9b, directory adapter: a dispose between an add's mkdir and its rename fails the add or leaves a part", async () => {
		const store = await dirStore();
		const outcomes = [];
		for (let trial = 0; trial < 200; trial++) {
			const changeset = `pull-${trial}`;
			await store.add(batch(changeset, 1, "first-"));
			const [, added] = await Promise.allSettled([
				store.dispose(changeset),
				store.add(batch(changeset, 20, "late-")),
			]);
			const left = (await store.list(changeset)).length;
			outcomes.push(added.status === "rejected" ? `add failed (${added.reason.code})` : `${left} left`);
		}
		const counts = new Map();
		for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
		const tally = [...counts];
		console.log(`# 9b: ${tally.map(([o, n]) => `${n}× ${o}`).join("; ")}`);
		assert.ok(tally.length >= 1);
	});

	test("own case 9c, a round whose closing record lands after a dispose took its batch reads as not reviewed", async () => {
		const store = await dirStore();
		const lenses = batch("pull-1", 3);
		await store.add(lenses);
		await store.dispose("pull-1");
		const closing = envelope("pull-1", "round", "1", {
			rests: lenses.map((each) => ({ kind: each.kind, key: each.key, id: recordId(each) })),
		});
		await store.add([closing]);
		const present = new Set((await store.list("pull-1")).map(recordId));
		const missing = closing.payload.rests.filter((each) => !present.has(each.id));
		assert.equal(missing.length, 3, "rule 4 reads the round as not reviewed, so the race fails closed");
		assert.equal(standing(await store.list("pull-1")).length, 1, "and the changeset exists again after its dispose");
	});
});

test("the cell is not a record, and the adapter knows its path", async () => {
	const r = await remote();
	const store = await gitStore(r);
	await store.writeCell("pull-1", undefined, "lease");
	assert.equal((await store.list("pull-1")).length, 0);
});

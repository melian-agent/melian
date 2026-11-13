// Cases 6 and 8, and our own, on rule 6's write access as the trust and rule 7's dismissals.
// Run: node --experimental-strip-types --no-warnings --test spikes/record-380/trust.test.mjs
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { addHandedOver, addHandedOverStrict, envelope, standing } from "./rules.mjs";
import { canonical, DirectoryRecordStore, recordId } from "./stores.mjs";

const dirStore = async () => DirectoryRecordStore.open({ root: await mkdtemp(join(tmpdir(), "spike-380-dir-")) });
const revision = "base..head";
const dismissal = (changeset, by) =>
	envelope(
		changeset,
		"dismissal",
		"finding-0123456789abcdef",
		{ by, reason: "accepted risk", severity: "P1" },
		{ revision },
	);
const reviewBatch = (changeset) => [
	envelope(changeset, "lens", "correctness@1@careful", { findings: ["finding-0123456789abcdef"] }, { revision }),
	envelope(changeset, "check", "static.tsc@policy", { status: "ran" }, { revision }),
];
const dismissed = async (store, changeset) =>
	standing(await store.list(changeset))
		.filter((record) => record.kind === "dismissal")
		.map((record) => record.payload.by);

describe("case 6: a dismissal from a writer, and one in a batch from a job that ran the head's code", () => {
	test("6a, the adding job's shape check passes both, and nothing in either record tells them apart", async () => {
		const store = await dirStore();
		await store.add([dismissal("pull-7", "Writer <writer@example.invalid>")]);
		const fromHead = await dirStore();
		await addHandedOver(fromHead, [...reviewBatch("pull-7"), dismissal("pull-7", "Writer <writer@example.invalid>")]);
		// FINDING: the same bytes, so the same ID. Rule 7 reads "the store accepted the write, so a writer made it".
		const [a] = (await store.list("pull-7")).filter((record) => record.kind === "dismissal");
		const [b] = (await fromHead.list("pull-7")).filter((record) => record.kind === "dismissal");
		assert.equal(recordId(a), recordId(b));
		assert.deepEqual(await dismissed(fromHead, "pull-7"), ["Writer <writer@example.invalid>"]);
	});

	test("6b, a stricter adding job, by kind, changeset, revision and supersedes, refuses the head's dismissal and passes its review", async () => {
		const store = await dirStore();
		const pin = { changeset: "pull-7", revision };
		await assert.rejects(
			addHandedOverStrict(store, [...reviewBatch("pull-7"), dismissal("pull-7", "x")], pin),
			/may not add a dismissal/,
		);
		await assert.rejects(addHandedOverStrict(store, reviewBatch("pull-8"), pin), /another|changeset pull-8/);
		await addHandedOverStrict(store, reviewBatch("pull-7"), pin);
		assert.equal((await store.list("pull-7")).length, 2);
	});

	test("own case 6c, a head job's lens record that supersedes a writer's dismissal passes the shape check, and the dismissal stops counting", async () => {
		const store = await dirStore();
		const writers = dismissal("pull-7", "Writer");
		await store.add([writers]);
		const [lens] = reviewBatch("pull-7");
		await addHandedOver(store, [{ ...lens, supersedes: [recordId(writers)] }]);
		assert.deepEqual(await dismissed(store, "pull-7"), []);
		await assert.rejects(
			addHandedOverStrict(store, [{ ...lens, supersedes: [recordId(writers)] }], { changeset: "pull-7", revision }),
			/may not supersede/,
		);
	});

	test("own case 6d, a head job's batch that names another pull request's changeset passes the shape check", async () => {
		const store = await dirStore();
		await addHandedOver(store, [dismissal("pull-8", "Writer")]);
		assert.deepEqual(await dismissed(store, "pull-8"), ["Writer"]);
	});

	test("own case 6e, a head job's batch that supersedes the ledger's post record passes, and the next publish posts a second ledger", async () => {
		const store = await dirStore();
		const post = envelope("pull-7", "post", "ledger", { comment: 1001, login: "melian-user" });
		await store.add([post]);
		const [lens] = reviewBatch("pull-7");
		await addHandedOver(store, [{ ...lens, supersedes: [recordId(post)] }]);
		assert.equal(standing(await store.list("pull-7")).filter((record) => record.kind === "post").length, 0);
	});
});

// The key a repository with `trust.writers: false` pins, and the check rule 6 says the gate then applies.
function hostKey() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	const id = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return {
		id,
		sign: (record) => {
			const unsigned = { ...record, signer: id };
			return { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), privateKey).toString("base64") };
		},
		counts: (record) => {
			if (record.signer !== id || record.signature === undefined) return false;
			const { signature, ...unsigned } = record;
			return verify(null, Buffer.from(canonical(unsigned)), publicKey, Buffer.from(signature, "base64"));
		},
	};
}

describe("case 8: a store whose writers are not the repository's", () => {
	test("8a, with writer trust on, an outsider's dismissal in a bucket counts, and no record or port call can show it", async () => {
		const bucket = await dirStore();
		await bucket.add([dismissal("pull-7", "Outsider who can write the bucket")]);
		assert.deepEqual(await dismissed(bucket, "pull-7"), ["Outsider who can write the bucket"]);
		// The port has six methods, and none says who may write; the envelope's signer is absent with writer trust on.
		const port = ["add", "list", "readCell", "writeCell", "dispose", "close"];
		assert.deepEqual(
			Object.getOwnPropertyNames(DirectoryRecordStore.prototype)
				.filter((name) => name !== "constructor" && name !== "lockPath")
				.sort(),
			port.sort(),
		);
		const [record] = await bucket.list("pull-7");
		assert.equal(record.signer, undefined);
	});

	test("8b, with `trust.writers: false` and a pinned key, the gate counts only what the key signed", async () => {
		const bucket = await dirStore();
		const host = hostKey();
		await bucket.add([dismissal("pull-7", "Outsider")]);
		await bucket.add([host.sign(dismissal("pull-7", "maintainer, through the provider"))]);
		const counted = (await bucket.list("pull-7")).filter(host.counts);
		assert.deepEqual(
			counted.map((record) => record.payload.by),
			["maintainer, through the provider"],
		);
		const forged = { ...host.sign(dismissal("pull-7", "maintainer")), changeset: "pull-8" };
		assert.equal(host.counts(forged), false);
	});

	test("own case 8c, with `trust.writers: false`, an outsider's unsigned record still takes part in rule 4 unless the filter comes first", async () => {
		const bucket = await dirStore();
		const host = hostKey();
		const real = host.sign(envelope("pull-7", "post", "ledger", { comment: 1, login: "melian-user" }));
		await bucket.add([real]);
		const outsider = envelope(
			"pull-7",
			"post",
			"ledger",
			{ comment: 2, login: "melian-user" },
			{ supersedes: [recordId(real)] },
		);
		await bucket.add([outsider]);
		// Applied to every record, supersedes and the lowest ID let an unsigned record displace a signed one.
		assert.equal(standing(await bucket.list("pull-7")).find((record) => record.kind === "post").payload.comment, 2);
		assert.equal(
			standing((await bucket.list("pull-7")).filter(host.counts)).find((record) => record.kind === "post").payload
				.comment,
			1,
		);
	});
});

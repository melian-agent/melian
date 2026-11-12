// Spike for issue #371. Run with: node --test spikes/record-371/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { canonical, policyAt, recordId, refusal, signRecord, throwawayKey, vouched } from "./record.mjs";

const host = throwawayKey();
const writer = throwawayKey();
const outsider = throwawayKey();
const headOnly = throwawayKey();
let repo;
let base;
let head;
let strictBase;
let retiredBase;
const successor = throwawayKey();

const git = (...args) =>
	execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	}).trim();

function commit(policy, message) {
	writeFileSync(join(repo, "melian.yaml"), policy);
	git("add", "melian.yaml");
	git("-c", "user.name=spike", "-c", "user.email=spike@example.invalid", "commit", "-q", "-m", message);
	return git("rev-parse", "HEAD");
}

const signers = (...entries) =>
	`trust:\n  signers:\n${entries.map(([name, key, role]) => `    - { name: ${name}, key: ${key.key}, role: ${role} }\n`).join("")}`;

const unsigned = (payload = { name: "correctness", findings: 2 }) => ({
	changeset: "pull-0123456789abcdef",
	kind: "lens",
	key: "correctness@3@careful",
	payload,
});

// Writes each record to a directory of files and reads it back, as a store with no transport would.
function throughFiles(records) {
	const directory = join(repo, "..", `records-${Math.random().toString(16).slice(2)}`);
	mkdirSync(directory);
	for (const record of records)
		writeFileSync(join(directory, `${recordId(record)}.json`), JSON.stringify(record, null, 2));
	return readdirSync(directory).map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
}

before(() => {
	repo = join(mkdtempSync(join(tmpdir(), "spike-371-")), "repo");
	mkdirSync(repo);
	git("init", "-q", "-b", "main");
	base = commit(signers(["actions", host, "host"], ["maintainer", writer, "writer"]), "base");
	head = commit(
		signers(["actions", host, "host"], ["maintainer", writer, "writer"], ["intruder", headOnly, "host"]),
		"head",
	);
	strictBase = commit(
		`${signers(["actions", host, "host"], ["maintainer", writer, "writer"])}  writers: false\n`,
		"writers off",
	);
	retiredBase = commit(signers(["actions", host, "host"], ["successor", successor, "writer"]), "retire maintainer");
});

after(() => rmSync(join(repo, ".."), { recursive: true, force: true }));

describe("a record signed by a listed key", () => {
	it("verifies from the base commit's melian.yaml alone, after a round trip through files", () => {
		const [record] = throughFiles([signRecord(unsigned(), host)]);
		assert.equal(refusal(record, policyAt(repo, base)), undefined);
		const [written] = throughFiles([signRecord(unsigned(), writer)]);
		assert.equal(refusal(written, policyAt(repo, base)), undefined);
	});
});

describe("refusals", () => {
	const policy = () => policyAt(repo, base);

	it("refuses a changed payload", () => {
		const record = signRecord(unsigned(), host);
		assert.equal(
			refusal({ ...record, payload: { name: "correctness", findings: 0 } }, policy()),
			"the signature does not verify",
		);
	});

	for (const field of ["changeset", "kind", "key"])
		it(`refuses a changed ${field}`, () => {
			const record = signRecord(unsigned(), host);
			assert.equal(refusal({ ...record, [field]: `${record[field]}x` }, policy()), "the signature does not verify");
		});

	it("refuses a changed version", () => {
		const record = signRecord(unsigned(), host);
		assert.equal(refusal({ ...record, v: 2 }, policy()), "version 2");
	});

	for (const [name, spell] of [
		["without padding", (signature) => signature.replace(/=+$/, "")],
		["in the URL alphabet", (signature) => `${signature.slice(0, -2)}-_`.slice(0, signature.length)],
		["with whitespace inside", (signature) => `${signature.slice(0, 10)} ${signature.slice(10)}`],
	])
		it(`refuses a signature spelled ${name}, which would give the record another ID`, () => {
			const record = signRecord(unsigned(), host);
			const respelled = { ...record, signature: spell(record.signature) };
			assert.notEqual(respelled.signature, record.signature);
			assert.notEqual(recordId(respelled), recordId(record));
			assert.equal(refusal(respelled, policy()), "the signature is not 64 bytes in canonical base64");
		});

	it("refuses a field outside the six the signature covers, which would give the record another ID", () => {
		const record = { ...signRecord(unsigned(), host), note: "unsigned" };
		assert.equal(refusal(record, policy()), "the envelope holds note, which no signature covers");
	});

	it("refuses a record signed by an unlisted key", () => {
		const record = signRecord(unsigned(), outsider);
		assert.equal(refusal(record, policy()), `signer ${outsider.id} is not listed`);
	});

	it("refuses a record whose signer field names a listed key it was not signed with", () => {
		const record = { ...signRecord(unsigned(), outsider), signer: host.id };
		assert.equal(refusal(record, policy()), "the signature does not verify");
	});

	it("refuses a key the head's melian.yaml lists and the base's does not", () => {
		const record = signRecord(unsigned(), headOnly);
		assert.equal(refusal(record, policyAt(repo, head)), undefined);
		assert.equal(refusal(record, policyAt(repo, base)), `signer ${headOnly.id} is not listed`);
	});

	it("refuses a writer key's record when the policy says trust.writers: false, and keeps a host key's", () => {
		const strict = policyAt(repo, strictBase);
		assert.equal(
			refusal(signRecord(unsigned(), writer), strict),
			"signer maintainer is a writer, and trust.writers is false",
		);
		assert.equal(refusal(signRecord(unsigned(), host), strict), undefined);
	});
});

describe("canonical bytes", () => {
	it("give two serialisations of one payload, keys in different orders, the same bytes and the same record ID", () => {
		const first = JSON.parse(
			'{"name":"correctness","findings":[{"id":"a","at":{"line":3,"file":"x.ts"}}],"level":"careful"}',
		);
		const second = JSON.parse(
			'{"level":"careful","findings":[{"at":{"file":"x.ts","line":3},"id":"a"}],"name":"correctness"}',
		);
		assert.notEqual(JSON.stringify(first), JSON.stringify(second));
		assert.equal(canonical(first), canonical(second));
		const one = signRecord(unsigned(first), host);
		const two = signRecord(unsigned(second), host);
		assert.equal(one.signature, two.signature);
		assert.equal(recordId(one), recordId(two));
		assert.equal(refusal({ ...two, payload: first }, policyAt(repo, base)), undefined);
	});

	it("keep the order of an array, which is data", () => {
		assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }));
	});
});

describe("retiring a key", () => {
	const old = () => signRecord(unsigned(), writer);
	const closing = (signer, rests) =>
		signRecord({ changeset: "pull-0123456789abcdef", kind: "round", key: "round@1", payload: { rests } }, signer);
	const rest = (record) => ({ kind: record.kind, key: record.key, id: recordId(record) });

	it("refuses the retired key's own records under a base that no longer lists it", () => {
		assert.equal(refusal(old(), policyAt(repo, retiredBase)), `signer ${writer.id} is not listed`);
	});

	it("keeps a retired key's record that a listed key's closing record names by ID", () => {
		const record = old();
		assert.equal(vouched(record, closing(host, [rest(record)]), policyAt(repo, retiredBase)), true);
	});

	it("vouches for no record the closing record does not name, nor for one whose bytes changed", () => {
		const record = old();
		const other = signRecord(unsigned({ name: "tests", findings: 1 }), writer);
		const policy = policyAt(repo, retiredBase);
		assert.equal(vouched(other, closing(host, [rest(record)]), policy), false);
		assert.equal(
			vouched({ ...record, payload: { name: "correctness", findings: 0 } }, closing(host, [rest(record)]), policy),
			false,
		);
	});

	it("takes no vouching from a closing record the retired key signed itself", () => {
		const record = old();
		assert.equal(vouched(record, closing(writer, [rest(record)]), policyAt(repo, retiredBase)), false);
	});
});

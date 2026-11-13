// Spike for issue #378: attacks sections 3, 4 and 5 of the shared record decision with one test per case.
// Run from the checkout: node --experimental-strip-types --no-warnings --conditions=@melian-agent/source --test spikes/record-378/record.test.ts
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { DirectoryStore } from "./directory.ts";
import { canonical, codePoint, type Envelope, Key, recordId, refusal, signedBy } from "./envelope.ts";
import { context, dismissFirst, type Exported, exportRound, open, review, scratch, secondHead } from "./fixtures.ts";
import { type ClosingPayload, gate, literal, RecordSet, type Readings, type Status } from "./reader.ts";
import { roundVerdict } from "./round-verdict.ts";

type Outcome = { case: string; stated: string; got: string; result: "pass" | "finding" };
const outcomes: Outcome[] = [];
const note = (entry: Outcome) => outcomes.push(entry);

let repo: string;
let revision: string;
let changeset: string;
let passing: Exported;
let blocking: Exported;
let blockingHost2: Exported; // the same blocking round from a second host: the same bytes
let dismissal: Envelope;
let dismissedStored: string;
let reopenedRound: Exported;
let reopenedRevision: string;
let reopenedRecords: Envelope[];

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sightingOf = (exported: Exported) => exported.records.find((record) => record.kind === "sighting")!;

// A copy of `record` whose payload carries a nonce, ground until its ID sorts below `below` (or above, with `above`).
function ground(record: Envelope, below: string, direction: "below" | "above" = "below"): Envelope {
	for (let nonce = 0; ; nonce++) {
		const candidate = { ...record, payload: { ...(record.payload as object), nonce } } as Envelope;
		const id = recordId(candidate);
		if (direction === "below" ? id < below : id > below) return candidate;
	}
}

async function statusOf(
	records: Envelope[],
	closing: string,
	readings: Readings = literal,
	reopen = false,
): Promise<Status> {
	return (await roundVerdict(new RecordSet(records, readings), closing, repo, { reopen })).status;
}

async function gateOf(
	records: Envelope[],
	at: string,
	readings: Readings = literal,
): Promise<{ status: Status; rounds: number }> {
	const set = new RecordSet(records, readings);
	const rounds = set.rounds(at);
	const statuses: Status[] = [];
	for (const id of rounds) statuses.push((await roundVerdict(set, id, repo)).status);
	return { status: gate(statuses), rounds: rounds.length };
}

// Another round of `base`'s revision: a copy of its closing record with a nonce, other predecessors, or other fields.
function anotherRound(base: Exported, change: Partial<ClosingPayload> & Record<string, unknown>): Envelope {
	return { ...base.closingRecord, payload: { ...(base.closingRecord.payload as object), ...change } as never };
}

before(async () => {
	const pass = await open("pass");
	({ revision, changeset } = await review(pass, false));
	repo = pass.repo;
	passing = await exportRound(pass.harness, changeset, revision);
	const block = await open("block");
	const { at } = await review(block, true);
	blocking = await exportRound(block.harness, changeset, revision);
	const block2 = await open("block2");
	await review(block2, true);
	blockingHost2 = await exportRound(block2.harness, changeset, revision);
	const dismissed = await dismissFirst(block, at, revision, changeset, blocking.stored);
	dismissal = dismissed.record;
	dismissedStored = dismissed.stored.status;
	secondHead(block);
	const second = await review(block, true);
	reopenedRevision = second.revision;
	reopenedRound = await exportRound(block.harness, changeset, reopenedRevision, [blocking.closing]);
	reopenedRecords = [...blocking.records, dismissal, ...reopenedRound.records];
	for (const each of [pass, block, block2]) await each.harness.close(context);
});

after(() => {
	console.log("\nCASE | RESULT | GOT");
	for (const each of outcomes) console.log(`${each.case} | ${each.result} | ${each.got}`);
	rmSync(scratch, { recursive: true, force: true });
});

describe("baseline", () => {
	test("the decision-form records reproduce the stored verdicts", async () => {
		assert.equal(passing.stored.status, "passed");
		assert.equal(await statusOf(passing.records, passing.closing), "passed");
		assert.equal(await statusOf(blocking.records, blocking.closing), "blocking");
		assert.ok(
			same((await roundVerdict(new RecordSet(blocking.records), blocking.closing, repo)).verdict, blocking.stored),
		);
		assert.equal(blocking.closing, blockingHost2.closing, "two hosts that did the same work wrote the same bytes");
		assert.equal(dismissedStored, "passed");
		assert.equal(await statusOf([...blocking.records, dismissal], blocking.closing), "passed");
		assert.equal(reopenedRound.stored.status, "findings", "Pi reopens the dismissal at the second head");
		assert.equal(await statusOf(reopenedRecords, reopenedRound.closing, literal, true), "blocking");
	});
});

describe("case 1: a second writer's record under a key the decided round names", () => {
	test("1a: a sighting with other content, ground to a lower ID", async () => {
		const named = sightingOf(blocking);
		const rival = ground(
			{
				...named,
				payload: {
					...(named.payload as object),
					properties: { ...(named.payload as { properties: object }).properties, severity: "P3" },
				} as never,
			},
			recordId(named),
		);
		const records = [...blocking.records, rival];
		const set = new RecordSet(records);
		const status = await statusOf(records, blocking.closing);
		assert.equal(status, "blocking", "the round reads the record it names by ID");
		assert.equal(
			set.counts(recordId(named)),
			false,
			"yet by section 4's lowest-ID rule the named record no longer wins its slot",
		);
		note({
			case: "1a",
			stated: "A round's closing record names the kind, key and ID of every record it rests on.",
			got: "verdict unchanged (blocking) when the round reads by ID; but the named record loses its slot by the lowest-ID rule, and the decision does not say whether a round may rest on a record that lost",
			result: "finding",
		});
	});

	test("1b: a second dismissal under the same finding, ground to a lower ID, without supersedes", async () => {
		const rival = ground(
			{ ...dismissal, payload: { ...(dismissal.payload as object), reason: "Someone else's reason." } as never },
			recordId(dismissal),
		);
		const set = new RecordSet([...blocking.records, dismissal, rival]);
		const standing = set.dismissals();
		assert.equal(standing.length, 1);
		assert.equal(
			recordId(standing[0]!),
			recordId(rival),
			"the later writer's dismissal wins by hash, replacing the first without naming it",
		);
		const verdict = (await roundVerdict(set, blocking.closing, repo)).verdict;
		assert.equal(verdict.dismissed[0]?.properties.dismissal?.reason, "Someone else's reason.");
		note({
			case: "1b",
			stated:
				"Among records under one kind, key and revision that nothing supersedes, the lowest ID wins. Only two hosts that did the same work at once meet this rule.",
			got: "two writers' dismissals of one finding meet the rule too; the one with the lower hash wins, so a writer can grind a nonce to replace a dismissal without naming it",
			result: "finding",
		});
	});
});

describe("case 2: supersedes naming a blocking sighting, a dismissal, or a closing record", () => {
	const telemetry = (targets: string[]): Envelope => ({
		v: 1,
		changeset: blocking.closingRecord.changeset,
		kind: "telemetry",
		key: "anything",
		supersedes: targets,
		payload: { spendCents: 1 },
	});

	test("2a: a telemetry record supersedes the blocking sighting", async () => {
		const records = [...blocking.records, telemetry([recordId(sightingOf(blocking))])];
		const absent = await statusOf(records, blocking.closing, { ...literal, supersededRest: "absent" });
		const dropped = await statusOf(records, blocking.closing, { ...literal, supersededRest: "dropped" });
		const sameSlot = await statusOf(records, blocking.closing, { ...literal, sameSlot: true });
		assert.equal(absent, "not-reviewed");
		assert.equal(dropped, "passed", "read as 'no longer counts', the finding is gone and the round passes");
		assert.equal(sameSlot, "blocking");
		note({
			case: "2a",
			stated:
				"A superseded record no longer counts. ... A reader that cannot find one of them reads the round as not reviewed.",
			got: `not reviewed if a superseded rest is 'not found'; PASSED if it is dropped; blocking if supersedes must stay in the target's kind and key. The decision picks none, and lets any kind supersede any record`,
			result: "finding",
		});
	});

	test("2b: a telemetry record supersedes the dismissal", async () => {
		const records = [...blocking.records, dismissal, telemetry([recordId(dismissal)])];
		assert.equal(await statusOf(records, blocking.closing), "blocking", "the dismissal no longer counts");
		assert.equal(await statusOf(records, blocking.closing, { ...literal, sameSlot: true }), "passed");
		note({
			case: "2b",
			stated:
				"A second dismissal, a reopen, a lens rerun ... are replacements. (Section 7: A dismissal counts only from a writer.)",
			got: "any record of any kind undoes a dismissal; 'reopen' is a replacement but not one of section 2's kinds, and nothing says who may undo a dismissal",
			result: "finding",
		});
	});

	test("2c: a record supersedes the blocking round's closing record while a passing round of the revision stands", async () => {
		const both = [...blocking.records, ...passing.records];
		const notLowest = { ...literal, lowestAmongRounds: false };
		assert.equal((await gateOf(both, revision, notLowest)).status, "blocking", "the worse verdict gates");
		const superseded = [...both, telemetry([blocking.closing])];
		assert.equal((await gateOf(superseded, revision, notLowest)).status, "passed");
		const alone = [...blocking.records, telemetry([blocking.closing])];
		assert.equal(
			(await gateOf(alone, revision, notLowest)).status,
			"not-reviewed",
			"with no round left, the gate fails closed",
		);
		note({
			case: "2c",
			stated: "When two rounds of one revision both stand ... the gate takes the worse verdict.",
			got: "one record of any kind naming the blocking round's ID makes the gate pass on the other round; alone, the gate fails closed as stated",
			result: "finding",
		});
	});
});

describe("case 3: supersedes naming a record in another changeset, or none at all", () => {
	test("3a: a record in another changeset", async () => {
		const store = new DirectoryStore(join(scratch, "store-3a"));
		store.add(blocking.records);
		store.add([
			{
				v: 1,
				changeset: "other",
				kind: "telemetry",
				key: "x",
				supersedes: [recordId(sightingOf(blocking))],
				payload: 0,
			},
		]);
		const listed = store.list(blocking.closingRecord.changeset);
		assert.equal(await statusOf(listed, blocking.closing), "blocking");
		note({
			case: "3a",
			stated: "list(changeset) ... (no rule on supersedes across changesets)",
			got: "no effect, because list returns one changeset's records and the changeset is inside the ID; holds by construction",
			result: "pass",
		});
	});

	test("3b: a supersedes naming an ID no record has yet, written before the honest record", async () => {
		// The blocking round's records are deterministic, so their IDs are known before any host writes them.
		const future = recordId(sightingOf(blockingHost2));
		const tombstone: Envelope = {
			v: 1,
			changeset: blocking.closingRecord.changeset,
			kind: "telemetry",
			key: "early",
			supersedes: [future],
			payload: 0,
		};
		assert.equal(
			await statusOf([tombstone, ...passing.records], passing.closing),
			"passed",
			"inert while nothing has the ID",
		);
		const later = [tombstone, ...blockingHost2.records];
		assert.equal(await statusOf(later, blockingHost2.closing, { ...literal, supersededRest: "dropped" }), "passed");
		assert.equal(await statusOf(later, blockingHost2.closing), "not-reviewed");
		note({
			case: "3b",
			stated: "(silent on a supersedes that names no record)",
			got: "the entry is a standing tombstone: a later host's deterministic blocking sighting is superseded on arrival, so the round reads not reviewed, or passes if superseded rests are dropped",
			result: "finding",
		});
	});
});

describe("case 4: two replacements of one record, and two rounds of one revision", () => {
	test("4a: two records superseding the same record", async () => {
		const target = sightingOf(blocking);
		const a: Envelope = { ...target, supersedes: [recordId(target)], payload: { rerun: "a" } };
		const b: Envelope = { ...target, supersedes: [recordId(target)], payload: { rerun: "b" } };
		const forward = new RecordSet([target, a, b]);
		const backward = new RecordSet([b, a, target]);
		assert.deepEqual([...forward.standing.keys()], [...backward.standing.keys()]);
		assert.equal(forward.standing.size, 1);
		assert.equal([...forward.standing.keys()][0], [recordId(a), recordId(b)].sort()[0]);
		note({
			case: "4a",
			stated: "the lowest ID wins",
			got: "one survivor, the lower ID, in either order",
			result: "pass",
		});
	});

	test("4b: a passing and a blocking round of one revision, both under the closing record's key", async () => {
		const both = [...blocking.records, ...passing.records];
		const asWorded = await gateOf(both, revision, literal);
		const worse = await gateOf(both, revision, { ...literal, lowestAmongRounds: false });
		assert.equal(asWorded.rounds, 1, "the lowest-ID rule leaves one round standing");
		assert.equal(worse.status, "blocking");
		const lower = [blocking.closing, passing.closing].sort()[0] === passing.closing ? "passing" : "blocking";
		// A writer grinds a passing round below the blocking one.
		const groundPass = ground(passing.closingRecord, blocking.closing);
		const ground2 = await gateOf([...blocking.records, ...passing.records, groundPass], revision, literal);
		assert.equal(ground2.status, "passed");
		note({
			case: "4b",
			stated:
				"Among records under one kind, key and revision ... the lowest ID wins. ... When two rounds of one revision both stand ... the gate takes the worse verdict.",
			got: `the two rules contradict when rounds share a key: only one round stands (here the ${lower} one), and a writer who grinds a passing round's ID below the blocking one's makes the gate pass`,
			result: "finding",
		});
	});

	test("4c: a third round names only the passing round as its predecessor", async () => {
		const notLowest = { ...literal, lowestAmongRounds: false };
		const third = anotherRound(passing, { rounds: [passing.closing], nonce: 3 });
		const records = [...blocking.records, ...passing.records, third];
		const kept = await gateOf(records, revision, notLowest);
		const replaced = await gateOf(records, revision, { ...notLowest, predecessorReplaces: true });
		assert.equal(kept.status, "blocking");
		assert.equal(replaced.status, "blocking");
		// The same with a round that was not reviewed, and a rerun that names it.
		const broken = anotherRound(passing, {
			manifest: [...(passing.closingRecord.payload as { manifest: string[] }).manifest, "guardrails"],
		});
		const rerun = anotherRound(passing, { rounds: [recordId(broken)], nonce: 4 });
		const stuck = [...passing.records.slice(0, -1), broken, rerun];
		assert.equal(
			(await gateOf(stuck, revision, notLowest)).status,
			"not-reviewed",
			"a rerun never clears a round that was not reviewed",
		);
		assert.equal((await gateOf(stuck, revision, { ...notLowest, predecessorReplaces: true })).status, "passed");
		const laundered = anotherRound(passing, { rounds: [blocking.closing], nonce: 5 });
		assert.equal(
			(
				await gateOf([...blocking.records, ...passing.records, laundered], revision, {
					...notLowest,
					predecessorReplaces: true,
				})
			).status,
			"passed",
		);
		note({
			case: "4c",
			stated: "A round's closing record names ... the rounds before it.",
			got: "naming only the passing round leaves the blocking one standing, so the gate blocks either way. But the decision does not say what naming a predecessor does: if nothing, a not-reviewed round of a revision stands for ever and a rerun cannot clear it; if it replaces, any writer clears a block by naming it",
			result: "finding",
		});
	});
});

describe("case 5: a closing record that names a record under the wrong kind or key", () => {
	test("the store holds the named ID as a sighting; the round names it as a check", async () => {
		const sighting = recordId(sightingOf(blocking));
		const payload = blocking.closingRecord.payload as ClosingPayload;
		const wrong = anotherRound(blocking, {
			rests: payload.rests.map((rest) => (rest.id === sighting ? { ...rest, kind: "check", key: "tsc" } : rest)),
		});
		const records = [...blocking.records.slice(0, -1), wrong];
		assert.equal(
			await statusOf(records, recordId(wrong), { ...literal, match: "id" }),
			"blocking",
			"issue #373's reader matches by ID alone",
		);
		assert.equal(await statusOf(records, recordId(wrong), { ...literal, match: "kind-key-id" }), "not-reviewed");
		note({
			case: "5",
			stated:
				"A round's closing record names the kind, key and ID of every record it rests on ... A reader that cannot find one of them reads the round as not reviewed.",
			got: "by ID alone (issue #373's verdict.ts: byId.has(rest.id)) the round reads the record as its true kind and blocks; by kind, key and ID it is not reviewed. 'Cannot find' does not say which",
			result: "finding",
		});
	});
});

describe("case 6: the envelope's strictness", () => {
	const base = (): Record<string, unknown> => ({
		v: 1,
		changeset: "pull-1",
		kind: "check",
		key: "tsc",
		payload: { ok: true },
	});
	const key = Key.generate();

	test("6a: an extra field", () => {
		assert.match(refusal({ ...base(), note: "x" })!, /holds note/);
		note({ case: "6a", stated: "An envelope holds these fields and no other.", got: "refused", result: "pass" });
	});

	test("6b: a respelled signature", () => {
		const signed = key.sign(base() as Envelope);
		assert.equal(refusal(signed as never), undefined);
		const unpadded = { ...signed, signature: signed.signature!.replace(/=+$/, "") };
		const url = { ...signed, signature: signed.signature!.replace(/\+/g, "-").replace(/\//g, "_") };
		const spaced = { ...signed, signature: `${signed.signature} ` };
		for (const each of [unpadded, spaced]) assert.match(refusal(each as never)!, /canonical base64/);
		if (url.signature !== signed.signature) assert.match(refusal(url as never)!, /canonical base64/);
		note({
			case: "6b",
			stated: "A signature is 64 bytes in canonical base64.",
			got: "unpadded, URL-safe and padded-with-space forms refused",
			result: "pass",
		});
	});

	test("6c: an integer past the safe range, and a fraction", () => {
		assert.match(refusal({ ...base(), payload: { n: 2 ** 53 } })!, /safe range/);
		assert.equal(refusal({ ...base(), payload: { n: 2 ** 53 - 1 } }), undefined, "at the bound");
		assert.equal(refusal({ ...base(), payload: { spend: 6.4 } }), undefined, "a fraction passes the stated rules");
		assert.notEqual(refusal({ ...base(), payload: { spend: 6.4 } }, true), undefined);
		// Two writers' canonical text of one number differs once fractions are allowed: JavaScript and Python disagree.
		assert.equal(canonical(5e-7), "5e-7"); // Python's json.dumps gives 5e-07
		note({
			case: "6c",
			stated: "integers within the safe range",
			got: "2^53 refused, 2^53-1 kept. A fraction is neither allowed nor refused, though section 5 puts a lens run's spend in its payload, and JavaScript and Python print 5e-7 differently, so a fraction has no single canonical text",
			result: "finding",
		});
	});

	test("6d: a changeset or kind of dots passes the alphabet and leaves the adapter's directory", () => {
		for (const value of ["..", ".", "...", "a..b"]) assert.equal(refusal({ ...base(), kind: value }), undefined);
		assert.match(refusal({ ...base(), kind: "Check" })!, /alphabet/);
		assert.match(refusal({ ...base(), kind: "a/b" })!, /alphabet/);
		assert.match(refusal({ ...base(), kind: "" })!, /alphabet/);
		const root = join(scratch, "store-6d");
		const store = new DirectoryStore(root);
		const [path] = store.add([{ ...(base() as Envelope), changeset: "..", kind: ".." }]);
		assert.ok(!path!.startsWith(join(root, "changesets")), `written at ${path}, outside the changesets directory`);
		assert.ok(!path!.startsWith(`${root}/`), `outside the store's own root: ${path}`);
		assert.ok(existsSync(path!));
		assert.notEqual(refusal({ ...base(), kind: ".." }, true), undefined);
		note({
			case: "6d",
			stated:
				"`changeset` and `kind` use lower-case letters, digits, dots and hyphens, since an adapter may make them path components.",
			got: "'..' passes the alphabet; the directory adapter laid out as section 12 says wrote a record outside its root. The alphabet's own reason is defeated",
			result: "finding",
		});
	});

	test("6e: a revision that is not a Revision.key", () => {
		assert.equal(refusal({ ...base(), revision: "not a key at all" }), undefined, "the stated rules check nothing");
		assert.equal(refusal({ ...base(), revision: "main..feature" }, true)?.includes("object IDs"), true);
		assert.notEqual(refusal({ ...base(), revision: "main..feature" }, true), undefined);
		note({
			case: "6e",
			stated: "revision?: string; // Revision.key, for a fact about one base and head",
			got: "accepted: the rule is a code comment, and Revision.parseKey itself accepts 'main..feature' and upper-case IDs, so one revision has several spellings, each its own lowest-ID slot",
			result: "finding",
		});
	});

	test("6f: an empty or reordered supersedes, and a signer with no signature", () => {
		const plain = base() as Envelope;
		const empty = { ...plain, supersedes: [] };
		assert.equal(refusal(empty as never), undefined);
		assert.notEqual(recordId(plain), recordId(empty as Envelope), "one fact, two IDs");
		const ab = { ...plain, supersedes: ["a".repeat(64), "b".repeat(64)] };
		const ba = { ...plain, supersedes: ["b".repeat(64), "a".repeat(64)] };
		assert.notEqual(recordId(ab as Envelope), recordId(ba as Envelope));
		assert.equal(refusal({ ...plain, signer: "deadbeef" } as never), undefined);
		assert.notEqual(refusal(empty as never, true), undefined);
		note({
			case: "6f",
			stated: "Without both rules one signed fact takes any number of IDs.",
			got: "supersedes absent, [], reordered or repeated gives one fact several IDs; a supersedes entry need not be a record ID; a signer without a signature is accepted",
			result: "finding",
		});
	});

	test("6g: the sort order of object keys is unnamed", () => {
		const payload = { "￿": 1, "\u{1f600}": 2 };
		const record = { ...(base() as Envelope), payload };
		assert.notEqual(
			recordId(record),
			recordId(record, codePoint),
			"JavaScript's order and a byte order give two IDs",
		);
		note({
			case: "6g",
			stated: "UTF-8 JSON, object keys sorted, no whitespace, text as given",
			got: "'sorted' by UTF-16 code unit (JavaScript) and by UTF-8 byte (Go, Rust) disagree for a key past U+FFFF, so two adapters give one record two IDs; string escaping is unnamed too",
			result: "finding",
		});
	});
});

describe("case 7: keys that say what ran", () => {
	const lensRun = (route: string, model: string): Envelope => ({
		v: 1,
		changeset: "pull-1",
		revision: revision,
		kind: "lens",
		key: `correctness@18@careful thinking=high instructions=abc band=P2 escalate=P1 on ${route}`,
		payload: { model, attempt: 1, spendCents: 12 },
	});

	test("7a: two lens runs that differ only in route", () => {
		const set = new RecordSet([
			lensRun("openai-codex/gpt-6.1", "gpt-6.1"),
			lensRun("anthropic/opus-5.5", "opus-5.5"),
		]);
		assert.equal(set.standing.size, 2);
		note({
			case: "7a",
			stated: "A lens run's key is its whole selection line ... and route.",
			got: "kept apart",
			result: "pass",
		});
	});

	test("7b: two lens runs on one route, one finished on a fallback model", () => {
		const set = new RecordSet([
			lensRun("openai-codex/gpt-6.1", "gpt-6.1"),
			lensRun("openai-codex/gpt-6.1", "claude-fallback"),
		]);
		assert.equal(set.standing.size, 1, "one is dropped by hash, though they did different work");
		note({
			case: "7b",
			stated:
				"Its payload carries the model it finished on ... Only two hosts that did the same work at once meet this rule.",
			got: "a run that fell back and one that did not share a slot; the lowest ID keeps one by hash. The same holds for a check run under another tool version",
			result: "finding",
		});
	});

	test("7c: two verifications whose candidates share one claim", () => {
		const verification = (claims: string[], verdict: string): Envelope => ({
			v: 1,
			changeset: "pull-1",
			revision,
			kind: "verification",
			key: `${claims.join(",")} verifier@4190289e`,
			payload: { verdict },
		});
		assert.equal(
			new RecordSet([verification(["a", "b"], "confirmed"), verification(["a", "c"], "refuted")]).standing.size,
			2,
		);
		assert.equal(
			new RecordSet([verification(["a", "b"], "confirmed"), verification(["b", "a"], "refuted")]).standing.size,
			2,
			"one candidate, two keys",
		);
		note({
			case: "7c",
			stated: "A verification's key is its candidate's claim IDs and the verifier's version.",
			got: "{a,b} and {a,c} kept apart; but {a,b} and {b,a} are two keys for one candidate, since the decision does not say the claim IDs are sorted, and nothing says which verification claim a reads when two that include it stand",
			result: "finding",
		});
	});
});

describe("case 8: a dismissal without the frozen sighting or the accepted trigger", () => {
	test("8a: no trigger, at a head that changed the trigger", async () => {
		const { trigger: _, ...rest } = dismissal.payload as Record<string, unknown>;
		const bare = { ...dismissal, payload: rest } as Envelope;
		const records = [...blocking.records, bare, ...reopenedRound.records];
		const status = await statusOf(records, reopenedRound.closing, literal, true);
		assert.equal(reopenedRound.stored.status, "findings", "Pi reopens it");
		assert.equal(status, "passed", "the record's dismissal stands for ever");
		note({
			case: "8a",
			stated:
				"A dismissal's payload holds ... the frozen sighting, and the accepted trigger and proof. A reader decides at each revision whether the dismissal still stands, by the lifecycle's reopen rule.",
			got: "the reader passes the finding: with no trigger the reopen rule has nothing to compare, while Pi's own lifecycle reopened it. The decision does not say a dismissal without them is refused",
			result: "finding",
		});
	});

	test("8b: an empty dismissal payload", async () => {
		const empty = { ...dismissal, payload: {} } as Envelope;
		assert.equal(await statusOf([...blocking.records, empty], blocking.closing, literal, true), "passed");
		note({
			case: "8b",
			stated: "(as 8a)",
			got: "a dismissal of {} dismisses a blocking finding, with no dismisser, reason or time",
			result: "finding",
		});
	});
});

describe("own cases", () => {
	test("9: a supersession of a supersession", async () => {
		const target = sightingOf(blocking);
		const rerun: Envelope = { ...target, supersedes: [recordId(target)], payload: { rerun: 1 } as never };
		const revert: Envelope = { ...target, supersedes: [recordId(rerun)], payload: { revert: 1 } as never };
		const records = [...blocking.records, rerun, revert];
		const any = await statusOf(records, blocking.closing, { ...literal, supersededBy: "any" });
		const counting = await statusOf(records, blocking.closing, { ...literal, supersededBy: "counting" });
		assert.equal(any, "not-reviewed");
		assert.equal(counting, "blocking");
		note({
			case: "9",
			stated: "A superseded record no longer counts.",
			got: "when C supersedes B and B superseded A, A is dead if any record's supersedes applies, and back if only a counting record's does; the round reads not reviewed under one and blocks under the other",
			result: "finding",
		});
	});

	test("10: the CI relay checks shape only, so a head's job can hand it a dismissal", async () => {
		// Section 6: "the job that runs a head's code hands its records to a job that runs none, which checks their shape".
		const relay = (records: Envelope[]) => records.filter((record) => refusal(record as never) === undefined);
		const fromHead = relay([...blocking.records, { ...dismissal, payload: { by: "head", reason: "x", at: "now" } }]);
		assert.equal(await statusOf(fromHead, blocking.closing, literal, true), "passed");
		note({
			case: "10",
			stated: "A head that tampers with its runner can still alter them, as it can alter the verdict today.",
			got: "a shape check passes a dismissal, a supersedes of another round, or a post from the head's job; today a tampered runner alters its own verdict, here it also reaches dismissals and other rounds' records",
			result: "finding",
		});
	});

	test("11: which bytes the signature covers is unnamed (trust.writers: false)", () => {
		const host = Key.generate();
		const signed = host.sign({ v: 1, changeset: "pull-1", kind: "telemetry", key: "t", payload: 0 }, "spike-371");
		const forged = { ...signed, supersedes: [recordId(dismissal)] };
		assert.equal(
			signedBy(forged, host, "spike-371"),
			true,
			"issue #371's coverage still verifies the forged supersedes",
		);
		assert.notEqual(recordId(forged), recordId(signed));
		const whole = host.sign({ v: 1, changeset: "pull-1", kind: "telemetry", key: "t", payload: 0 });
		assert.equal(signedBy({ ...whole, supersedes: [recordId(dismissal)] }, host), false);
		note({
			case: "11",
			stated: "the gate then counts only records that key signed.",
			got: "the decision does not say what the signature covers; issue #371's six-field coverage, which predates revision and supersedes, lets anyone add a supersedes to the host's signed record and keep a valid signature",
			result: "finding",
		});
	});

	test("12: a dismissal with a revision and one without both stand, and order decides", async () => {
		const scoped = {
			...dismissal,
			revision,
			payload: { ...(dismissal.payload as object), reason: "Scoped." },
		} as Envelope;
		const a = (await roundVerdict(new RecordSet([...blocking.records, dismissal, scoped]), blocking.closing, repo))
			.verdict;
		const b = (await roundVerdict(new RecordSet([...blocking.records, scoped, dismissal]), blocking.closing, repo))
			.verdict;
		assert.notEqual(a.dismissed[0]?.properties.dismissal?.reason, b.dismissed[0]?.properties.dismissal?.reason);
		note({
			case: "12",
			stated: "(silent on a dismissal's key and revision)",
			got: "a revision-scoped and an unscoped dismissal of one finding sit in two slots, so both stand and the reader's arrival order picks the reason shown",
			result: "finding",
		});
	});

	test("13: 'the worse verdict' has no stated order", () => {
		assert.equal(gate(["blocking", "not-reviewed"]), "not-reviewed");
		note({
			case: "13",
			stated: "the gate takes the worse verdict",
			got: "both fail closed, so the gate's answer holds; but which status and message it reports between blocking and not reviewed is unnamed",
			result: "finding",
		});
	});
});

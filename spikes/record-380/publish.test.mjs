// Cases 1, 2, 3, 4 (the late post), 5 and two of our own, on rule 10's marker and rule 11's lease and owner.
// Run: node --experimental-strip-types --no-warnings --test spikes/record-380/publish.test.mjs
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Octokit } from "@octokit/rest";
import { fakeGitHub, fakeState } from "../../packages/github/test/fixtures/fake-github.ts";
import { Crash, envelope, OwnerRefusal, Publisher, standing } from "./rules.mjs";
import { DirectoryRecordStore, recordId, sha256 } from "./stores.mjs";

const pull = (number) => ({ number, title: "spike", base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "f", sha: "b".repeat(40) } });

async function world({ number = 7, login = "melian-user", failUser = false } = {}) {
	const store = await DirectoryRecordStore.open({ root: await mkdtemp(join(tmpdir(), "spike-380-dir-")) });
	const state = fakeState("melian-agent", "melian", pull(number), {});
	state.login = login;
	state.failUser = failUser;
	const octokit = new Octokit({ auth: "throwaway", request: { fetch: fakeGitHub(state) } });
	const publisher = (options = {}) =>
		new Publisher({ store, changeset: `pull-${number}`, octokit, owner: "melian-agent", repo: "melian", number, holder: "host-a", ...options });
	// Another commenter's comment, as GitHub would list it: in creation order.
	const comment = (user, body) => {
		const each = { id: state.nextId++, user: { login: user }, body, html_url: "" };
		state.ledgers.push(each);
		return each;
	};
	return { store, state, octokit, publisher, comment };
}

const crashAfterPost = { afterPost: () => { throw new Crash("after post"); } };
const ledgerComments = (state) => state.ledgers.filter((each) => each.body.includes("<!-- melian:marker="));

describe("case 1: a copied marker value before the post record lands", () => {
	test("1a, known login: a later comment carrying the value is not taken", async () => {
		const w = await world();
		await assert.rejects(w.publisher({ crash: crashAfterPost }).publish("ledger v1"), Crash);
		const ours = w.state.ledgers[0];
		w.comment("mallory", ours.body);
		const resumed = await w.publisher().publish("ledger v1");
		assert.deepEqual(resumed, { status: "adopted", comment: ours.id });
	});

	test("1b, known login: an older comment edited to carry the value is not taken", async () => {
		const w = await world();
		const older = w.comment("mallory", "an innocent comment");
		await assert.rejects(w.publisher({ crash: crashAfterPost }).publish("ledger v1"), Crash);
		older.body = w.state.ledgers[1].body;
		const resumed = await w.publisher().publish("ledger v1");
		assert.equal(resumed.comment, w.state.ledgers[1].id);
	});

	test("1c, login unknown (an installation token, /user refused): the edited older comment is taken as Melian's", async () => {
		const w = await world({ failUser: true });
		const older = w.comment("mallory", "an innocent comment");
		await assert.rejects(w.publisher({ crash: crashAfterPost }).publish("ledger v1"), Crash);
		older.body = w.state.ledgers[1].body;
		const resumed = await w.publisher().publish("ledger v1");
		// FINDING: the resumed publication records mallory's comment as the ledger, and from then on its ID is the authority.
		assert.deepEqual(resumed, { status: "adopted", comment: older.id });
		const post = standing(await w.store.list("pull-7")).find((record) => record.kind === "post");
		assert.deepEqual(post.payload, { comment: older.id, login: "mallory" });
	});
});

describe("case 2: a crash on either side of the post", () => {
	test("2a, after the hash and before the post: the resume posts once, under a fresh value", async () => {
		const w = await world();
		let first;
		await assert.rejects(
			w.publisher({ crash: { afterHash: (value) => { first = value; throw new Crash("after hash"); } } }).publish("ledger"),
			Crash,
		);
		assert.equal(w.state.ledgers.length, 0);
		const resumed = await w.publisher().publish("ledger");
		assert.equal(resumed.status, "posted");
		assert.notEqual(resumed.value, first);
		assert.equal(ledgerComments(w.state).length, 1);
		const markers = (await w.store.list("pull-7")).filter((record) => record.kind === "marker");
		assert.equal(markers.length, 2, "the unused hash stays in the store");
	});

	test("2b, after the post and before the post record: the resume takes the comment and posts nothing", async () => {
		const w = await world();
		await assert.rejects(w.publisher({ crash: crashAfterPost }).publish("ledger"), Crash);
		const resumed = await w.publisher().publish("ledger");
		assert.equal(resumed.status, "adopted");
		assert.equal(ledgerComments(w.state).length, 1);
		assert.equal((await w.publisher().publish("ledger 2")).status, "edited");
	});

	test("own case 2c: under rule 4's lowest-ID reading of marker records, the posted hash can lose to the unused one", async () => {
		// Rule 10 says a marker counts when the store "holds" its hash. Rule 4 says that under one kind and key only the
		// lowest ID counts. Read together, a crash before a post, then a crash after the next post, leaves the posted
		// comment's hash out of the standing set whenever the unused record has the lower ID.
		for (;;) {
			const w = await world();
			await assert.rejects(w.publisher({ crash: { afterHash: () => { throw new Crash(); } } }).publish("ledger"), Crash);
			await assert.rejects(w.publisher({ crash: crashAfterPost }).publish("ledger"), Crash);
			const markers = (await w.store.list("pull-7")).filter((record) => record.kind === "marker");
			const posted = sha256(ledgerComments(w.state)[0].body.split("=")[1].split(" ")[0]);
			const winner = standing(markers)[0];
			if (winner.payload.hash === posted) continue;
			// FINDING (reading): a resume that applies rule 4 to markers would post a second ledger here.
			assert.notEqual(winner.payload.hash, posted);
			return;
		}
	});
});

describe("case 3: a marker whose hash is recorded under another pull request's changeset", () => {
	test("3a, login unknown: a comment on #8 carrying #7's value is not taken, because #8's records hold no such hash", async () => {
		const seven = await world({ number: 7, failUser: true });
		const posted = await seven.publisher().publish("ledger of #7");
		const eight = await world({ number: 8, failUser: true });
		const shared = new Publisher({ ...eight.publisher(), store: seven.store, changeset: "pull-8" });
		eight.comment("mallory", `<!-- melian:marker=${posted.value} -->\ncopied`);
		const result = await shared.publish("ledger of #8");
		assert.equal(result.status, "posted");
	});

	test("own case 3b: the marker record names no pull request, so a writer's record under #8 makes #7's value count there", async () => {
		const seven = await world({ number: 7, failUser: true });
		const posted = await seven.publisher().publish("ledger of #7");
		await seven.store.add([envelope("pull-8", "marker", "ledger", { hash: sha256(posted.value) })]);
		const eight = await world({ number: 8, failUser: true });
		const shared = new Publisher({ ...eight.publisher(), store: seven.store, changeset: "pull-8" });
		const copy = eight.comment("mallory", `<!-- melian:marker=${posted.value} -->\ncopied`);
		assert.deepEqual(await shared.publish("ledger of #8"), { status: "adopted", comment: copy.id });
	});
});

describe("case 4: the holder dies", () => {
	test("4a, the lease frees only at its expiry, and the dead holder's late release cannot land", async () => {
		const w = await world();
		let clock = 1_000_000;
		const now = () => clock;
		const a = w.publisher({ holder: "host-a", now, leaseMs: 60_000 });
		assert.ok((await a.take()).lease);
		const b = w.publisher({ holder: "host-b", now, leaseMs: 60_000 });
		assert.deepEqual(await b.take(), { held: "host-a" });
		clock += 60_001;
		assert.ok((await b.take()).lease);
		assert.equal(await a.release(), false);
	});

	test("4b, a holder paused past its lease posts after its successor: two ledgers", async () => {
		const w = await world();
		let clock = 1_000_000;
		const now = () => clock;
		let wake;
		const paused = new Promise((resolve) => { wake = resolve; });
		let parked;
		const parkedAtHash = new Promise((resolve) => { parked = resolve; });
		const a = w.publisher({ holder: "host-a", now, crash: { afterHash: async () => { parked(); await paused; } } });
		const first = a.publish("ledger by a");
		await parkedAtHash;
		clock += 60_001;
		const second = await w.publisher({ holder: "host-b", now }).publish("ledger by b");
		assert.equal(second.status, "posted");
		wake();
		const late = await first;
		// FINDING: no fence stops the late post, and nothing in the store fences the late `post` record either.
		assert.equal(late.status, "posted");
		assert.equal(ledgerComments(w.state).length, 2);
		const posts = (await w.store.list("pull-7")).filter((record) => record.kind === "post");
		assert.equal(posts.length, 2);
		assert.equal(standing(posts).length, 1, "rule 4 keeps one; the other comment is an orphan");
	});
});

describe("case 5: a second login", () => {
	test("5a, a publish under another login refuses, naming the owner", async () => {
		const w = await world({ login: "alice" });
		await w.publisher().publish("ledger");
		w.state.login = "bob";
		await assert.rejects(w.publisher().publish("ledger"), (error) => error instanceof OwnerRefusal && error.owner === "alice");
	});

	test("5b, a second login whose /user read is refused cannot be told from the owner, and edits as itself", async () => {
		const w = await world({ login: "alice" });
		await w.publisher().publish("ledger");
		w.state.login = "app[bot]";
		w.state.failUser = true;
		// FINDING: no refusal. Real GitHub would then refuse the edit as another user's comment, a 403, not the owner.
		assert.equal((await w.publisher().publish("ledger")).status, "edited");
	});

	test("own case 5c: two first publishes under two logins leave the owner to rule 4's lowest ID", async () => {
		const w = await world({ login: "alice" });
		await w.store.add([envelope("pull-7", "post", "ledger", { comment: 1, login: "alice" })]);
		await w.store.add([envelope("pull-7", "post", "ledger", { comment: 2, login: "bob" })]);
		const owner = standing(await w.store.list("pull-7")).find((record) => record.kind === "post").payload.login;
		const lower = [envelope("pull-7", "post", "ledger", { comment: 1, login: "alice" }), envelope("pull-7", "post", "ledger", { comment: 2, login: "bob" })]
			.sort((x, y) => (recordId(x) < recordId(y) ? -1 : 1))[0].payload.login;
		assert.equal(owner, lower);
	});
});

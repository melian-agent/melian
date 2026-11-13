// The decision's rules 4, 6, 10 and 11, implemented as it words them, for issue #380's tests. Scripts, not product code.
// Each choice the wording leaves open is marked "reading:", and the report lists them.
import { randomBytes } from "node:crypto";
import { checkEnvelope, recordId, sha256 } from "./stores.mjs";

// Rule 4: a superseded record no longer counts; among the rest under one kind, key and revision, the lowest ID wins.
export function standing(records) {
	const superseded = new Set(records.flatMap((record) => record.supersedes ?? []));
	const winners = new Map();
	for (const record of records) {
		const id = recordId(record);
		if (superseded.has(id)) continue;
		const slot = `${record.kind}\0${record.key}\0${record.revision ?? ""}`;
		const held = winners.get(slot);
		if (held === undefined || id < held.id) winners.set(slot, { id, record });
	}
	return [...winners.values()].map(({ record }) => record);
}

export const envelope = (changeset, kind, key, payload, extra = {}) => ({
	v: 1,
	changeset,
	kind,
	key,
	payload,
	...extra,
});

// Rule 6: "the job that runs a head's code hands its records to a job that runs none, which checks their shape and adds
// them." Reading: the shape is rule 3's envelope shape, which is all the decision names.
export async function addHandedOver(store, batch) {
	for (const record of batch) checkEnvelope(record);
	await store.add(batch);
}

// The stricter adding job case 6 proposes: a review job's batch names its own changeset and revision, holds only kinds
// a review writes, and supersedes only records of those kinds.
const REVIEW_KINDS = new Set(["check", "lens", "verification", "round", "inheritance", "walkthrough", "telemetry"]);
export async function addHandedOverStrict(store, batch, { changeset, revision }) {
	const existing = new Map((await store.list(changeset)).map((record) => [recordId(record), record]));
	const own = new Map(batch.map((record) => [recordId(record), record]));
	for (const record of batch) {
		checkEnvelope(record);
		if (record.changeset !== changeset) throw new Error(`a review job wrote into changeset ${record.changeset}`);
		if (record.revision !== undefined && record.revision !== revision)
			throw new Error("a review job wrote another revision");
		if (!REVIEW_KINDS.has(record.kind)) throw new Error(`a review job may not add a ${record.kind} record`);
		for (const id of record.supersedes ?? []) {
			const target = existing.get(id) ?? own.get(id);
			if (target === undefined || !REVIEW_KINDS.has(target.kind))
				throw new Error(`a review job may not supersede ${id}`);
		}
	}
	await store.add(batch);
}

export class Crash extends Error {}
export class OwnerRefusal extends Error {
	constructor(owner) {
		super(`this pull request's reviews and ledger belong to ${owner}; publish as ${owner}`);
		this.owner = owner;
	}
}

const MARKER = /^<!-- melian:marker=([0-9a-f]{64}) -->$/m;
export const markerIn = (body) => MARKER.exec(body ?? "")?.[1];

// Rules 10 and 11 for the ledger comment: a short lease in the cell, a marker hash recorded before the post, the post,
// a `post` record naming the comment's ID, and the release.
export class Publisher {
	constructor({
		store,
		changeset,
		octokit,
		owner,
		repo,
		number,
		holder,
		leaseMs = 60_000,
		now = () => Date.now(),
		crash = {},
	}) {
		Object.assign(this, { store, changeset, octokit, owner, repo, number, holder, leaseMs, now, crash });
		this.events = [];
	}

	async login() {
		try {
			return (await this.octokit.rest.users.getAuthenticated()).data.login;
		} catch {
			return undefined;
		}
	}

	async take() {
		const { value, version } = await this.store.readCell(this.changeset);
		const held = value === undefined ? undefined : JSON.parse(value);
		if (held !== undefined && held.holder !== this.holder && held.expiresAt > this.now())
			return { held: held.holder };
		const lease = { holder: this.holder, expiresAt: this.now() + this.leaseMs };
		if (!(await this.store.writeCell(this.changeset, version, JSON.stringify(lease)))) return { lost: true };
		return { lease };
	}

	async release() {
		const { value, version } = await this.store.readCell(this.changeset);
		if (value === undefined || JSON.parse(value).holder !== this.holder) return false;
		return this.store.writeCell(
			this.changeset,
			version,
			JSON.stringify({ holder: this.holder, expiresAt: this.now() }),
		);
	}

	async publish(text) {
		const taken = await this.take();
		if (!taken.lease) return { status: taken.held ? "held" : "lost", by: taken.held };
		const records = await this.store.list(this.changeset);
		const me = await this.login();
		// Reading: the owner is the login on the standing `post` record, since "first" needs an order the store lacks.
		const post = standing(records).find((record) => record.kind === "post" && record.key === "ledger");
		if (post !== undefined && me !== undefined && post.payload.login !== me)
			throw new OwnerRefusal(post.payload.login);
		const repo = { owner: this.owner, repo: this.repo };
		if (post !== undefined) {
			await this.octokit.rest.issues.updateComment({ ...repo, comment_id: post.payload.comment, body: text });
			await this.release();
			return { status: "edited", comment: post.payload.comment };
		}
		// A marker counts when the store holds its hash for this pull request. Reading: any marker record of the
		// changeset holds a hash, whatever it is for; the author filters when the login is known.
		const hashes = new Set(records.filter((record) => record.kind === "marker").map((record) => record.payload.hash));
		const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
			...repo,
			issue_number: this.number,
			per_page: 100,
		});
		for (const comment of comments) {
			const value = markerIn(comment.body);
			if (value === undefined || !hashes.has(sha256(value))) continue;
			if (me !== undefined && comment.user?.login !== me) continue;
			await this.store.add([
				envelope(this.changeset, "post", "ledger", { comment: comment.id, login: comment.user?.login }),
			]);
			this.events.push({ adopted: comment.id });
			await this.release();
			return { status: "adopted", comment: comment.id };
		}
		const value = randomBytes(32).toString("hex");
		await this.store.add([envelope(this.changeset, "marker", "ledger", { hash: sha256(value) })]);
		await this.crash.afterHash?.(value);
		const posted = await this.octokit.rest.issues.createComment({
			...repo,
			issue_number: this.number,
			body: `<!-- melian:marker=${value} -->\n${text}`,
		});
		await this.crash.afterPost?.(posted.data);
		await this.store.add([
			envelope(this.changeset, "post", "ledger", { comment: posted.data.id, login: posted.data.user.login }),
		]);
		await this.release();
		return { status: "posted", comment: posted.data.id, value };
	}
}

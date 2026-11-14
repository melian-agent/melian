import { createHash } from "node:crypto";
import { RecordError } from "./errors.ts";

/** A JSON value as a record holds it: every number a safe integer. */
export type RecordJson = null | boolean | number | string | RecordJson[] | { [key: string]: RecordJson };

/**
 * One fact in the shared record, as [the shared record decision](../../../docs/decisions/2026-11-13-shared-record-behind-a-store-port.md)
 * rule 3 sets it out. It holds these fields and no other.
 */
export type RecordEnvelope = {
	v: 1;
	changeset: string;
	revision?: string;
	kind: string;
	key: string;
	supersedes?: string[];
	payload: RecordJson;
	signer?: string;
	signature?: string;
};

/**
 * Checks one kind's payload, and returns why it refuses it, or `undefined` to take it. Core checks a round's payload
 * itself. Every other kind's check comes from the build that defines that payload, and a kind with none is refused.
 */
export type PayloadCheck = (payload: RecordJson) => string | undefined;

/** The payload check for each kind a caller can read. */
export type PayloadChecks = { readonly [kind: string]: PayloadCheck };

/** A record a round names as one it read: its kind, key and ID together. */
export type NamedRecord = { kind: string; key: string; id: string };

/**
 * A round's manifest, by rule 4: every record it read, its walkthrough or `null` for none, the earlier rounds of its
 * revision it replaces, and the rounds of the revision before.
 */
export type RoundManifest = {
	read: NamedRecord[];
	walkthrough: { key: string; id: string } | null;
	replaces: string[];
	before: string[];
};

const kinds = new Set(["check", "lens", "verification", "walkthrough", "round", "telemetry", "marker"]);
// Rule 4: only what a command writes into a slot of its own may supersede.
const supersedingKinds = new Set(["dismissal", "post", "status", "ledger-comment", "comparison"]);
const fields = new Set(["v", "changeset", "revision", "kind", "key", "supersedes", "payload", "signer", "signature"]);
const dotted = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const revisionPattern = /^(?:[0-9a-f]{40}\.\.[0-9a-f]{40}|[0-9a-f]{64}\.\.[0-9a-f]{64})$/;
const recordId = /^[0-9a-f]{64}$/;
const signatureBytes = 64;

function invalid(message: string): RecordError {
	return new RecordError("invalidRecord", message);
}

function plain(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * The canonical bytes of `value`, by RFC 8785 (JCS), for a value whose every number is a safe integer: object keys
 * sorted by UTF-16 code units, no whitespace, and strings as `JSON.stringify` writes them. It throws a
 * {@link RecordError} for anything JCS cannot write one way: a number that is not a safe integer, a lone surrogate,
 * `undefined` anywhere, a hole, or an object that is not a plain one.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw invalid(`a record's numbers are safe integers, not ${value}`);
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		if (!value.isWellFormed()) throw invalid("a record's strings hold no lone surrogate");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		const items: string[] = [];
		// A hole reads as undefined, which no record holds.
		for (let index = 0; index < value.length; index++) items.push(canonicalJson(value[index]));
		return `[${items.join(",")}]`;
	}
	if (typeof value === "object" && plain(value)) {
		const entries = Object.entries(value);
		entries.sort(([a], [b]) => (a < b ? -1 : 1));
		return `{${entries
			.map(([key, field]) => {
				if (!key.isWellFormed()) throw invalid("a record's keys hold no lone surrogate");
				return `${JSON.stringify(key)}:${canonicalJson(field)}`;
			})
			.join(",")}}`;
	}
	throw invalid(`a record holds JSON only, not ${typeof value === "object" ? "a class instance" : typeof value}`);
}

function frozen<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const field of Object.values(value)) frozen(field);
		Object.freeze(value);
	}
	return value;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function idList(value: unknown, name: string): string[] {
	if (!Array.isArray(value)) throw invalid(`${name} is a list of record IDs`);
	for (const [index, id] of value.entries()) {
		if (typeof id !== "string" || !recordId.test(id)) throw invalid(`${name} holds 64-hex record IDs`);
		if (index > 0 && id <= value[index - 1]) throw invalid(`${name} is sorted, with no ID twice`);
	}
	return value;
}

function fieldsExactly(value: unknown, names: readonly string[], what: string): { [field: string]: unknown } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${what} is an object`);
	const own = Object.keys(value);
	if (own.length !== names.length || !names.every((name) => own.includes(name)))
		throw invalid(`${what} holds ${names.join(", ")} and nothing else`);
	return value as { [field: string]: unknown };
}

function key(value: unknown, what: string): void {
	if (typeof value !== "string" || value === "") throw invalid(`${what} is a non-empty string`);
}

function manifestOf(payload: unknown): void {
	const manifest = fieldsExactly(payload, ["read", "walkthrough", "replaces", "before"], "a round's payload");
	if (!Array.isArray(manifest.read)) throw invalid("a round's read is a list");
	for (const [index, entry] of manifest.read.entries()) {
		const named = fieldsExactly(entry, ["kind", "key", "id"], "a record a round read");
		if (
			typeof named.kind !== "string" ||
			named.kind === "round" ||
			!(kinds.has(named.kind) || supersedingKinds.has(named.kind))
		)
			throw invalid("a record a round read has a kind no round reads");
		key(named.key, "a record a round read's key");
		idList([named.id], "a round's read");
		if (index > 0 && (named.id as string) <= (manifest.read[index - 1] as NamedRecord).id)
			throw invalid("a round's read is sorted by ID, with no ID twice");
	}
	if (manifest.walkthrough !== null) {
		const walkthrough = fieldsExactly(manifest.walkthrough, ["key", "id"], "a round's walkthrough");
		key(walkthrough.key, "a round's walkthrough's key");
		idList([walkthrough.id], "a round's walkthrough");
	}
	idList(manifest.replaces, "a round's replaces");
	idList(manifest.before, "a round's before");
}

function canonicalBase64(value: string): boolean {
	const bytes = Buffer.from(value, "base64");
	return bytes.length === signatureBytes && bytes.toString("base64") === value;
}

/**
 * A validated {@link RecordEnvelope}, named by its ID: the SHA-256, in hex, of its canonical bytes. Build one with
 * {@link SharedRecord.parse} from a value, or {@link SharedRecord.read} from the bytes a store filed under an ID.
 */
export class SharedRecord {
	readonly v: 1;
	readonly changeset: string;
	readonly revision: string | undefined;
	readonly kind: string;
	readonly key: string;
	readonly supersedes: readonly string[];
	readonly payload: RecordJson;
	readonly signer: string | undefined;
	readonly signature: string | undefined;
	/** The canonical bytes, RFC 8785, of the whole envelope. */
	readonly bytes: string;
	/** The SHA-256 of {@link SharedRecord.bytes}, in lower-case hex. */
	readonly id: string;

	private constructor(parsed: RecordEnvelope, bytes: string) {
		const envelope = frozen(parsed);
		this.v = envelope.v;
		this.changeset = envelope.changeset;
		this.revision = envelope.revision;
		this.kind = envelope.kind;
		this.key = envelope.key;
		this.supersedes = envelope.supersedes ?? frozen([]);
		this.payload = envelope.payload;
		this.signer = envelope.signer;
		this.signature = envelope.signature;
		this.bytes = bytes;
		this.id = sha256(bytes);
	}

	/**
	 * Validates `value` as an envelope, by rules 2 to 4 of the shared record decision, and its payload under `payloads`,
	 * and throws a {@link RecordError} that names the rule it breaks: `unknownKind`, `supersedesNotAllowed`,
	 * `unvalidatedKind`, or `invalidRecord` for the rest.
	 */
	static parse(value: unknown, payloads: PayloadChecks = {}): SharedRecord {
		return SharedRecord.parseEnvelope(value).checked(payloads);
	}

	/**
	 * Validates `value` as an envelope, as {@link SharedRecord.parse} does, and leaves its payload unchecked, a round's
	 * manifest included, so a reader can set an untrusted record aside first. Check the payload with `checked`.
	 */
	static parseEnvelope(value: unknown): SharedRecord {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw invalid("a record is a JSON object");
		const bytes = canonicalJson(value);
		const envelope = frozen(JSON.parse(bytes) as { [field: string]: unknown });
		for (const field of Object.keys(envelope))
			if (!fields.has(field)) throw invalid(`a record holds no field ${field}`);
		if (envelope.v !== 1) throw invalid("a record's v is 1");
		if (typeof envelope.changeset !== "string" || !dotted.test(envelope.changeset))
			throw invalid("a record's changeset is dot-joined segments of [a-z0-9-]");
		if (typeof envelope.kind !== "string" || !dotted.test(envelope.kind))
			throw invalid("a record's kind is dot-joined segments of [a-z0-9-]");
		const supersedes = supersedingKinds.has(envelope.kind);
		if (!supersedes && !kinds.has(envelope.kind))
			throw new RecordError("unknownKind", `no record has the kind ${envelope.kind}`);
		if (typeof envelope.key !== "string" || envelope.key === "")
			throw invalid("a record's key is a non-empty string");
		if (!("payload" in envelope)) throw invalid("a record has a payload");
		if ("revision" in envelope) {
			if (typeof envelope.revision !== "string" || !revisionPattern.test(envelope.revision))
				throw invalid("a record's revision is two full lower-case object IDs joined by ..");
			if (envelope.kind === "dismissal") throw invalid("a dismissal carries no revision");
		}
		if ("supersedes" in envelope) {
			if (idList(envelope.supersedes, "supersedes").length === 0)
				throw invalid("supersedes, when present, names at least one record");
			if (!supersedes)
				throw new RecordError("supersedesNotAllowed", `a ${envelope.kind} record may not supersede another`);
		}
		if ("signer" in envelope !== "signature" in envelope)
			throw invalid("a record's signer and signature appear together or not at all");
		if ("signer" in envelope && (typeof envelope.signer !== "string" || envelope.signer === ""))
			throw invalid("a record's signer is a non-empty string");
		if ("signature" in envelope && (typeof envelope.signature !== "string" || !canonicalBase64(envelope.signature)))
			throw invalid(`a record's signature is ${signatureBytes} bytes in canonical base64`);
		if (envelope.kind === "round" && !("revision" in envelope)) throw invalid("a round names its revision");
		return new SharedRecord(envelope as RecordEnvelope, bytes);
	}

	/**
	 * Checks the payload under `payloads`, core's own check for a round's manifest, and returns this record, or throws
	 * `unvalidatedKind` for a kind with no check and `invalidRecord` for a payload its check refuses.
	 */
	checked(payloads: PayloadChecks = {}): SharedRecord {
		if (this.kind === "round") manifestOf(this.payload);
		else {
			const check = Object.hasOwn(payloads, this.kind) ? payloads[this.kind] : undefined;
			if (check === undefined)
				throw new RecordError("unvalidatedKind", `no payload check is registered for a ${this.kind} record`);
			const refused = check(this.payload);
			if (refused !== undefined) throw invalid(`a ${this.kind} record's payload ${refused}`);
		}
		return this;
	}

	/**
	 * Reads the bytes a store filed under `id`. They must be the record's canonical bytes exactly, `notCanonical`
	 * otherwise, and hash to `id`, `idMismatch` otherwise, so one fact never takes two IDs.
	 */
	static read(bytes: string, id: string, payloads: PayloadChecks = {}): SharedRecord {
		return SharedRecord.readEnvelope(bytes, id).checked(payloads);
	}

	/** Reads the bytes a store filed under `id`, as {@link SharedRecord.read} does, and leaves the payload unchecked. */
	static readEnvelope(bytes: string, id: string): SharedRecord {
		let value: unknown;
		try {
			value = JSON.parse(bytes);
		} catch (error) {
			throw new RecordError("invalidRecord", "a stored record is not JSON", { cause: error });
		}
		const record = SharedRecord.parseEnvelope(value);
		if (record.bytes !== bytes)
			throw new RecordError("notCanonical", "a stored record's bytes are not its canonical form");
		if (record.id !== id) throw new RecordError("idMismatch", `a record filed as ${id} has the ID ${record.id}`);
		return record;
	}

	/** The SHA-256 of the key, in hex, which an adapter files the record under. */
	get keyHash(): string {
		return sha256(this.key);
	}

	/** Where an adapter that keeps files keeps this record: `changesets/<changeset>/<kind>/<key hash>/<id>.json`. */
	get path(): string {
		return `changesets/${this.changeset}/${this.kind}/${this.keyHash}/${this.id}.json`;
	}

	/** Whether `other` is in this record's slot: the same changeset, kind and key. */
	sharesSlot(other: SharedRecord): boolean {
		return this.changeset === other.changeset && this.kind === other.kind && this.key === other.key;
	}

	/** A round's manifest, or `undefined` for any other kind. */
	manifest(): Readonly<RoundManifest> | undefined {
		return this.kind === "round" ? (this.payload as RoundManifest) : undefined;
	}

	/** The rounds of its revision a round replaces; none for any other kind. */
	replaces(): readonly string[] {
		return this.manifest()?.replaces ?? [];
	}

	/** The bytes a signature covers: the canonical bytes of the whole envelope without `signature`. */
	signedBytes(): string {
		// A signature cannot cover itself, so the bytes it signs leave it out.
		const { signature: _, ...unsigned } = this.toJSON();
		return canonicalJson(unsigned);
	}

	toJSON(): RecordEnvelope {
		return JSON.parse(this.bytes) as RecordEnvelope;
	}
}

/** The trust of a store whose every writer is trusted, by rule 6 of the shared record decision: every record counts. */
export const everyRecordCounts = (_record: SharedRecord): boolean => true;

/**
 * A set of records, and what rule 4 of the shared record decision computes from it. Every answer is a function of the
 * set alone: no order of arrival, no repeat, and no record outside the set changes it.
 */
export class RecordSet {
	readonly #records: readonly SharedRecord[];
	readonly #superseded: ReadonlySet<string>;

	private constructor(records: readonly SharedRecord[]) {
		this.#records = records;
		const superseded = new Set<string>();
		const byId = new Map(records.map((record) => [record.id, record]));
		for (const record of records)
			for (const id of record.supersedes) {
				const target = byId.get(id);
				if (target?.sharesSlot(record)) superseded.add(id);
			}
		this.#superseded = superseded;
	}

	/**
	 * The set of `records`, each once. Each record is checked in one order, even when it was parsed before: its envelope,
	 * then `counts`, then its payload under `payloads`, then rule 4. `counts` is required, so no caller trusts a store by
	 * leaving it out. A record with a bad envelope fails the set. One for which `counts` is false, such as one a pinned
	 * key did not sign, is set aside before every other rule: its payload goes unchecked, and it supersedes nothing,
	 * replaces nothing, and stands nowhere. A record that counts and whose payload its check refuses fails the set.
	 */
	static of(
		records: Iterable<SharedRecord | RecordEnvelope>,
		options: { counts: (record: SharedRecord) => boolean; payloads?: PayloadChecks },
	): RecordSet {
		const counts = options?.counts;
		if (typeof counts !== "function")
			throw new RecordError(
				"trustUnstated",
				"a record set needs counts; pass everyRecordCounts for a store whose every writer is trusted",
			);
		const byId = new Map<string, SharedRecord>();
		for (const each of records) {
			const record = SharedRecord.parseEnvelope(each instanceof SharedRecord ? each.toJSON() : each);
			if (counts(record)) byId.set(record.id, record.checked(options.payloads));
		}
		return new RecordSet([...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
	}

	/** Every record that counts, in ID order. */
	records(): readonly SharedRecord[] {
		return this.#records;
	}

	/** Whether a record of the set in `record`'s slot names it in `supersedes`. */
	superseded(record: SharedRecord): boolean {
		return this.#superseded.has(record.id);
	}

	/** The records no other supersedes, in ID order. */
	unsuperseded(): readonly SharedRecord[] {
		return this.#records.filter((record) => !this.superseded(record));
	}

	/** The rounds of `changeset` at `revision` that no other round of both names as replaced, in ID order. */
	standingRounds(changeset: string, revision: string): readonly SharedRecord[] {
		const rounds = this.#records.filter(
			(record) => record.kind === "round" && record.changeset === changeset && record.revision === revision,
		);
		const replaced = new Set(rounds.flatMap((round) => round.replaces()));
		return rounds.filter((round) => !replaced.has(round.id));
	}

	/**
	 * The records `round` names, its walkthrough included, that the set holds under no record of the same changeset,
	 * kind, key and ID together. A round with any is not reviewed, by rule 4; this answers the fact and decides nothing.
	 */
	missing(round: SharedRecord): readonly NamedRecord[] {
		const manifest = round.manifest();
		if (manifest === undefined) return [];
		const named = [...manifest.read];
		if (manifest.walkthrough !== null) named.push({ kind: "walkthrough", ...manifest.walkthrough });
		return named.filter(
			(entry) =>
				!this.#records.some(
					(record) =>
						record.id === entry.id &&
						record.kind === entry.kind &&
						record.key === entry.key &&
						record.changeset === round.changeset,
				),
		);
	}
}

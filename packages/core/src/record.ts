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
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function idList(value: unknown, name: string): string[] {
	if (!Array.isArray(value)) throw invalid(`${name} is a list of record IDs`);
	for (const [index, id] of value.entries()) {
		if (typeof id !== "string" || !recordId.test(id)) throw invalid(`${name} holds 64-hex record IDs`);
		if (index > 0 && id <= value[index - 1]) throw invalid(`${name} is sorted, with no ID twice`);
	}
	return value;
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
	 * Validates `value` as an envelope, by rules 2 to 4 of the shared record decision, and throws a {@link RecordError}
	 * that names the rule it breaks: `unknownKind`, `supersedesNotAllowed`, or `invalidRecord` for the rest.
	 */
	static parse(value: unknown): SharedRecord {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw invalid("a record is a JSON object");
		const bytes = canonicalJson(value);
		const envelope = JSON.parse(bytes) as { [field: string]: unknown };
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
		if (envelope.kind === "round") {
			if (!("revision" in envelope)) throw invalid("a round names its revision");
			const payload = envelope.payload;
			if (typeof payload !== "object" || payload === null || Array.isArray(payload))
				throw invalid("a round's payload is an object");
			idList((payload as { replaces?: unknown }).replaces, "a round's replaces");
		}
		return new SharedRecord(envelope as RecordEnvelope, bytes);
	}

	/**
	 * Reads the bytes a store filed under `id`. They must be the record's canonical bytes exactly, `notCanonical`
	 * otherwise, and hash to `id`, `idMismatch` otherwise, so one fact never takes two IDs.
	 */
	static read(bytes: string, id: string): SharedRecord {
		let value: unknown;
		try {
			value = JSON.parse(bytes);
		} catch (error) {
			throw new RecordError("invalidRecord", "a stored record is not JSON", { cause: error });
		}
		const record = SharedRecord.parse(value);
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

	/** The rounds of its revision a round replaces; none for any other kind. */
	replaces(): readonly string[] {
		if (this.kind !== "round") return [];
		return (this.payload as { replaces: string[] }).replaces;
	}

	/** The bytes a signature covers: the canonical bytes of the whole envelope without `signature`. */
	signedBytes(): string {
		const { signature: _, ...unsigned } = this.toJSON();
		return canonicalJson(unsigned);
	}

	toJSON(): RecordEnvelope {
		return JSON.parse(this.bytes) as RecordEnvelope;
	}
}

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
	 * The set of `records`, each once. A record for which `counts` is false, such as one a pinned key did not sign, is
	 * set aside before every other rule: it supersedes nothing, replaces nothing, and stands nowhere.
	 */
	static of(
		records: Iterable<SharedRecord | RecordEnvelope>,
		counts: (record: SharedRecord) => boolean = () => true,
	): RecordSet {
		const byId = new Map<string, SharedRecord>();
		for (const each of records) {
			const record = each instanceof SharedRecord ? each : SharedRecord.parse(each);
			if (counts(record)) byId.set(record.id, record);
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
}

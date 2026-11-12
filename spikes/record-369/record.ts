// The record envelope of issue #368's contract: canonical bytes, Ed25519 signatures, and record IDs.
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type RecordEnvelope = {
	v: 1;
	changeset: string;
	kind: string;
	key: string;
	payload: Json;
	signer: string;
	signature: string;
};

// UTF-8 JSON with object keys sorted and no whitespace.
export function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((each) => canonical(each === undefined ? null : each)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, each]) => each !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`).join(",")}}`;
}

export function recordId(record: RecordEnvelope): string {
	return createHash("sha256").update(canonical(record), "utf8").digest("hex");
}

export class Signer {
	readonly id: string;
	readonly #key: KeyObject;
	readonly publicKey: KeyObject;

	private constructor(key: KeyObject) {
		this.#key = key;
		this.publicKey = createPublicKey(key);
		this.id = Signer.keyId(this.publicKey);
	}

	// A throwaway key, generated in the session and never written down.
	static generate(): Signer {
		return new Signer(generateKeyPairSync("ed25519").privateKey);
	}

	static fromPem(pem: string): Signer {
		return new Signer(createPrivateKey(pem));
	}

	// The first 16 hex digits of SHA-256 over the raw 32-byte public key.
	static keyId(publicKey: KeyObject): string {
		const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
		return createHash("sha256").update(raw).digest("hex").slice(0, 16);
	}

	sign(fields: Omit<RecordEnvelope, "signer" | "signature">): RecordEnvelope {
		const unsigned = { ...fields, signer: this.id };
		const signature = sign(null, Buffer.from(canonical(unsigned), "utf8"), this.#key).toString("base64");
		return { ...unsigned, signature };
	}
}

// Whether `record` carries a valid signature by one of `keys`, by key ID. Trust beyond that is issue #371's question.
export function verified(record: RecordEnvelope, keys: ReadonlyMap<string, KeyObject>): boolean {
	const key = keys.get(record.signer);
	if (key === undefined) return false;
	const { signature, ...unsigned } = record;
	return verify(null, Buffer.from(canonical(unsigned), "utf8"), key, Buffer.from(signature, "base64"));
}

// A directory of records, one file per record named by its ID: the same bytes twice are one record.
export class RecordDirectory {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
		mkdirSync(path, { recursive: true });
	}

	add(record: RecordEnvelope): string {
		const id = recordId(record);
		writeFileSync(join(this.path, `${id}.json`), `${canonical(record)}\n`);
		return id;
	}

	list(): RecordEnvelope[] {
		return readdirSync(this.path)
			.filter((name) => name.endsWith(".json"))
			.map((name) => JSON.parse(readFileSync(join(this.path, name), "utf8")) as RecordEnvelope);
	}
}

// The envelope of the shared record decision, section 3, as it is worded. Scripts, not product code.
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { Revision } from "@melian-agent/core";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Envelope = {
	v: 1;
	changeset: string;
	revision?: string;
	kind: string;
	key: string;
	supersedes?: string[];
	payload: Json;
	signer?: string;
	signature?: string;
};

export const fields = ["v", "changeset", "revision", "kind", "key", "supersedes", "payload", "signer", "signature"];

// "UTF-8 JSON, object keys sorted, no whitespace, text as given, integers within the safe range." Keys sort by UTF-16
// code unit, as JavaScript sorts; the decision names no order.
export function canonical(value: unknown, order: (a: string, b: string) => number = utf16): string {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new RangeError("a record holds no NaN or infinity");
		if (Number.isInteger(value) && !Number.isSafeInteger(value))
			throw new RangeError(`${value} is an integer past the safe range`);
		return JSON.stringify(value);
	}
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((each) => canonical(each, order)).join(",")}]`;
	const keys = Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined);
	return `{${keys
		.sort(order)
		.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], order)}`)
		.join(",")}}`;
}

export const utf16 = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// The order a Go, Rust or Python canonicaliser gets by comparing UTF-8 bytes or code points.
export const codePoint = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

export function recordId(envelope: Envelope, order = utf16): string {
	return createHash("sha256").update(canonical(envelope, order), "utf8").digest("hex");
}

const alphabet = /^[a-z0-9.-]+$/;

// Why the reader refuses the envelope, or undefined. Each rule the decision states is marked `stated`; each rule it
// leaves out but a strict reader needs is gated behind `strict`, so a test can show the decision admits the input.
export function refusal(envelope: Record<string, unknown>, strict = false): string | undefined {
	const extra = Object.keys(envelope).filter((field) => !fields.includes(field));
	if (extra.length > 0) return `the envelope holds ${extra.join(", ")}`; // stated
	if (envelope.v !== 1) return `version ${String(envelope.v)}`;
	for (const field of ["changeset", "kind"] as const) {
		const value = envelope[field];
		if (typeof value !== "string" || !alphabet.test(value)) return `${field} is outside the alphabet`; // stated
		if (strict && (value.startsWith(".") || value.endsWith(".") || value.includes("..")))
			return `${field} ${value} is not a safe path component`;
	}
	if (typeof envelope.key !== "string") return "the key is not text";
	if (envelope.payload === undefined) return "no payload";
	try {
		canonical(envelope); // stated: integers within the safe range
	} catch (error) {
		return (error as Error).message;
	}
	if ("signature" in envelope) {
		const text = envelope.signature;
		const raw = Buffer.from(typeof text === "string" ? text : "", "base64");
		if (raw.length !== 64 || raw.toString("base64") !== text)
			return "the signature is not 64 bytes in canonical base64"; // stated
	}
	if (strict) {
		if ("revision" in envelope && Revision.parseKey(String(envelope.revision)) === undefined)
			return "the revision is not a Revision.key";
		if ("revision" in envelope && !/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/.test(String(envelope.revision)))
			return "the revision is not two full object IDs";
		if ("signer" in envelope !== "signature" in envelope) return "a signer without a signature, or the reverse";
		const supersedes = envelope.supersedes;
		if (supersedes !== undefined) {
			if (!Array.isArray(supersedes) || supersedes.length === 0) return "supersedes is empty";
			if (supersedes.some((id) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)))
				return "supersedes names something that is not a record ID";
			const sorted = [...new Set(supersedes as string[])].sort();
			if (sorted.join() !== supersedes.join()) return "supersedes is not sorted and duplicate-free";
		}
		if (fraction(envelope.payload)) return "the payload holds a number that is not an integer";
	}
	return undefined;
}

function fraction(value: unknown): boolean {
	if (typeof value === "number") return !Number.isInteger(value);
	if (value === null || typeof value !== "object") return false;
	return Object.values(value).some(fraction);
}

// A throwaway Ed25519 key. The decision does not say which bytes the signature covers; `covers` picks a reading.
export class Key {
	readonly id: string;
	readonly publicKey: KeyObject;
	readonly #private: KeyObject;

	private constructor(privateKey: KeyObject) {
		this.#private = privateKey;
		this.publicKey = createPublicKey(privateKey);
		const raw = this.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
		this.id = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	}

	static generate(): Key {
		return new Key(generateKeyPairSync("ed25519").privateKey);
	}

	sign(envelope: Envelope, covers: Coverage = "envelope"): Envelope {
		const unsigned = { ...envelope, signer: this.id };
		delete unsigned.signature;
		const signature = sign(null, Buffer.from(canonical(covered(unsigned, covers)), "utf8"), this.#private);
		return { ...unsigned, signature: signature.toString("base64") };
	}
}

// "envelope": everything but the signature. "spike-371": the six fields issue #371's spike signed, which predate
// `revision` and `supersedes`.
export type Coverage = "envelope" | "spike-371";

function covered(envelope: Envelope, covers: Coverage): Record<string, unknown> {
	if (covers === "envelope") {
		const { signature: _, ...rest } = envelope;
		return rest;
	}
	return Object.fromEntries(
		["v", "changeset", "kind", "key", "payload", "signer"].map((field) => [field, envelope[field as keyof Envelope]]),
	);
}

export function signedBy(envelope: Envelope, key: Key, covers: Coverage = "envelope"): boolean {
	if (envelope.signer !== key.id || envelope.signature === undefined) return false;
	return verify(
		null,
		Buffer.from(canonical(covered(envelope, covers)), "utf8"),
		key.publicKey,
		Buffer.from(envelope.signature, "base64"),
	);
}

// Spike for issue #371: sign the design's RecordEnvelope with Ed25519 and decide trust from a base commit's policy.
// Scripts, not product code: nothing here is imported by packages/.

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { parse } from "yaml";

const fields = ["v", "changeset", "kind", "key", "payload", "signer"];

// UTF-8 JSON with object keys sorted and no whitespace, as the design issue's contract says.
export function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	if (typeof value === "number" && !Number.isFinite(value)) throw new Error("a record holds no NaN or infinity");
	if (value === undefined) throw new Error("a record holds no undefined");
	return JSON.stringify(value);
}

const bytes = (value) => Buffer.from(canonical(value), "utf8");
const signed = (record) => Object.fromEntries(fields.map((field) => [field, record[field]]));

/** The record's ID: SHA-256, in hex, over the whole envelope's canonical bytes. */
export function recordId(record) {
	return createHash("sha256").update(bytes(record)).digest("hex");
}

/** The first 16 hex digits of SHA-256 over the raw 32-byte public key. */
export function keyId(raw) {
	return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** A throwaway key pair: the raw public key, base64url, as a policy lists it, and the private key object. */
export function throwawayKey() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
	return { key: raw.toString("base64url"), id: keyId(raw), privateKey };
}

export function signRecord(unsigned, signer) {
	const record = { ...unsigned, v: 1, signer: signer.id };
	return { ...record, signature: sign(null, bytes(signed(record)), signer.privateKey).toString("base64") };
}

/** The trust section of the root melian.yaml at `commit`, read from git's objects alone. */
export function policyAt(repo, commit) {
	const text = execFileSync("git", ["-C", repo, "show", `${commit}:melian.yaml`], { encoding: "utf8" });
	const trust = parse(text)?.trust ?? {};
	return {
		writers: trust.writers !== false,
		signers: (trust.signers ?? []).map(({ name, key, role }) => {
			const raw = Buffer.from(key, "base64url");
			if (raw.length !== 32) throw new Error(`signer ${name}'s key is not 32 bytes`);
			if (role !== "host" && role !== "writer") throw new Error(`signer ${name}'s role is ${role}`);
			return { name, role, raw, id: keyId(raw) };
		}),
	};
}

/** Why the policy refuses the record, or undefined when it trusts it. */
export function refusal(record, policy) {
	if (record.v !== 1) return `version ${record.v}`;
	// The ID covers the whole envelope and the signature only six fields, so an extra field, or a signature spelled
	// another way that decodes to the same bytes, would give one signed fact any number of IDs.
	const extra = Object.keys(record).filter((field) => field !== "signature" && !fields.includes(field));
	if (extra.length > 0) return `the envelope holds ${extra.join(", ")}, which no signature covers`;
	const raw = Buffer.from(typeof record.signature === "string" ? record.signature : "", "base64");
	if (raw.length !== 64 || raw.toString("base64") !== record.signature)
		return "the signature is not 64 bytes in canonical base64";
	const listed = policy.signers.filter((signer) => signer.id === record.signer);
	if (listed.length === 0) return `signer ${record.signer} is not listed`;
	if (listed.length > 1) return `signer ${record.signer} is listed twice`;
	const [signer] = listed;
	if (signer.role === "writer" && !policy.writers)
		return `signer ${signer.name} is a writer, and trust.writers is false`;
	const publicKey = createPublicKey({
		key: { kty: "OKP", crv: "Ed25519", x: signer.raw.toString("base64url") },
		format: "jwk",
	});
	let good = false;
	try {
		good = verify(null, bytes(signed(record)), publicKey, Buffer.from(record.signature, "base64"));
	} catch {
		good = false;
	}
	return good ? undefined : "the signature does not verify";
}

/**
 * Whether a closing record the policy trusts names this record by kind, key and ID. An ID fixes the record's bytes, so
 * the vouching key need not be the one that signed it: a retired key's records stay usable while a listed key vouches.
 */
export function vouched(record, closing, policy) {
	if (refusal(closing, policy) !== undefined || closing.kind !== "round") return false;
	const id = recordId(record);
	return (closing.payload?.rests ?? []).some(
		(rest) => rest.kind === record.kind && rest.key === record.key && rest.id === id,
	);
}

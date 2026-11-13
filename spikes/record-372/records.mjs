// Spike for issue #372: the record envelope from issue #368, signed with throwaway keys, in a plain directory.
// Trimmed from spikes/record-370/store.mjs on spike/record-370: canonical bytes, record IDs, a signer, the directory
// store. Added here: signature verification and the lowest-ID rule. Node built-ins only.
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.filter((key) => value[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

export const recordId = (envelope) => sha256(canonical(envelope));

// A throwaway Ed25519 key, generated in memory and never written to disk.
export class Signer {
	constructor() {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		this.raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
		this.id = createHash("sha256").update(this.raw).digest("hex").slice(0, 16);
		this.privateKey = privateKey;
	}

	record(changeset, kind, key, payload) {
		const unsigned = { v: 1, changeset, kind, key, payload, signer: this.id };
		const signature = sign(null, Buffer.from(canonical(unsigned), "utf8"), this.privateKey).toString("base64");
		return { ...unsigned, signature };
	}
}

// Whether `envelope` is signed by one of `trusted`, raw Ed25519 public keys by signer ID.
export function verified(envelope, trusted) {
	const raw = trusted.get(envelope.signer);
	if (raw === undefined) return false;
	const { signature, ...unsigned } = envelope;
	const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
	const key = createPublicKey({ key: der, format: "der", type: "spki" });
	return verify(null, Buffer.from(canonical(unsigned), "utf8"), key, Buffer.from(signature, "base64"));
}

// Among records under one kind and key, the lowest ID wins.
export function winners(records) {
	const best = new Map();
	for (const record of records) {
		const slot = `${record.kind}\0${record.key}`;
		const held = best.get(slot);
		if (held === undefined || recordId(record) < recordId(held)) best.set(slot, record);
	}
	return [...best.values()];
}

const recordPath = (record) =>
	`changesets/${record.changeset}/${record.kind}/${sha256(record.key)}/${recordId(record)}.json`;

export class DirectoryRecordStore {
	#root;

	constructor(root) {
		this.#root = root;
	}

	static async open({ root }) {
		await mkdir(root, { recursive: true });
		return new DirectoryRecordStore(root);
	}

	async add(record) {
		const path = join(this.#root, recordPath(record));
		await mkdir(join(path, ".."), { recursive: true });
		try {
			await stat(path);
			return;
		} catch {}
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, canonical(record));
		await rename(temporary, path);
	}

	async list(changeset) {
		const records = [];
		const walk = async (dir) => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch (error) {
				if (error.code === "ENOENT") return;
				throw error;
			}
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) await walk(path);
				else if (entry.name.endsWith(".json")) records.push(JSON.parse(await readFile(path, "utf8")));
			}
		};
		await walk(join(this.#root, "changesets", changeset));
		return records;
	}
}

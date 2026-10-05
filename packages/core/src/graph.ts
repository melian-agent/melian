import { createHash } from "node:crypto";
import Type, { type Static } from "typebox";
import Value from "typebox/value";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const strict = { additionalProperties: false };
/** The inputs that identify a graph without computing its facts. */
export const graphKeySchema = Type.Object(
	{
		tree: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
		version: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$" }),
		binary: hash,
		config: hash,
	},
	strict,
);
/** The graph cache key's parts. */
export type GraphKeyParts = Static<typeof graphKeySchema>;
/** Files required to restore a snapshot, including upstream's freshness metadata. */
export const graphFiles = ["facts.jsonl", "insights.json", "receipt.json", "snapshot.meta.json", "run.json"] as const;
/** Contract artifacts and optional upstream restore metadata. */
export type GraphFiles = {
	"facts.jsonl": string;
	"insights.json": string;
	"receipt.json": string;
	"snapshot.meta.json"?: string;
	"run.json"?: string;
};
const entrySchema = Type.Object(
	{
		format_version: Type.Literal(1),
		key: hash,
		parts: graphKeySchema,
		snapshotId: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
		created: Type.String(),
		artifacts: Type.Record(Type.String(), hash),
	},
	strict,
);
/** The entry stored beside a graph's artifacts. */
export type GraphEntryState = Static<typeof entrySchema>;
/** A graph cache contract could not be read. */
export class GraphError extends Error {
	readonly code = "invalidOutput";
	constructor(message: string) {
		super(message);
		this.name = "GraphError";
	}
}
/** A validated, content-checked Enola snapshot. */
export class GraphSnapshot {
	readonly #entry: GraphEntryState;
	readonly #files: GraphFiles;
	private constructor(entry: GraphEntryState, files: GraphFiles) {
		this.#entry = entry;
		this.#files = files;
	}
	/** Computes a cache key from tree, version, executable digest, and policy. */
	static key(parts: GraphKeyParts): string {
		if (!Value.Check(graphKeySchema, parts)) throw new GraphError("Invalid graph key parts");
		return createHash("sha256")
			.update([parts.tree, parts.version, parts.binary, parts.config].join("\0"))
			.digest("hex");
	}
	/** Validates new contract artifacts and records their hashes. */
	static create(parts: GraphKeyParts, files: GraphFiles, now = new Date()): GraphSnapshot {
		const receipt: unknown = JSON.parse(files["receipt.json"]);
		if (typeof receipt !== "object" || receipt === null) throw new GraphError("Invalid Enola receipt");
		const stored = receipt as { format_version?: unknown; snapshot_id?: unknown; enola_version?: unknown };
		if (
			stored.format_version !== 1 ||
			stored.enola_version !== parts.version ||
			typeof stored.snapshot_id !== "string" ||
			!/^sha256:[a-f0-9]{64}$/.test(stored.snapshot_id)
		)
			throw new GraphError("Unsupported Enola receipt format, identity, or version");
		JSON.parse(files["insights.json"]);
		for (const line of files["facts.jsonl"].split("\n").filter(Boolean)) JSON.parse(line);
		const artifacts = Object.fromEntries(
			Object.entries(files).map(([name, text]) => [name, createHash("sha256").update(text).digest("hex")]),
		);
		return new GraphSnapshot(
			{
				format_version: 1,
				key: GraphSnapshot.key(parts),
				parts: structuredClone(parts),
				snapshotId: stored.snapshot_id,
				created: now.toISOString(),
				artifacts,
			},
			structuredClone(files),
		);
	}
	/** Reads an entry only when all inputs and artifact hashes agree. */
	static parse(text: string, files: GraphFiles, parts: GraphKeyParts): GraphSnapshot {
		const entry: unknown = JSON.parse(text);
		if (!Value.Check(entrySchema, entry)) throw new GraphError("Invalid graph entry");
		const computed = GraphSnapshot.create(parts, files);
		const stored = entry as GraphEntryState;
		if (
			stored.key !== computed.key ||
			JSON.stringify(stored.parts) !== JSON.stringify(computed.#entry.parts) ||
			stored.snapshotId !== computed.snapshotId ||
			JSON.stringify(stored.artifacts) !== JSON.stringify(computed.#entry.artifacts) ||
			!Number.isFinite(Date.parse(stored.created))
		)
			throw new GraphError("Graph entry does not match its inputs or artifacts");
		return new GraphSnapshot(stored, structuredClone(files));
	}
	/** The entry's cache key. */
	get key(): string {
		return this.#entry.key;
	}
	/** Enola's facts identity, distinct from the cache key. */
	get snapshotId(): string {
		return this.#entry.snapshotId;
	}
	/** Returns the validated entry. */
	toJSON(): GraphEntryState {
		return structuredClone(this.#entry);
	}
	/** Returns contract artifacts for restoration in an execution environment. */
	files(): GraphFiles {
		return structuredClone(this.#files);
	}
}

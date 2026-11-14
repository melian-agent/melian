import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type GraphEntryState,
	type GraphFiles,
	type GraphKeyParts,
	GraphSnapshot,
	graphFiles,
} from "@melian-agent/core";
import { CacheScratch } from "./cache-scratch.ts";

const limit = 16 * 1024 * 1024;
async function bounded(path: string): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size >= limit) throw new Error("Unreadable graph artifact");
		const bytes = Buffer.alloc(info.size + 1);
		const result = await file.read(bytes, 0, bytes.length, 0);
		if (result.bytesRead !== info.size) throw new Error("Graph artifact changed while reading");
		return bytes.subarray(0, result.bytesRead).toString("utf8");
	} finally {
		await file.close();
	}
}
/**
 * What a graph directory holds, judged as `GraphCache.read` judges it: a hit with the tree and creation time its entry
 * records, a miss, or an entry in a later format that this build cannot read.
 */
export type GraphEntryClass = { tree: string; created: number } | "miss" | "later";

/** A disposable graph cache under the same root as tool binaries. */
export class GraphCache {
	readonly root: string;
	readonly #scratch: CacheScratch | undefined;
	private constructor(root: string, scratch?: CacheScratch) {
		this.root = root;
		this.#scratch = scratch;
	}
	/** Opens directories without holding files or locks. */
	static async open(root: string): Promise<GraphCache> {
		root = resolve(root);
		await mkdir(join(root, "graphs"), { recursive: true });
		return new GraphCache(root, await CacheScratch.open(root));
	}
	/** Opens an existing cache without creating directories or sweeping scratch entries. */
	static openReadOnly(root: string): GraphCache {
		return new GraphCache(resolve(root));
	}
	/** Treats every incomplete, corrupt, or incompatible entry as a miss. */
	async read(parts: GraphKeyParts): Promise<GraphSnapshot | undefined> {
		const directory = join(this.root, "graphs", GraphSnapshot.key(parts));
		try {
			const files: Partial<GraphFiles> = {};
			for (const name of graphFiles) {
				try {
					files[name] = await bounded(join(directory, name));
				} catch (error) {
					if (
						!["snapshot.meta.json", "run.json"].includes(name) ||
						(error as NodeJS.ErrnoException).code !== "ENOENT"
					)
						throw error;
				}
			}
			return GraphSnapshot.parse(await bounded(join(directory, "entry.json")), files as GraphFiles, parts);
		} catch {
			return undefined;
		}
	}
	/** Classifies the graph directory named `key` through the same bounded reads and checks as `read`. */
	async classify(key: string): Promise<GraphEntryClass> {
		let value: unknown;
		try {
			value = JSON.parse(await bounded(join(this.root, "graphs", key, "entry.json")));
		} catch {
			return "miss";
		}
		const version = (value as { format_version?: unknown } | null)?.format_version;
		if (Number.isSafeInteger(version) && (version as number) > 1) return "later";
		let entry: GraphEntryState;
		try {
			entry = GraphSnapshot.entry(value);
		} catch {
			return "miss";
		}
		// `read` looks under the key the parts compute, so parts naming another key would judge that directory instead.
		if (GraphSnapshot.key(entry.parts) !== key || !(await this.read(entry.parts))) return "miss";
		return { tree: entry.parts.tree, created: Date.parse(entry.created) };
	}
	/** Publishes a complete directory atomically; concurrent valid writers share the winner. */
	async store(snapshot: GraphSnapshot): Promise<void> {
		if (this.#scratch === undefined) throw new Error("Graph cache is read-only");
		const parts = snapshot.toJSON().parts;
		if (await this.read(parts)) return;
		const directory = join(this.root, "graphs", snapshot.key);
		const temporary = await this.#scratch.directory(join(this.root, "graphs"), "graph");
		try {
			for (const [name, text] of Object.entries(snapshot.files()))
				await writeFile(join(temporary, name), text, { flag: "wx" });
			await writeFile(join(temporary, "entry.json"), JSON.stringify(snapshot.toJSON()), { flag: "wx" });
			if (await this.read(parts)) return;
			try {
				await rename(temporary, directory);
			} catch (error) {
				if (await this.read(parts)) return;
				if (!["ENOTEMPTY", "EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				const rejected = `${temporary}-rejected`;
				try {
					await rename(directory, rejected);
				} catch (cause) {
					if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
				}
				try {
					await rename(temporary, directory);
				} catch (cause) {
					if (!(await this.read(parts))) throw cause;
				} finally {
					await rm(rejected, { recursive: true, force: true });
				}
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
}

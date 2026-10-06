import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	CoverageError,
	GraphCoverage,
	type GraphKeyParts,
	GraphSnapshot,
	ReviewCoverage,
	TestCoverage,
} from "@melian-agent/core";
import { GraphCache } from "./graph-cache.ts";

const coverageLimit = 16 * 1024 * 1024;

/** Coverage artifacts share the graph's verified input key. */
export class CoverageCache {
	readonly #graphs: GraphCache;
	private constructor(graphs: GraphCache) {
		this.#graphs = graphs;
	}
	/** Opens without holding files or locks. */
	static async open(root: string): Promise<CoverageCache> {
		return new CoverageCache(await GraphCache.open(root));
	}
	/** Atomically writes a validated artifact beside its graph. */
	async store(parts: GraphKeyParts, artifact: GraphCoverage | ReviewCoverage | TestCoverage): Promise<string> {
		if (!(await this.#graphs.read(parts))) throw new Error("Coverage requires a verified graph entry");
		const state = artifact.toJSON();
		if (state.tree !== parts.tree || state.version !== parts.version)
			throw new Error("Coverage identity differs from graph");
		const text = JSON.stringify(state);
		if (Buffer.byteLength(text) > coverageLimit) throw new CoverageError("Coverage exceeds the 16 MiB cache limit");
		const name = artifact instanceof GraphCoverage ? "graph" : artifact instanceof ReviewCoverage ? "review" : "test";
		const directory = join(this.#graphs.root, "graphs", GraphSnapshot.key(parts));
		await mkdir(directory, { recursive: true });
		const temporary = join(directory, `.${name}-${crypto.randomUUID()}.json`);
		try {
			await writeFile(temporary, text, { flag: "wx" });
			await rename(temporary, join(directory, `${name}-coverage.json`));
		} finally {
			await rm(temporary, { force: true });
		}
		return artifact.id;
	}
	/** Unreadable coverage is absent, never clean. */
	async read(
		parts: GraphKeyParts,
		name: "graph" | "review" | "test",
	): Promise<GraphCoverage | ReviewCoverage | TestCoverage | undefined> {
		if (!(await this.#graphs.read(parts))) return undefined;
		try {
			const file = await open(
				join(this.#graphs.root, "graphs", GraphSnapshot.key(parts), `${name}-coverage.json`),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			let stored: unknown;
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.size > coverageLimit) return undefined;
				stored = JSON.parse(await file.readFile("utf8"));
			} finally {
				await file.close();
			}
			const artifact =
				name === "graph"
					? GraphCoverage.from(stored)
					: name === "review"
						? ReviewCoverage.from(stored)
						: TestCoverage.from(stored);
			const state = artifact.toJSON();
			return state.tree === parts.tree && state.version === parts.version ? artifact : undefined;
		} catch {
			return undefined;
		}
	}
}

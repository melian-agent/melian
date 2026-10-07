import { createHash } from "node:crypto";
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
import { CacheScratch } from "./cache-scratch.ts";
import { coverageCompiler, coverageMatcher } from "./coverage-identity.ts";
import { GraphCache } from "./graph-cache.ts";

const coverageLimit = 16 * 1024 * 1024;
type Coverage = GraphCoverage | ReviewCoverage | TestCoverage;
type CoverageKind = "graph" | "review" | "test";

/** Content-addressed evidence and producer indexes for verified graphs. */
export class CoverageCache {
	readonly #graphs: GraphCache;
	readonly #scratch: CacheScratch;
	readonly #compiler: string;
	readonly #matcher: string;
	private constructor(graphs: GraphCache, compiler: string, matcher: string, scratch: CacheScratch) {
		this.#graphs = graphs;
		this.#scratch = scratch;
		this.#compiler = compiler;
		this.#matcher = matcher;
	}
	/** Opens without holding files or locks. Producer overrides support upgrade tests. */
	static async open(root: string, producer: { compiler?: string; matcher?: string } = {}): Promise<CoverageCache> {
		return new CoverageCache(
			await GraphCache.open(root),
			producer.compiler ?? coverageCompiler,
			producer.matcher ?? coverageMatcher,
			await CacheScratch.open(root),
		);
	}

	#producer(name: CoverageKind, review?: string): object {
		if (name === "graph") return { schema: 1, compiler: this.#compiler, matcher: this.#matcher };
		if (name === "review") return { schema: 1, matcher: "review-transcript@1/review-coverage@1", review };
		return { schema: 1, matcher: "test-coverage@1" };
	}

	#directory(parts: GraphKeyParts): string {
		return join(this.#graphs.root, "coverage", GraphSnapshot.key(parts));
	}

	#index(parts: GraphKeyParts, name: CoverageKind, producer: object): string {
		const key = createHash("sha256").update(JSON.stringify(producer)).digest("hex");
		return join(this.#directory(parts), `${name}-${key}.json`);
	}

	async #write(path: string, text: string): Promise<void> {
		const temporary = this.#scratch.file(path);
		try {
			await writeFile(temporary, text, { flag: "wx" });
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	/** Stores exact content before publishing its producer index. Review identities distinguish durable runs. */
	async store(parts: GraphKeyParts, artifact: Coverage, identity: { review?: string } = {}): Promise<string> {
		if (!(await this.#graphs.read(parts))) throw new CoverageError("Coverage requires a verified graph entry");
		const state = artifact.toJSON();
		if (state.tree !== parts.tree || state.version !== parts.version)
			throw new CoverageError("Coverage identity differs from graph");
		if (artifact instanceof GraphCoverage && artifact.toJSON().compiler !== this.#compiler)
			throw new CoverageError("Coverage compiler differs from producer");
		const text = JSON.stringify(state);
		if (Buffer.byteLength(text) > coverageLimit) throw new CoverageError("Coverage exceeds the 16 MiB cache limit");
		const name = artifact instanceof GraphCoverage ? "graph" : artifact instanceof ReviewCoverage ? "review" : "test";
		const directory = this.#directory(parts);
		await mkdir(join(directory, "artifacts"), { recursive: true });
		await this.#write(join(directory, "artifacts", `${name}-${artifact.id}.json`), text);
		const producer = this.#producer(name, name === "review" ? (identity.review ?? artifact.id) : undefined);
		await this.#write(
			this.#index(parts, name, producer),
			JSON.stringify({ format_version: 1, producer, id: artifact.id }),
		);
		return artifact.id;
	}

	async #read(path: string): Promise<unknown> {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > coverageLimit) throw new CoverageError("Unreadable coverage file");
			return JSON.parse(await file.readFile("utf8"));
		} finally {
			await file.close();
		}
	}

	/** Reads exact evidence by ID, or compatible producer output. A review lookup needs its run identity or content ID. */
	async read(
		parts: GraphKeyParts,
		name: CoverageKind,
		identity: { id?: string; review?: string } = {},
	): Promise<Coverage | undefined> {
		if (!(await this.#graphs.read(parts))) return undefined;
		try {
			let id = identity.id;
			if (id === undefined) {
				if (name === "review" && identity.review === undefined) return undefined;
				const producer = this.#producer(name, identity.review);
				const index = await this.#read(this.#index(parts, name, producer));
				if (typeof index !== "object" || index === null) return undefined;
				const stored = index as { format_version?: unknown; producer?: unknown; id?: unknown };
				if (
					stored.format_version !== 1 ||
					JSON.stringify(stored.producer) !== JSON.stringify(producer) ||
					typeof stored.id !== "string"
				)
					return undefined;
				id = stored.id;
			}
			if (!/^[a-f0-9]{64}$/.test(id)) return undefined;
			const stored = await this.#read(join(this.#directory(parts), "artifacts", `${name}-${id}.json`));
			const artifact =
				name === "graph"
					? GraphCoverage.from(stored)
					: name === "review"
						? ReviewCoverage.from(stored)
						: TestCoverage.from(stored);
			const state = artifact.toJSON();
			if (artifact.id !== id || state.tree !== parts.tree || state.version !== parts.version) return undefined;
			if (
				identity.id === undefined &&
				artifact instanceof GraphCoverage &&
				artifact.toJSON().compiler !== this.#compiler
			)
				return undefined;
			return artifact;
		} catch {
			return undefined;
		}
	}
}

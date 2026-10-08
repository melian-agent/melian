import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { CacheScratch } from "./cache-scratch.ts";

const bound = 16 * 1024 * 1024;

/** What one partition of the mutation cache belongs to. Warm reuse holds only when every part is identical. */
export interface MutationCacheKey {
	/** The base-policy commit the review ran under. */
	readonly policy: string;
	readonly trusted: boolean;
	/** The exact head commit, so a different head never reads this head's identities. */
	readonly head: string;
	/** A digest of what else the run feeds Stryker: its version, the lines and the test selection. */
	readonly inputs: string;
	/** The checkout lockfile digest and the resolved Stryker, Vitest runner and Vitest versions. */
	readonly installation: string;
}

async function readable(path: string): Promise<boolean> {
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > bound) return false;
			JSON.parse(await file.readFile("utf8"));
			return true;
		} finally {
			await file.close();
		}
	} catch {
		return false;
	}
}

/**
 * Stryker identities shared only by runs of one repository, base policy, writer-trust class, head commit and input. The
 * sandbox never writes the partition: a run works on a staged copy, and the partition is replaced only by {@link publish}.
 */
export class MutationCache {
	readonly directory: string;
	readonly file: string;
	readonly #root: string;
	private constructor(root: string, directory: string) {
		this.#root = root;
		this.directory = directory;
		this.file = join(directory, "incremental.json");
	}

	/** Opens a persistent partition and discards unreadable or malformed prior output. */
	static async open(root: string, key: MutationCacheKey): Promise<MutationCache> {
		await CacheScratch.open(root);
		const name = createHash("sha256").update(JSON.stringify(key)).digest("hex");
		const directory = join(root, "mutation", name);
		await mkdir(directory, { recursive: true });
		const cache = new MutationCache(root, await realpath(directory));
		if (!(await readable(cache.file))) await rm(cache.file, { recursive: true, force: true });
		return cache;
	}

	/** Copies the partition's report, if any, to `directory` for one run to read and write, and returns its path. */
	async stage(directory: string): Promise<string> {
		const staged = join(directory, "incremental.json");
		await mkdir(directory, { recursive: true });
		await rm(staged, { recursive: true, force: true });
		if (await readable(this.file)) await copyFile(this.file, staged);
		return staged;
	}

	/** Replaces the partition's report with a staged one, if it is readable; otherwise the partition keeps what it had. */
	async publish(staged: string): Promise<void> {
		if (!(await readable(staged))) return;
		const scratch = await CacheScratch.open(this.#root);
		const temporary = scratch.file(this.file);
		await copyFile(staged, temporary);
		await rename(temporary, this.file);
	}
}

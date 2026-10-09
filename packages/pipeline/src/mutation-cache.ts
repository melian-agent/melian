import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { CacheScratch } from "./cache-scratch.ts";

const bound = 16 * 1024 * 1024;

export interface MutationCacheKey {
	readonly policy: string;
	readonly trusted: boolean;
	readonly head: string;
	readonly inputs: string;
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

// The sandbox writes a staged copy; only the host publishes a completed partition.
export class MutationCache {
	readonly directory: string;
	readonly file: string;
	readonly #root: string;
	private constructor(root: string, directory: string) {
		this.#root = root;
		this.directory = directory;
		this.file = join(directory, "incremental.json");
	}

	static async open(root: string, key: MutationCacheKey): Promise<MutationCache> {
		await CacheScratch.open(root);
		const name = createHash("sha256").update(JSON.stringify(key)).digest("hex");
		const directory = join(root, "mutation", name);
		await mkdir(directory, { recursive: true });
		const cache = new MutationCache(root, await realpath(directory));
		if (!(await readable(cache.file))) await rm(cache.file, { recursive: true, force: true });
		return cache;
	}

	async stage(directory: string): Promise<string> {
		const staged = join(directory, "incremental.json");
		await mkdir(directory, { recursive: true });
		await rm(staged, { recursive: true, force: true });
		if (await readable(this.file)) await copyFile(this.file, staged);
		return staged;
	}

	async publish(staged: string): Promise<void> {
		if (!(await readable(staged))) return;
		const scratch = await CacheScratch.open(this.#root);
		const temporary = scratch.file(this.file);
		await copyFile(staged, temporary);
		await rename(temporary, this.file);
	}
}

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { CacheScratch } from "./cache-scratch.ts";

/** Stryker identities shared only by runs of one repository, base policy and writer-trust class. */
export class MutationCache {
	readonly directory: string;
	readonly file: string;
	private constructor(directory: string) {
		this.directory = directory;
		this.file = join(directory, "incremental.json");
	}

	/** Opens a persistent partition and discards unreadable or malformed prior output. */
	static async open(root: string, policy: string, trusted: boolean): Promise<MutationCache> {
		await CacheScratch.open(root);
		const key = createHash("sha256").update(JSON.stringify({ policy, trusted })).digest("hex");
		const directory = join(root, "mutation", key);
		await mkdir(directory, { recursive: true });
		const cache = new MutationCache(await realpath(directory));
		try {
			const file = await open(cache.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const stat = await file.stat();
				if (stat.size > 16 * 1024 * 1024) throw new Error("Unreadable incremental report");
				JSON.parse(await file.readFile("utf8"));
			} finally {
				await file.close();
			}
		} catch {
			await rm(cache.file, { recursive: true, force: true });
		}
		return cache;
	}
}

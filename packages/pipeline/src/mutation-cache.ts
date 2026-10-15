import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CacheScratch } from "./cache-scratch.ts";

const bound = 16 * 1024 * 1024;

export interface MutationCacheKey {
	readonly policy: string;
	readonly head: string;
	readonly inputs: string;
	readonly installation: string;
}

// The text of an incremental report, read through one no-follow open: a regular file within the bound that parses, or
// undefined. What was checked is what is returned, so nothing can be swapped in between. The text is dropped in the
// catch, not returned from it, so a report that does not parse cannot fall through as read.
async function reportText(path: string): Promise<string | undefined> {
	let text: string | undefined;
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > bound) return undefined;
			text = await file.readFile("utf8");
			JSON.parse(text);
		} finally {
			await file.close();
		}
	} catch {
		text = undefined;
	}
	return text;
}

// The run writes a staged copy in its scratch; only a run that still holds authority publishes a completed partition.
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
		const name = createHash("sha256")
			.update(JSON.stringify({ version: 2, key }))
			.digest("hex");
		const directory = join(root, "mutation", name);
		await mkdir(directory, { recursive: true });
		const cache = new MutationCache(root, await realpath(directory));
		if ((await reportText(cache.file)) === undefined) await rm(cache.file, { recursive: true, force: true });
		return cache;
	}

	async stage(directory: string): Promise<string> {
		const staged = join(directory, "incremental.json");
		await mkdir(directory, { recursive: true });
		await rm(staged, { recursive: true, force: true });
		if ((await reportText(this.file)) !== undefined) await copyFile(this.file, staged);
		return staged;
	}

	// The head's tests ran beside the staged file, so it is taken only as a regular file within the bound that parses.
	async publish(staged: string): Promise<void> {
		const text = await reportText(staged);
		if (text === undefined) return;
		const scratch = await CacheScratch.open(this.#root);
		const temporary = scratch.file(this.file);
		await writeFile(temporary, text);
		await rename(temporary, this.file);
	}
}

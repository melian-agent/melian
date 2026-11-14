import type { Dirent } from "node:fs";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Never pid 0 or 1: a signal to 0 asks about this process's own group. NaN, a pid no regex matched, fails the test too.
export function running(pid: number): boolean {
	if (!(pid > 1)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export class CacheScratch {
	readonly root: string;
	private constructor(root: string) {
		this.root = root;
	}
	static async open(root: string): Promise<CacheScratch> {
		const scratch = new CacheScratch(root);
		for (const name of ["tools", "graphs", "coverage", "mutation"]) await scratch.#sweep(join(scratch.root, name), 0);
		return scratch;
	}
	async directory(parent: string, kind: "fetch" | "graph"): Promise<string> {
		return mkdtemp(join(parent, `.${kind}-${process.pid}-`));
	}
	file(path: string): string {
		return `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	}
	// Cleanup is best effort: a read-only or unreadable cache must still open, so readiness can report not fetched.
	async #remove(path: string): Promise<void> {
		try {
			await rm(path, { recursive: true, force: true });
		} catch {}
	}
	async #sweep(directory: string, depth: number): Promise<void> {
		if (depth > 6) return;
		let entries: Dirent[];
		try {
			if (!(await lstat(directory)).isDirectory()) return;
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink() || entry.name.startsWith("entry-")) continue;
			const path = join(directory, entry.name);
			const pid =
				/^\.(?:fetch|graph|prune)-(\d+)-/.exec(entry.name)?.[1] ??
				/\.(\d+)\.[0-9a-f-]{36}\.tmp$/.exec(entry.name)?.[1];
			if (pid !== undefined && Number(pid) > 1) {
				if (!running(Number(pid))) await this.#remove(path);
				continue;
			}
			if (
				/^\.(?:fetch|graph|prune)-/.test(entry.name) ||
				/^\..+-[0-9a-f-]{36}\.json$/.test(entry.name) ||
				/\.[0-9a-f-]{36}\.tmp$/.test(entry.name)
			) {
				try {
					if ((await lstat(path)).mtimeMs < Date.now() - 86_400_000) await this.#remove(path);
				} catch {}
				continue;
			}
			if (entry.isDirectory()) await this.#sweep(path, depth + 1);
		}
	}
}

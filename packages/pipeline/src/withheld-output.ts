import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CacheLocation } from "./tool-provisioning.ts";

/** How long a kept output stays before a later run removes it. */
export const withheldOutputAge = 7 * 24 * 60 * 60 * 1000;

/**
 * What tools that ran unconfined printed, kept where only the reviewer can read it. Problem: such a tool can quote any
 * file the reviewer can read, so nothing it printed goes into a record, the JSON, or a pull request, and a broken tool
 * then says only that it broke. Solution: the whole of it goes into a file of mode 0600 under Melian's state directory,
 * and the local terminal names that file. The path is never stored.
 */
export class WithheldOutput {
	readonly directory: string;

	private constructor(directory: string) {
		this.directory = directory;
	}

	static async open(repoRoot: string, environment: NodeJS.ProcessEnv = process.env): Promise<WithheldOutput> {
		return new WithheldOutput(join((await CacheLocation.open(repoRoot, environment)).root, "withheld"));
	}

	/** Writes one run's output and returns the file, after removing files older than {@link withheldOutputAge}. */
	async keep(check: string, commit: string, text: string, now = Date.now()): Promise<string> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
		for (const name of await readdir(this.directory)) {
			const path = join(this.directory, name);
			if (now - (await stat(path)).mtimeMs > withheldOutputAge) await rm(path, { force: true });
		}
		const path = join(this.directory, `${check}-${commit.slice(0, 12)}-${now}-${process.pid}.log`);
		// Exclusive, so a file someone left at that name is never written through; the mode holds whatever the umask.
		await writeFile(path, text, { mode: 0o600, flag: "wx" });
		await chmod(path, 0o600);
		return path;
	}

	/** The files written at or after `time`, oldest first: what one command's runs kept. */
	async since(time: number): Promise<string[]> {
		let names: string[];
		try {
			names = await readdir(this.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const dated = await Promise.all(
			names.map(async (name) => ({
				path: join(this.directory, name),
				at: (await stat(join(this.directory, name))).mtimeMs,
			})),
		);
		return dated
			.filter(({ at }) => at >= time)
			.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path))
			.map(({ path }) => path);
	}
}

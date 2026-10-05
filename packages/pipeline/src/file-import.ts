import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ExternalFinding, type ExternalImport, type ExternalImporter } from "@melian-agent/core";
import { CompareError } from "./compare.ts";

/** The largest reviewer's file Melian reads. */
export const maxReviewerFileBytes = 4 * 1024 * 1024;

/**
 * Imports a local reviewer's findings from a JSON file: Codex's adversarial review output, or the external-finding shape
 * the agent that ran any other reviewer writes, as core's `ExternalFinding.fromFile` reads them. Melian never parses a
 * reviewer's prose.
 */
export class FileImporter implements ExternalImporter {
	/** `file:` and the path, relative to the repository when the file lies inside it. */
	readonly source: string;
	private readonly findings: readonly ExternalFinding[];

	private constructor(source: string, findings: readonly ExternalFinding[]) {
		this.source = source;
		this.findings = findings;
	}

	/**
	 * Reads and validates the file at `path`, resolved against `cwd`. Its source reference names it relative to
	 * `repoRoot` when it lies inside, so an import from another working directory names it alike. Throws
	 * {@link CompareError} `unreadable` for a file that cannot be read, is larger than {@link maxReviewerFileBytes}, or
	 * is not JSON, and core's `ComparisonError` `invalidFile` for JSON in neither shape.
	 */
	static async open(
		path: string,
		options: { readonly cwd: string; readonly repoRoot: string },
	): Promise<FileImporter> {
		const given = resolve(options.cwd, path);
		// The real path, since git reports the repository's: on macOS the temporary directory is a symlink.
		const absolute = await realpath(given).catch(() => given);
		const inside = relative(await realpath(options.repoRoot).catch(() => options.repoRoot), absolute);
		const outside = inside === "" || inside === ".." || inside.startsWith("../") || isAbsolute(inside);
		const named = outside ? absolute : inside;
		const unreadable = (why: string, cause?: unknown) =>
			new CompareError("unreadable", `Melian cannot read ${named}: ${why}`, { cause });
		const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
			throw unreadable(error.code === "ENOENT" ? "no such file" : error.message, error);
		});
		if (!info.isFile()) throw unreadable("it is not a file");
		if (info.size > maxReviewerFileBytes) throw unreadable(`it is larger than ${maxReviewerFileBytes} bytes`);
		const text = await readFile(absolute, "utf8").catch((error: Error) => {
			throw unreadable(error.message, error);
		});
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			throw unreadable(`it is not JSON: ${(error as Error).message}`, error);
		}
		const findings = ExternalFinding.fromFile(value, named);
		return new FileImporter(`file:${named}`, findings);
	}

	async import(): Promise<ExternalImport> {
		return { findings: this.findings, skippedBodies: 0 };
	}
}

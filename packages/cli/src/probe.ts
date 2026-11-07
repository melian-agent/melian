import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { visibleText } from "@melian-agent/core";
import {
	type CleanupOutcome,
	Probe,
	ProbeError,
	type ProbeFile,
	type ProbeResult,
	probeLimits,
} from "@melian-agent/pipeline";
import type { Io } from "./commands.ts";
import { git } from "./repository.ts";

/** The exit codes of `melian probe`: the probe exited 0, it ran and failed, or it could not run. */
export const probeExitCodes = { passed: 0, failed: 1, refused: 2 } as const;

const script = "probe.mjs";

// The directory's files, every regular file under it but the script, by their relative paths. A link or anything else
// is refused rather than followed, and every bound a probe takes is checked while reading, so a directory far over a
// bound is refused before it is all read into memory.
async function directoryFiles(root: string, at: string, files: ProbeFile[], total: { bytes: number }): Promise<void> {
	for (const name of await readdir(join(root, at))) {
		const path = at === "" ? name : `${at}/${name}`;
		const entry = await lstat(join(root, path));
		if (entry.isDirectory()) await directoryFiles(root, path, files, total);
		else if (!entry.isFile()) throw new ProbeError("invalidProbe", `${path} is neither a file nor a directory`);
		else if (entry.size > probeLimits.fileBytes)
			throw new ProbeError("invalidProbe", `${path} is larger than ${probeLimits.fileBytes} bytes`);
		else if (path !== script) {
			total.bytes += entry.size;
			if (total.bytes > probeLimits.fileBytes)
				throw new ProbeError("invalidProbe", `a probe's files hold at most ${probeLimits.fileBytes} bytes`);
			// Carried as bytes, so a binary fixture is not corrupted by a UTF-8 decode.
			files.push({ path, bytes: await readFile(join(root, path)) });
		}
		if (files.length > probeLimits.files)
			throw new ProbeError("invalidProbe", `a probe has at most ${probeLimits.files} files`);
	}
}

function status(result: ProbeResult, timeout: number): string {
	const seconds = timeout / 1000;
	if (result.timedOut) return `Probe: timed out after ${seconds} second${seconds === 1 ? "" : "s"}`;
	const ended = result.exitCode === null ? `ended by ${result.signal}` : `exited ${result.exitCode}`;
	return result.truncated ? `Probe: ${ended}; its output was cut at its limit` : `Probe: ${ended}`;
}

/**
 * Runs `<directory>/probe.mjs`, with the directory's other files beside it, under the sandbox, in the checkout's top
 * level. The head's code runs only on the reviewer's word, `--trust-head`, as `static.mutation`'s does for a range.
 */
export async function probe(
	io: Io,
	directory: string,
	options: { trustHead: boolean; timeout?: number; json: boolean },
): Promise<number> {
	const timeout = options.timeout ?? probeLimits.timeout.default;
	try {
		const root = resolve(io.cwd, directory);
		const files: ProbeFile[] = [];
		await directoryFiles(root, "", files, { bytes: 0 });
		const input = { script: await readFile(join(root, script), "utf8"), files };
		const opened = await Probe.open(input, {
			worktree: await git(io.cwd, ["rev-parse", "--show-toplevel"]),
			writer: options.trustHead
				? { trusted: true, by: "reviewer" }
				: {
						trusted: false,
						detail:
							"nothing git records says whose code the checkout is; pass --trust-head if you have read this code and want it probed",
					},
			trustWriters: true,
			timeout,
		});
		// close() runs whether or not the probe ran, and never throws for a cleanup failure, so it cannot replace the
		// result; it reports a leftover instead.
		let result: ProbeResult;
		let cleanup!: CleanupOutcome;
		try {
			result = await opened.run();
		} finally {
			cleanup = await opened.close();
		}
		// JSON escapes ASCII controls but not bidi or C1 controls, which can reorder or hide text in a terminal, so the
		// probe's text goes through visibleText first, as the plain output does.
		if (options.json)
			io.stdout(
				`${JSON.stringify({ ...result, output: visibleText(result.output), ...(result.error === undefined ? {} : { error: visibleText(result.error) }) })}\n`,
			);
		else {
			const lines = result.output.endsWith("\n") ? result.output.slice(0, -1) : result.output;
			if (result.output !== "") io.stdout(`${lines.split("\n").map(visibleText).join("\n")}\n`);
			io.stdout(`${status(result, timeout)}\n`);
		}
		if (!cleanup.removed)
			io.stderr(
				`melian: the probe's scratch could not be removed and was left at ${visibleText(cleanup.leftover)}: ${visibleText(cleanup.reason)}\n`,
			);
		return result.exitCode === 0 && !result.timedOut && !result.truncated && cleanup.removed
			? probeExitCodes.passed
			: probeExitCodes.failed;
	} catch (error) {
		if (!(error instanceof ProbeError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		io.stderr(`melian: ${visibleText(error instanceof Error ? error.message : String(error))}\n`);
		return probeExitCodes.refused;
	}
}

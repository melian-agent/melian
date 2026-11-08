import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
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

// Reads a file through one descriptor that refuses a link, so a swap after the directory was listed cannot redirect the
// read, and checks that descriptor, not the path, to be a regular file within the size bound. O_NONBLOCK keeps a FIFO
// swapped in from blocking the open; the descriptor's check then refuses it.
async function regularFile(root: string, path: string): Promise<Buffer> {
	const neither = new ProbeError("invalidProbe", `${path} is neither a file nor a directory`);
	const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
		(error: unknown) => {
			throw (error as NodeJS.ErrnoException).code === "ELOOP" ? neither : error;
		},
	);
	try {
		if (!(await handle.stat()).isFile()) throw neither;
		// Reads one byte past the bound at most, so a file that grew after its listing is refused, not read without end.
		const chunks: Buffer[] = [];
		for await (const chunk of handle.createReadStream({ end: probeLimits.fileBytes, autoClose: false }))
			chunks.push(chunk as Buffer);
		const bytes = Buffer.concat(chunks);
		if (bytes.length > probeLimits.fileBytes)
			throw new ProbeError("invalidProbe", `${path} is larger than ${probeLimits.fileBytes} bytes`);
		return bytes;
	} finally {
		await handle.close();
	}
}

// The directory's files, every regular file under it but the script, by their relative paths. A link or anything else
// is refused rather than followed, and every bound a probe takes is checked while reading, so a directory far over a
// bound is refused before it is all read into memory.
async function directoryFiles(root: string, at: string, files: ProbeFile[], total: { bytes: number }): Promise<void> {
	for (const name of await readdir(join(root, at))) {
		const path = at === "" ? name : `${at}/${name}`;
		const entry = await lstat(join(root, path));
		if (entry.isDirectory()) await directoryFiles(root, path, files, total);
		// A socket or device is refused before it is opened, since opening one can do more than read.
		else if (!entry.isFile()) throw new ProbeError("invalidProbe", `${path} is neither a file nor a directory`);
		else if (path !== script) {
			// Carried as bytes, so a binary fixture is not corrupted by a UTF-8 decode.
			const bytes = await regularFile(root, path);
			total.bytes += bytes.length;
			if (total.bytes > probeLimits.fileBytes)
				throw new ProbeError("invalidProbe", `a probe's files hold at most ${probeLimits.fileBytes} bytes`);
			files.push({ path, bytes });
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
		const input = { script: (await regularFile(root, script)).toString("utf8"), files };
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

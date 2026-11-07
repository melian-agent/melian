import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { visibleText } from "@melian-agent/core";
import { Probe, ProbeError, type ProbeFile, type ProbeResult, probeLimits } from "@melian-agent/pipeline";
import type { Io } from "./commands.ts";
import { git } from "./repository.ts";

/** The exit codes of `melian probe`: the probe exited 0, it ran and failed, or it could not run. */
export const probeExitCodes = { passed: 0, failed: 1, refused: 2 } as const;

const script = "probe.mjs";

// The directory's files, every regular file under it but the script, by their relative paths. A link or anything else
// is refused rather than followed, and reading stops at the bounds a probe takes.
async function directoryFiles(root: string, at = ""): Promise<ProbeFile[]> {
	const files: ProbeFile[] = [];
	for (const name of (await readdir(join(root, at))).sort()) {
		const path = at === "" ? name : `${at}/${name}`;
		const entry = await lstat(join(root, path));
		if (entry.isDirectory()) files.push(...(await directoryFiles(root, path)));
		else if (!entry.isFile()) throw new ProbeError("invalidProbe", `${path} is neither a file nor a directory`);
		else if (entry.size > probeLimits.fileBytes)
			throw new ProbeError("invalidProbe", `${path} is larger than ${probeLimits.fileBytes} bytes`);
		else if (path !== script) files.push({ path, text: await readFile(join(root, path), "utf8") });
		if (files.length > probeLimits.files)
			throw new ProbeError("invalidProbe", `a probe has at most ${probeLimits.files} files`);
	}
	return files;
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
		const input = { script: await readFile(join(root, script), "utf8"), files: await directoryFiles(root) };
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
		let result: ProbeResult;
		try {
			result = await opened.run();
		} finally {
			await opened.close();
		}
		if (options.json) io.stdout(`${JSON.stringify(result)}\n`);
		else {
			const lines = result.output.endsWith("\n") ? result.output.slice(0, -1) : result.output;
			if (result.output !== "") io.stdout(`${lines.split("\n").map(visibleText).join("\n")}\n`);
			io.stdout(`${status(result, timeout)}\n`);
		}
		return result.exitCode === 0 && !result.timedOut && !result.truncated
			? probeExitCodes.passed
			: probeExitCodes.failed;
	} catch (error) {
		if (!(error instanceof ProbeError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		io.stderr(`melian: ${visibleText(error instanceof Error ? error.message : String(error))}\n`);
		return probeExitCodes.refused;
	}
}

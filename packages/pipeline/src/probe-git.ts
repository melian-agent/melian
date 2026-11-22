import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

/**
 * Where a probe finds git: the git program a link in the probe's scratch names, and the paths it must read to run it,
 * or why git cannot run in a probe on this host.
 */
export type ProbeGit =
	| { readonly program?: string; readonly reads: readonly string[]; readonly noSystem?: true }
	| { readonly unavailable: string };

/** Asks the host a question by running `file` with `args`, outside any sandbox, and answers its standard output. */
export type HostAsk = (file: string, args: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

// No variable of the reviewer's reaches the answers, GIT_CONFIG_SYSTEM above all, since the probe's git sees none.
const askHost: HostAsk = async (file, args) =>
	(await execFileAsync(file, [...args], { env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" }, timeout: 10_000 }))
		.stdout;

/**
 * Where git lives for a probe on `platform`. On Linux it is among the system's programs, which a probe already reads.
 * On macOS `/usr/bin/git` is a launcher that cannot run in the sandbox, so the host is asked where the developer tools'
 * own git lives before the sandbox starts. A probe may then read that one program, which a link in its scratch puts on
 * its `PATH`, git's exec path, its `share/git-core` and its system configuration, each inside the developer directory
 * but the configuration, and none in the reviewer's home. The program's neighbours in the developer tools' `usr/bin` are
 * not granted. Where the configuration does not exist, `noSystem` tells the probe's git to skip it, since the sandbox
 * refuses an open of the absent file as not permitted, which git treats as fatal.
 */
export async function probeGit(
	platform: "darwin" | "linux",
	ask: HostAsk = askHost,
	home: string = homedir(),
): Promise<ProbeGit> {
	if (platform === "linux") return { reads: [] };
	try {
		const reviewer = realpathSync(home);
		const developer = real(await answer(ask, "xcode-select", ["-p"]));
		if (developer === sep || holds(developer, reviewer) || holds(reviewer, developer))
			return { unavailable: `the developer directory ${developer} is the root or shares the reviewer's home` };
		const git = real(await answer(ask, "xcrun", ["--find", "git"]));
		if (git === developer || !holds(developer, git) || !isExecutableFile(git))
			return {
				unavailable: `git's program ${git} is not an executable file inside the developer directory ${developer}`,
			};
		const exec = real(await answer(ask, git, ["--exec-path"]));
		const share = join(dirname(dirname(git)), "share", "git-core");
		const outside = [exec, share].find((path) => path === developer || !holds(developer, path));
		if (outside !== undefined)
			return { unavailable: `git's ${outside} lies outside the developer directory ${developer}` };
		const system = await answer(ask, git, ["var", "GIT_CONFIG_SYSTEM"]).catch((error: unknown) => {
			throw new Error(`git var GIT_CONFIG_SYSTEM did not answer, as git before 2.42 does not: ${message(error)}`);
		});
		if (!existsSync(system)) return { program: git, reads: [git, exec, share], noSystem: true };
		// A link at the configuration's path is followed to what it names, which the sandbox would read through it.
		const systemReal = real(system);
		const where = [system, systemReal].find(
			(path) => isDirectory(path) || holds(reviewer, path) || holds(path, reviewer),
		);
		if (where !== undefined)
			return { unavailable: `git's system configuration ${where} is not a file outside the home` };
		return { program: git, reads: [...new Set([git, exec, share, system, systemReal])] };
	} catch (error) {
		return { unavailable: `git cannot be found for a probe: ${message(error)}` };
	}
}

// The single absolute path the host answered.
async function answer(ask: HostAsk, file: string, args: readonly string[]): Promise<string> {
	const text = await ask(file, args);
	const path = text.endsWith("\n") ? text.slice(0, -1) : text;
	if (path.includes("\n") || !isAbsolute(path))
		throw new Error(`${[file, ...args].join(" ")} answered ${JSON.stringify(text)}, not one absolute path`);
	return path;
}

function real(path: string): string {
	return realpathSync.native(path);
}

// Whether `outer` is `inner` or a directory above it.
function holds(outer: string, inner: string): boolean {
	const path = relative(outer, inner);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isExecutableFile(path: string): boolean {
	const stat = statSync(path);
	return stat.isFile() && (stat.mode & 0o111) !== 0;
}

function isDirectory(path: string): boolean {
	return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

import { rmdir } from "node:fs/promises";
import { backgroundContext } from "./harness.ts";
import { nodeInstallation, type Sandbox, type SandboxPaths } from "./sandbox.ts";
import type { Run } from "./static.ts";

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// Housekeeping stays confined too: lstat alone cannot stop a directory swap between the check and recursive removal.
export const mutationHousekeeping = `
const fs = require("node:fs");
const path = require("node:path");
const [scratch, target, operation, content, limit] = JSON.parse(process.argv[1]);
const relative = path.relative(scratch, target);
function inspect(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error("symlink " + file);
  return stat;
}
function parents() {
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("outside scratch " + target);
  inspect(scratch);
  let at = scratch;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    at = path.join(at, part);
    if (!inspect(at).isDirectory()) throw new Error("non-directory " + at);
  }
}
function openFile(flags) {
  if (process.platform === "darwin") return fs.openSync(target, (flags & ~fs.constants.O_NOFOLLOW) | 0x20000000);
  const directories = [];
  try {
    let directory = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    directories.push(directory);
    const components = target.split("/").filter(Boolean);
    for (const part of components.slice(0, -1)) {
      directory = fs.openSync("/proc/self/fd/" + directory + "/" + part, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      directories.push(directory);
    }
    return fs.openSync("/proc/self/fd/" + directory + "/" + components.at(-1), flags | fs.constants.O_NOFOLLOW);
  } finally { for (const directory of directories) fs.closeSync(directory); }
}
try {
  parents();
  let text;
  let missing = false;
  if (operation === "write") {
    const file = openFile(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(file).isFile()) throw new Error("non-file " + target);
      fs.ftruncateSync(file, 0);
      fs.writeFileSync(file, content);
    } finally { fs.closeSync(file); }
  } else if (operation === "remove") {
    const entry = fs.lstatSync(target, { throwIfNoEntry: false });
    if (entry) inspect(target);
    fs.rmSync(target, { recursive: true, force: true });
  } else if (operation === "clean") {
    for (const name of fs.readdirSync(scratch)) fs.rmSync(path.join(scratch, name), { recursive: true, force: true });
  } else if (operation === "read") {
    const entry = fs.lstatSync(target, { throwIfNoEntry: false });
    if (entry === undefined) missing = true;
    else {
      if (!entry.isFile()) throw new Error("non-file " + target);
      const file = openFile(fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
      try {
        if (!fs.fstatSync(file).isFile()) throw new Error("non-file " + target);
        const buffer = Buffer.alloc(limit);
        let bytes = 0;
        while (bytes < limit) {
          const count = fs.readSync(file, buffer, bytes, limit - bytes, null);
          if (count === 0) break;
          bytes += count;
        }
        if (bytes >= limit) throw Object.assign(new Error("exceeds output limit " + limit), { code: "outputTooLarge" });
        text = buffer.subarray(0, bytes).toString("utf8");
      } finally { fs.closeSync(file); }
    }
  } else throw new Error("unknown operation");
  process.stdout.write(JSON.stringify({ ok: true, text, missing }));
} catch (error) {
  if (operation === "read" && error.code === "ENOENT") process.stdout.write(JSON.stringify({ missing: true }));
  else {
    process.stdout.write(JSON.stringify({ error: "refused " + target + ": " + (error.code || error.message), code: error.code }));
    process.exitCode = 1;
  }
}
`;

export class MutationScratch {
	readonly #run: Run;
	readonly #sandbox: Sandbox;
	readonly #paths: SandboxPaths;
	readonly #profile: string | undefined;

	private constructor(run: Run, sandbox: Sandbox, paths: SandboxPaths, profile: string | undefined) {
		this.#run = run;
		this.#sandbox = sandbox;
		this.#paths = paths;
		this.#profile = profile;
	}

	static open(run: Run, scratch: string, sandbox: Sandbox, installs: readonly string[]): MutationScratch {
		const paths = { scratch, worktree: scratch, installs, node: nodeInstallation() };
		return new MutationScratch(run, sandbox, paths, sandbox.profile(paths));
	}

	async #execute(operation: string, target: string, content = "", limit = 0): Promise<string | undefined> {
		const command = `${quote(process.execPath)} -e ${quote(mutationHousekeeping)} ${quote(JSON.stringify([this.#paths.scratch, target, operation, content, limit]))}`;
		let output = "";
		const result = await this.#run.input.env.exec(
			this.#sandbox.command(command, this.#paths, "", this.#profile),
			{
				inheritEnv: false,
				env: { ...this.#sandbox.environment(), HOME: this.#paths.scratch, TMPDIR: this.#paths.scratch },
				timeout: 60,
				onOutput: (text) => {
					output += text;
				},
			},
			backgroundContext,
		);
		if (!result.ok || result.value.exitCode !== 0) {
			if (output.includes('"code":"outputTooLarge"'))
				throw this.#run.fail("outputTooLarge", `scratch output ${target} exceeds its ${limit}-byte limit`);
			throw this.#run.fail("toolFailed", `scratch operation refused ${target}: ${output}`);
		}
		return (JSON.parse(output) as { text?: string }).text;
	}

	async write(path: string, content: string): Promise<void> {
		await this.#execute("write", path, content);
	}

	async remove(path: string): Promise<void> {
		await this.#execute("remove", path);
	}

	async read(path: string, limit: number): Promise<string | undefined> {
		return this.#execute("read", path, "", limit);
	}

	async close(): Promise<void> {
		await this.#execute("clean", this.#paths.scratch);
		// rmdir never follows its final component; recursive deletion happened inside the sandbox.
		await rmdir(this.#paths.scratch);
	}
}

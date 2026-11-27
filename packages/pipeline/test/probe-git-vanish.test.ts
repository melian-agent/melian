import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { probeGit } from "../src/probe-git.ts";

// A system configuration that exists when the lookup asks and is gone when it checks what it is, as a removal between
// the two would leave it. Only lstat of that one path answers as if it had vanished.
const vanished = vi.hoisted(() => ({ path: "" }));

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		lstatSync: ((path: string, options?: { throwIfNoEntry?: boolean }) => {
			if (path === vanished.path && options?.throwIfNoEntry === false) return undefined;
			if (path === vanished.path)
				throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: "ENOENT" });
			return fs.lstatSync(path, options);
		}) as typeof fs.lstatSync,
	};
});

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-git-vanish-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

it("leaves git unavailable, granting nothing, when the system configuration vanishes before it is checked", async () => {
	const developer = join(root, "CommandLineTools");
	const git = join(developer, "usr", "bin", "git");
	const exec = join(developer, "usr", "libexec", "git-core");
	const home = join(root, "home");
	const config = join(root, "gitconfig");
	for (const path of [join(developer, "usr", "bin"), exec, join(developer, "usr", "share", "git-core"), home])
		mkdirSync(path, { recursive: true });
	writeFileSync(git, "", { mode: 0o755 });
	writeFileSync(config, "");
	vanished.path = config;
	const answers = new Map([
		["xcode-select -p", developer],
		["xcrun --find git", git],
		[`${git} --exec-path`, exec],
		[`${git} --version`, "git version 2.39.5 (Apple Git-154)"],
		[`${git} var GIT_CONFIG_SYSTEM`, config],
	]);
	const ask = async (file: string, args: readonly string[]) => {
		const answer = answers.get([file, ...args].join(" "));
		if (answer === undefined) throw new Error(`unexpected question: ${[file, ...args].join(" ")}`);
		return `${answer}\n`;
	};
	expect(await probeGit("darwin", ask, home)).toEqual({
		unavailable: expect.stringContaining("git cannot be found for a probe: ENOENT"),
	});
});

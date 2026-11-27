import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askHost, gitVersionLimit, type HostAsk, probeGit } from "../src/probe-git.ts";

// The attacking review of what the macOS git lookup lets a probe read. Each case gives the lookup a host whose answers
// would widen the read past the developer tools and git's own configuration, and expects no read at all.

function folds(): boolean {
	const at = mkdtempSync(join(tmpdir(), "melian-probe-git-case-"));
	try {
		mkdirSync(join(at, "case"));
		return existsSync(join(at, "CASE"));
	} finally {
		rmSync(at, { recursive: true, force: true });
	}
}

const foldsCase = folds();

let root: string;
let developer: string;
let home: string;
let git: string;
let config: string;
const version = "git version 2.39.5 (Apple Git-154)";

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-git-")));
	developer = join(root, "CommandLineTools");
	home = join(root, "Users", "reviewer");
	git = join(developer, "usr", "bin", "git");
	config = join(root, "etc", "gitconfig");
	for (const path of [
		dirname(git),
		join(developer, "usr", "libexec", "git-core"),
		join(developer, "usr", "share", "git-core"),
		home,
		dirname(config),
	])
		mkdirSync(path, { recursive: true });
	writeFileSync(git, "", { mode: 0o755 });
	writeFileSync(config, "");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// A host that answers only the four questions the lookup asks, each with what `answers` gives it and the newline a
// command ends its answer with.
function host(answers: Partial<Record<"developer" | "git" | "exec" | "version" | "config", string | Error>> = {}): {
	ask: HostAsk;
	asked: string[];
} {
	const asked: string[] = [];
	const answer = (value: string | Error) =>
		value instanceof Error ? Promise.reject(value) : Promise.resolve(`${value}\n`);
	return {
		asked,
		ask: (file, args) => {
			const question = [file, ...args].join(" ");
			asked.push(question);
			const named = typeof answers.git === "string" ? answers.git : git;
			let real = "";
			try {
				real = realpathSync(named);
			} catch {}
			if (question === "xcode-select -p") return answer(answers.developer ?? developer);
			if (question === "xcrun --find git") return answer(answers.git ?? git);
			if (question === `${real} --exec-path`)
				return answer(answers.exec ?? join(developer, "usr", "libexec", "git-core"));
			if (question === `${real} --version`) return answer(answers.version ?? version);
			if (question === `${real} var GIT_CONFIG_SYSTEM`) return answer(answers.config ?? config);
			return Promise.reject(new Error(`unexpected question: ${question}`));
		},
	};
}

describe("probeGit", () => {
	it("grants git's one program, its exec path, its own files and its system configuration, and nothing else", async () => {
		expect(await probeGit("darwin", host().ask, home)).toEqual({
			program: git,
			version,
			reads: [
				git,
				join(developer, "usr", "libexec", "git-core"),
				join(developer, "usr", "share", "git-core"),
				config,
			],
		});
	});

	it("asks the git that xcrun names, by its real path", async () => {
		const tools = join(developer, "usr", "bin", "tools");
		mkdirSync(tools);
		symlinkSync(git, join(tools, "git"));
		const asked = host({ git: join(tools, "git") });
		await probeGit("darwin", asked.ask, home);
		expect(asked.asked).toEqual([
			"xcode-select -p",
			"xcrun --find git",
			`${git} --exec-path`,
			`${git} --version`,
			`${git} var GIT_CONFIG_SYSTEM`,
		]);
	});

	it("grants a system configuration behind a link at its path and at its real one, and not the directory", async () => {
		const real = join(root, "private", "etc");
		mkdirSync(real, { recursive: true });
		writeFileSync(join(real, "gitconfig"), "");
		symlinkSync(real, join(root, "etc-link"));
		const found = await probeGit("darwin", host({ config: join(root, "etc-link", "gitconfig") }).ask, home);
		expect(found).toEqual({
			program: git,
			version,
			reads: [
				git,
				join(developer, "usr", "libexec", "git-core"),
				join(developer, "usr", "share", "git-core"),
				join(root, "etc-link", "gitconfig"),
				join(real, "gitconfig"),
			],
		});
	});

	it("grants no system configuration that does not exist, and tells git to skip it", async () => {
		rmSync(config);
		// The sandbox refuses an open of the absent file as not permitted, which git treats as fatal, as no such file is not.
		expect(await probeGit("darwin", host().ask, home)).toEqual({
			program: git,
			version,
			reads: [git, join(developer, "usr", "libexec", "git-core"), join(developer, "usr", "share", "git-core")],
			noSystem: true,
		});
	});

	it("tells git to skip a system configuration behind a link to nothing, and grants neither path", async () => {
		rmSync(config);
		symlinkSync(join(root, "etc", "absent"), config);
		expect(await probeGit("darwin", host().ask, home)).toMatchObject({
			reads: [git, join(developer, "usr", "libexec", "git-core"), join(developer, "usr", "share", "git-core")],
			noSystem: true,
		});
	});

	it("asks nothing on Linux, where git lives among the system's programs", async () => {
		const asked = host();
		expect(await probeGit("linux", asked.ask, home)).toEqual({ reads: [] });
		expect(asked.asked).toEqual([]);
	});

	it("keys git by its whole trimmed answer to --version, at the bound of 200 characters", async () => {
		const longest = `git version ${"9".repeat(gitVersionLimit - "git version ".length)}`;
		expect(longest).toHaveLength(200);
		expect(await probeGit("darwin", host({ version: `  ${longest} ` }).ask, home)).toMatchObject({
			program: git,
			version: longest,
		});
	});

	it.each([
		["one character past the bound", `git version ${"9".repeat(gitVersionLimit - "git version ".length + 1)}`],
		["nothing", ""],
		["two lines", "git version 2.39.5\nApple Git-154"],
		["a control character", "git version 2.39.5\u0007"],
		["a failure", new Error("git --version exited 1")],
	])("leaves git unavailable where --version answers %s", async (_, answer) => {
		expect(await probeGit("darwin", host({ version: answer }).ask, home)).toEqual({
			unavailable: expect.stringContaining("git cannot be found for a probe"),
		});
	});

	describe("refuses a host whose answer would widen the read", () => {
		const refused = { unavailable: expect.any(String) };

		it("a developer directory at the reviewer's home", async () => {
			mkdirSync(join(home, "usr", "bin"), { recursive: true });
			writeFileSync(join(home, "usr", "bin", "git"), "", { mode: 0o755 });
			const found = await probeGit(
				"darwin",
				host({ developer: home, git: join(home, "usr", "bin", "git") }).ask,
				home,
			);
			expect(found).toEqual(refused);
			expect(found).toEqual({ unavailable: expect.stringContaining("home") });
		});

		it("a developer directory inside the reviewer's home", async () => {
			const inside = join(home, "Applications", "Xcode.app", "Contents", "Developer");
			mkdirSync(join(inside, "usr", "bin"), { recursive: true });
			writeFileSync(join(inside, "usr", "bin", "git"), "", { mode: 0o755 });
			const ask = host({ developer: inside, git: join(inside, "usr", "bin", "git") }).ask;
			expect(await probeGit("darwin", ask, home)).toEqual(refused);
		});

		// Only a filesystem that folds case can name the home in another case, so Linux skips this and the macOS job runs it.
		it.runIf(foldsCase)("a developer directory inside the reviewer's home, named in another case", async () => {
			const inside = join(home, "Applications", "Xcode.app", "Contents", "Developer");
			for (const path of [
				join(inside, "usr", "bin"),
				join(inside, "usr", "libexec", "git-core"),
				join(inside, "usr", "share", "git-core"),
			])
				mkdirSync(path, { recursive: true });
			writeFileSync(join(inside, "usr", "bin", "git"), "", { mode: 0o755 });
			const ask = host({
				developer: inside,
				git: join(inside, "usr", "bin", "git"),
				exec: join(inside, "usr", "libexec", "git-core"),
			}).ask;
			expect(await probeGit("darwin", ask, join(root, "users", "REVIEWER"))).toEqual({
				unavailable: expect.stringContaining("shares the reviewer's home"),
			});
		});

		it("a developer directory that holds the reviewer's home", async () => {
			const inner = join(developer, "usr", "bin", "home");
			mkdirSync(inner);
			expect(await probeGit("darwin", host().ask, inner)).toEqual(refused);
		});

		it("a developer directory at the root", async () => {
			expect(await probeGit("darwin", host({ developer: "/" }).ask, home)).toEqual(refused);
		});

		it("a developer directory that does not exist", async () => {
			expect(await probeGit("darwin", host({ developer: join(root, "absent") }).ask, home)).toEqual(refused);
		});

		it("a git outside the developer directory, such as one on the reviewer's PATH", async () => {
			const other = join(root, "opt", "bin", "git");
			mkdirSync(dirname(other), { recursive: true });
			writeFileSync(other, "", { mode: 0o755 });
			expect(await probeGit("darwin", host({ git: other }).ask, home)).toEqual(refused);
		});

		it("a git inside the developer directory that links outside it", async () => {
			const other = join(root, "opt", "bin", "git");
			mkdirSync(dirname(other), { recursive: true });
			writeFileSync(other, "", { mode: 0o755 });
			const link = join(developer, "usr", "bin", "linked-git");
			symlinkSync(other, link);
			expect(await probeGit("darwin", host({ git: link }).ask, home)).toEqual(refused);
		});

		it("a git at the developer directory's top, whose share directory would lie outside it", async () => {
			const top = join(developer, "git");
			writeFileSync(top, "", { mode: 0o755 });
			expect(await probeGit("darwin", host({ git: top }).ask, home)).toEqual(refused);
		});

		it("an exec path outside the developer directory", async () => {
			expect(await probeGit("darwin", host({ exec: home }).ask, home)).toEqual(refused);
			expect(await probeGit("darwin", host({ exec: join(root, "etc") }).ask, home)).toEqual(refused);
		});

		it("an exec path at the developer directory's parent", async () => {
			expect(await probeGit("darwin", host({ exec: root }).ask, home)).toEqual(refused);
		});

		it("an exec path inside the developer directory that links outside it", async () => {
			const link = join(developer, "usr", "libexec", "linked-core");
			symlinkSync(home, link);
			expect(await probeGit("darwin", host({ exec: link }).ask, home)).toEqual(refused);
		});

		it("a share directory inside the developer directory that links outside it", async () => {
			const share = join(developer, "usr", "share", "git-core");
			rmSync(share, { recursive: true });
			symlinkSync(home, share);
			expect(await probeGit("darwin", host().ask, home)).toEqual(refused);
		});

		it("a share directory whose parent links outside the developer directory", async () => {
			const outside = join(root, "elsewhere");
			mkdirSync(join(outside, "git-core"), { recursive: true });
			rmSync(join(developer, "usr", "share"), { recursive: true });
			symlinkSync(outside, join(developer, "usr", "share"));
			expect(await probeGit("darwin", host().ask, home)).toEqual(refused);
		});

		it("a share directory that does not exist", async () => {
			rmSync(join(developer, "usr", "share"), { recursive: true });
			expect(await probeGit("darwin", host().ask, home)).toEqual(refused);
		});

		it("a git program that is not executable", async () => {
			chmodSync(git, 0o644);
			expect(await probeGit("darwin", host().ask, home)).toEqual({
				unavailable: expect.stringContaining("is not an executable file inside the developer directory"),
			});
		});

		it("a git program that is a directory", async () => {
			rmSync(git);
			mkdirSync(git);
			expect(await probeGit("darwin", host().ask, home)).toEqual(refused);
		});

		it("a git program at the developer directory itself", async () => {
			expect(await probeGit("darwin", host({ git: developer }).ask, home)).toEqual(refused);
		});

		it("an exec path at the developer directory itself", async () => {
			expect(await probeGit("darwin", host({ exec: developer }).ask, home)).toEqual(refused);
		});

		it("a system configuration inside the reviewer's home", async () => {
			writeFileSync(join(home, ".gitconfig"), "");
			expect(await probeGit("darwin", host({ config: join(home, ".gitconfig") }).ask, home)).toEqual(refused);
		});

		it("a system configuration behind a link into the reviewer's home", async () => {
			writeFileSync(join(home, ".gitconfig"), "");
			symlinkSync(home, join(root, "etc-link"));
			const ask = host({ config: join(root, "etc-link", ".gitconfig") }).ask;
			expect(await probeGit("darwin", ask, home)).toEqual(refused);
		});

		it("a system configuration that links to a file in the reviewer's home", async () => {
			writeFileSync(join(home, ".netrc"), "");
			symlinkSync(join(home, ".netrc"), join(root, "etc", "linked"));
			expect(await probeGit("darwin", host({ config: join(root, "etc", "linked") }).ask, home)).toEqual(refused);
		});

		it("a system configuration that links to a directory", async () => {
			symlinkSync(join(root, "Users"), join(root, "etc", "linked"));
			expect(await probeGit("darwin", host({ config: join(root, "etc", "linked") }).ask, home)).toEqual(refused);
		});

		it("a system configuration that names a directory", async () => {
			expect(await probeGit("darwin", host({ config: join(root, "etc") }).ask, home)).toEqual(refused);
		});

		it("a system configuration at the root", async () => {
			expect(await probeGit("darwin", host({ config: "/" }).ask, home)).toEqual(refused);
		});

		it("an answer that is not an absolute path", async () => {
			expect(await probeGit("darwin", host({ config: "etc/gitconfig" }).ask, home)).toEqual(refused);
			expect(await probeGit("darwin", host({ developer: "CommandLineTools" }).ask, home)).toEqual(refused);
		});

		it("an answer of more than one line", async () => {
			expect(await probeGit("darwin", host({ config: `${config}\n${home}` }).ask, home)).toEqual(refused);
			expect(await probeGit("darwin", host({ developer: `${developer}\n/` }).ask, home)).toEqual({
				unavailable: expect.stringContaining(`xcode-select -p answered ${JSON.stringify(`${developer}\n/\n`)}`),
			});
		});

		it("an empty answer", async () => {
			expect(await probeGit("darwin", host({ config: "" }).ask, home)).toEqual(refused);
		});
	});

	describe("asks the host with none of the reviewer's variables", () => {
		it("gives the command only its own PATH and HOME", async () => {
			expect(await askHost("/usr/bin/env", [])).toBe("PATH=/usr/bin:/bin\nHOME=/var/empty\n");
		});

		it("passes the command its arguments", async () => {
			expect(await askHost("/bin/echo", ["one", "two"])).toBe("one two\n");
		});
	});

	describe("says why when the host cannot answer", () => {
		it("a git too old to name its system configuration", async () => {
			const ask = host({ config: new Error("usage: git var (-l | <variable>)") }).ask;
			expect(await probeGit("darwin", ask, home)).toEqual({
				unavailable: expect.stringContaining("git var GIT_CONFIG_SYSTEM"),
			});
		});

		it("no developer tools", async () => {
			const ask = host({
				developer: new Error("xcode-select: error: unable to get active developer directory"),
			}).ask;
			expect(await probeGit("darwin", ask, home)).toEqual({
				unavailable: expect.stringContaining("unable to get active developer directory"),
			});
		});

		it("no git among them", async () => {
			const ask = host({ git: new Error('xcrun: error: unable to find utility "git"') }).ask;
			expect(await probeGit("darwin", ask, home)).toEqual({
				unavailable: expect.stringContaining("unable to find utility"),
			});
		});
	});
});

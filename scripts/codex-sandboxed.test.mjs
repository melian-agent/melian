import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "codex-sandboxed.sh");
const git = (cwd, ...args) =>
	execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });

describe.skipIf(process.platform !== "darwin")("codex-sandboxed.sh --print-profile", () => {
	let root;
	let main;
	let linked;
	let home;
	let admin;

	const profile = (cwd) =>
		execFileSync(script, ["--print-profile", cwd], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, TMPDIR: join(root, "tmp") },
		});
	const block = (text, head) => {
		const start = text.indexOf(`(${head}\n`);
		return text.slice(start, text.indexOf("\n)", start));
	};

	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "codex-sandboxed-")));
		main = join(root, "main");
		linked = join(root, "linked");
		home = join(root, "home");
		mkdirSync(join(root, "tmp"));
		mkdirSync(main);
		git(main, "init", "-q");
		git(main, "commit", "-q", "--allow-empty", "-m", "init");
		git(main, "worktree", "add", "-q", linked);
		admin = join(main, ".git", "worktrees", "linked");
		for (const dir of ["sessions", "log", "hooks"]) mkdirSync(join(home, ".codex", dir), { recursive: true });
		writeFileSync(join(home, ".codex", "config.toml"), "");
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("allows only the git state a commit needs, for a linked worktree", () => {
		const allow = block(profile(linked), "allow file-write*");
		for (const path of ["objects", "refs", "logs"]) expect(allow).toContain(`(subpath "${main}/.git/${path}")`);
		expect(allow).toContain(`(literal "${main}/.git/packed-refs")`);
		expect(allow).toContain(`(literal "${main}/.git/packed-refs.lock")`);
		expect(allow).toContain(`(subpath "${admin}")`);
		expect(allow).toContain(`(subpath "${linked}")`);
		expect(allow).not.toContain(`"${main}/.git")`);
		expect(allow).not.toContain(`${main}/.git/hooks`);
		expect(allow).not.toContain(`${main}/.git/config`);
		expect(allow).not.toContain(`${main}/.git/info`);
	});

	it("allows top-level state files, not the directory, for the main checkout", () => {
		const allow = block(profile(main), "allow file-write*");
		expect(allow).toContain(`(literal "${main}/.git/index")`);
		expect(allow).toContain(`(literal "${main}/.git/HEAD")`);
		expect(allow).not.toContain(`(subpath "${main}/.git")`);
		expect(allow).not.toContain(`${main}/.git/config`);
	});

	it("allows only the Codex runtime paths that exist, never the home directory", () => {
		const allow = block(profile(linked), "allow file-write*");
		expect(allow).toContain(`(subpath "${home}/.codex/sessions")`);
		expect(allow).toContain(`(subpath "${home}/.codex/log")`);
		expect(allow).not.toContain(`(subpath "${home}/.codex")`);
		expect(allow).not.toContain(`${home}/.codex/config.toml`);
		expect(allow).not.toContain(`${home}/.codex/hooks`);
		expect(allow).not.toContain(".config/gh");
		expect(allow).not.toContain("Library/Caches");
		expect(allow).not.toContain(".cache");
	});

	it("denies writes to hooks, config, info, and Codex's config after the allow", () => {
		const text = profile(linked);
		const deny = block(text, "deny file-write*");
		for (const path of [`(subpath "${main}/.git/hooks")`, `(subpath "${main}/.git/info")`, `(literal "${main}/.git/config")`, `(literal "${main}/.git/config.lock")`, `(literal "${admin}/config.worktree")`, `(literal "${linked}/.git")`, `(literal "${home}/.codex/config.toml")`, `(literal "${home}/.codex/auth.json")`, `(subpath "${home}/.codex/hooks")`]) {
			expect(deny).toContain(path);
		}
		expect(text.indexOf("(deny file-write*")).toBeGreaterThan(text.indexOf("(allow file-write*"));
	});

	it("refuses an empty prompt instead of running Codex", () => {
		const prompt = join(root, "empty.md");
		writeFileSync(prompt, "\n");
		expect(() => execFileSync(script, [linked, "model", prompt], { stdio: "pipe" })).toThrow(/prompt file is empty/);
	});

	it("denies reads of credentials and .env files, but not Codex's auth.json", () => {
		const text = profile(linked);
		const deny = block(text, "deny file-read*");
		for (const path of [`(subpath "${home}/.ssh")`, `(literal "${home}/.pi/agent/auth.json")`, `(literal "${home}/.npmrc")`, `(literal "${home}/.config/gh/hosts.yml")`, `(literal "${linked}/.env")`, `(literal "${main}/.env")`]) {
			expect(deny).toContain(path);
		}
		expect(deny).not.toContain(".codex/auth.json");
		expect(text.indexOf("(deny file-read*")).toBeGreaterThan(text.indexOf("(allow file-read*)"));
	});
});

describe("codex-sandboxed.sh argument checks", () => {
	it("prints usage and exits 64 without a prompt file", () => {
		let status;
		let stderr = "";
		try {
			execFileSync(script, ["/tmp", "model"], { stdio: "pipe" });
		} catch (error) {
			status = error.status;
			stderr = String(error.stderr);
		}
		expect(status).toBe(64);
		expect(stderr).toContain("usage: codex-sandboxed.sh");
	});
});

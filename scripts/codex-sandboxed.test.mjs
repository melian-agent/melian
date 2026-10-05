import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "codex-sandboxed.sh");
const git = (cwd, ...args) =>
	execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });

const sandboxExec = existsSync("/usr/bin/sandbox-exec");

const failure = (fn) => {
	try {
		fn();
	} catch (error) {
		return { status: error.status, stderr: String(error.stderr) };
	}
	return { status: 0, stderr: "" };
};

describe.skipIf(process.platform !== "darwin")("codex-sandboxed.sh profile", () => {
	let root;
	let main;
	let linked;
	let home;
	let run;
	let admin;

	const env = () => ({ ...process.env, HOME: home, TMPDIR: join(root, "tmp") });
	const profile = (cwd) => execFileSync(script, ["--print-profile", cwd, run, run], { encoding: "utf8", env: env() });
	const block = (text, head) => {
		const start = text.indexOf(`(${head}\n`);
		return text.slice(start, text.indexOf("\n)", start));
	};

	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "codex-sandboxed-")));
		main = join(root, "main");
		linked = join(root, "linked");
		home = join(root, "home");
		run = join(root, "tmp", "codex-run");
		mkdirSync(run, { recursive: true });
		mkdirSync(main);
		git(main, "init", "-q");
		git(main, "commit", "-q", "--allow-empty", "-m", "init");
		git(main, "worktree", "add", "-q", linked);
		admin = join(main, ".git", "worktrees", "linked");
		for (const dir of ["sessions", "log", "hooks"]) mkdirSync(join(home, ".codex", dir), { recursive: true });
		writeFileSync(join(home, ".codex", "config.toml"), "");
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("allows only the git state a commit needs, as literal files in the administrative directory", () => {
		const allow = block(profile(linked), "allow file-write*");
		for (const path of ["objects", "refs", "logs"]) expect(allow).toContain(`(subpath "${main}/.git/${path}")`);
		expect(allow).toContain(`(literal "${main}/.git/packed-refs")`);
		for (const file of ["HEAD", "index", "index.lock", "ORIG_HEAD", "MERGE_MSG", "COMMIT_EDITMSG", "gc.pid"]) {
			expect(allow).toContain(`(literal "${admin}/${file}")`);
		}
		for (const dir of ["logs", "rebase-merge", "rebase-apply"])
			expect(allow).toContain(`(subpath "${admin}/${dir}")`);
		expect(allow).toContain(`(subpath "${linked}")`);
		expect(allow).not.toContain(`(subpath "${admin}")`);
		expect(allow).not.toContain(`"${main}/.git")`);
		for (const path of ["hooks", "config", "info", "commondir", "gitdir"])
			expect(allow).not.toContain(`/.git/${path}`);
	});

	it("allows the per-run directory, never /private/tmp, /private/var/folders, or ~/.npm", () => {
		const allow = block(profile(linked), "allow file-write*");
		expect(allow).toContain(`(subpath "${run}")`);
		expect(allow).not.toContain('"/private/tmp"');
		expect(allow).not.toContain('"/private/var/folders"');
		expect(allow).not.toContain(".npm");
	});

	it("lists each allowed entry once", () => {
		const lines = block(profile(linked), "allow file-write*").split("\n");
		expect(new Set(lines).size).toBe(lines.length);
	});

	it("allows the named Codex runtime paths, never the home directory or its secrets and caches", () => {
		const allow = block(profile(linked), "allow file-write*");
		expect(allow).toContain(`(subpath "${home}/.codex/sessions")`);
		expect(allow).toContain(`(subpath "${home}/.codex/log")`);
		expect(allow).not.toContain(`(subpath "${home}/.codex")`);
		for (const path of ["config.toml", "hooks", "shell_snapshots", "memories", ".tmp"]) {
			expect(allow).not.toContain(`${home}/.codex/${path}`);
		}
		expect(allow).not.toContain(".config/gh");
		expect(allow).not.toContain("Library/Caches");
	});

	it("denies writes to hooks, config, info, pointer files, and Codex's config after the allow", () => {
		const text = profile(linked);
		const deny = block(text, "deny file-write*");
		for (const path of [
			`(subpath "${main}/.git/hooks")`,
			`(subpath "${main}/.git/info")`,
			`(literal "${main}/.git/config")`,
			`(literal "${main}/.git/config.lock")`,
			`(literal "${admin}/commondir")`,
			`(literal "${admin}/gitdir")`,
			`(literal "${admin}/locked")`,
			`(literal "${admin}/config.worktree")`,
			`(literal "${linked}/.git")`,
			`(literal "${home}/.codex/config.toml")`,
			`(literal "${home}/.codex/auth.json")`,
			`(subpath "${home}/.codex/hooks")`,
		]) {
			expect(deny).toContain(path);
		}
		expect(text.indexOf("(deny file-write*")).toBeGreaterThan(text.indexOf("(allow file-write*"));
	});

	it("denies reads of credentials and .env files, but not Codex's auth.json", () => {
		const text = profile(linked);
		const deny = block(text, "deny file-read*");
		for (const path of [
			`(subpath "${home}/.ssh")`,
			`(literal "${home}/.pi/agent/auth.json")`,
			`(literal "${home}/.npmrc")`,
			`(literal "${linked}/.env")`,
			`(literal "${main}/.env")`,
		]) {
			expect(deny).toContain(path);
		}
		expect(deny).not.toContain(".codex/auth.json");
		expect(deny).not.toContain(".config/gh");
		expect(text.indexOf("(deny file-read*")).toBeGreaterThan(text.indexOf("(allow file-read*)"));
	});

	it("refuses the main checkout, where the worktree allowance would cover .git", () => {
		const refused = failure(() => profile(main));
		expect(refused.status).toBe(64);
		expect(refused.stderr).toContain("not a linked worktree");
		const prompt = join(root, "prompt.md");
		writeFileSync(prompt, "do it\n");
		const ran = failure(() => execFileSync(script, [main, "model", prompt], { stdio: "pipe", env: env() }));
		expect(ran.status).toBe(64);
		expect(ran.stderr).toContain("not a linked worktree");
	});

	it("refuses a path holding a quote or backslash, which would break out of the profile", () => {
		for (const name of ['a"b', "a\\b"]) {
			const odd = join(root, name);
			git(main, "worktree", "add", "-q", "--detach", odd);
			const refused = failure(() => profile(odd));
			expect(refused.status).toBe(64);
			expect(refused.stderr).toContain("backslash, quote, or newline");
		}
	});

	it("refuses an empty prompt instead of running Codex", () => {
		const prompt = join(root, "empty.md");
		writeFileSync(prompt, "\n");
		expect(() => execFileSync(script, [linked, "model", prompt], { stdio: "pipe" })).toThrow(/prompt file is empty/);
	});

	describe.skipIf(!sandboxExec)("under sandbox-exec", () => {
		let profilePath;
		const sh = (cwd, command) =>
			execFileSync("sandbox-exec", ["-f", profilePath, "/bin/sh", "-c", command], {
				cwd,
				stdio: "pipe",
				env: {
					...env(),
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@example.com",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@example.com",
				},
			});

		beforeAll(() => {
			profilePath = join(root, "profile.sb");
			writeFileSync(profilePath, profile(linked));
		});

		it("commits in the linked worktree", () => {
			sh(linked, "echo x > f && git add f && git commit -q -m sandboxed");
			expect(git(linked, "log", "-1", "--format=%s").toString().trim()).toBe("sandboxed");
		});

		it("cannot rename .git in the worktree or the checkout to swap in its own", () => {
			expect(failure(() => sh(linked, "mv .git .git-old")).status).not.toBe(0);
			expect(failure(() => sh(linked, "rm .git")).status).not.toBe(0);
			expect(failure(() => sh(root, "mv main/.git main/.git-old")).status).not.toBe(0);
			expect(existsSync(join(linked, ".git"))).toBe(true);
			expect(existsSync(join(main, ".git"))).toBe(true);
		});

		it("cannot repoint the administrative directory, yet still commits", () => {
			for (const file of ["commondir", "gitdir"]) {
				const before = readFileSync(join(admin, file), "utf8");
				expect(failure(() => sh(linked, `echo evil > '${admin}/${file}'`)).status).not.toBe(0);
				expect(failure(() => sh(linked, `rm '${admin}/${file}'`)).status).not.toBe(0);
				expect(readFileSync(join(admin, file), "utf8")).toBe(before);
			}
			expect(failure(() => sh(linked, `mkdir '${admin}/hooks'`)).status).not.toBe(0);
			sh(linked, "echo y > g && git add g && git commit -q -m again");
			expect(git(linked, "log", "-1", "--format=%s").toString().trim()).toBe("again");
		});

		it("cannot write git config or hooks", () => {
			expect(failure(() => sh(linked, "git config core.fsmonitor evil")).status).not.toBe(0);
			expect(failure(() => sh(linked, `echo x > '${main}/.git/hooks/pre-commit'`)).status).not.toBe(0);
		});

		it("cannot write under the home directory, /private/tmp, or ~/.npm", () => {
			expect(failure(() => sh(linked, `touch '${home}/escape'`)).status).not.toBe(0);
			expect(failure(() => sh(linked, `mkdir -p '${home}/.npm/_npx'`)).status).not.toBe(0);
			expect(failure(() => sh(linked, `touch '/private/tmp/codex-sandboxed-probe-${process.pid}'`)).status).not.toBe(
				0,
			);
			expect(failure(() => sh(linked, `touch '${join(root, "tmp")}/outside-run'`)).status).not.toBe(0);
		});

		it("can write the per-run directory", () => {
			sh(linked, `touch '${run}/ok'`);
			expect(existsSync(join(run, "ok"))).toBe(true);
		});
	});

	describe.skipIf(!sandboxExec)("the wrapper end to end, with a stand-in codex", () => {
		it("scrubs secrets, points TMPDIR and the npm cache at the run, passes the prompt after --, and cleans up", () => {
			const bin = join(root, "bin");
			mkdirSync(bin);
			writeFileSync(
				join(bin, "codex"),
				'#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\necho "tmpdir:$TMPDIR"\necho "cache:$npm_config_cache"\necho "gh:$(printenv GH_TOKEN || echo unset)"\necho "key:$(printenv OPENAI_API_KEY || echo unset)"\necho "term:$(printenv TERM || echo unset)"\ntouch "$TMPDIR/probe" && echo probe-ok\nif read -r line; then echo "stdin:data"; else echo "stdin:eof"; fi\n',
			);
			chmodSync(join(bin, "codex"), 0o755);
			const prompt = join(root, "dash.md");
			writeFileSync(prompt, "--not-an-option please\n");
			const log = join(root, "wrapper.log");
			execFileSync(script, [linked, "m", prompt, log], {
				stdio: "pipe",
				input: "pending input\n",
				env: { ...env(), PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "s", OPENAI_API_KEY: "s", TERM: "xterm" },
			});
			const out = readFileSync(log, "utf8");
			expect(out).toContain("arg:--\narg:--not-an-option please");
			expect(out).toMatch(/tmpdir:.*\/codex-run\.[A-Za-z0-9]+/);
			expect(out).toMatch(/cache:.*\/codex-run\.[A-Za-z0-9]+\/npm-cache/);
			expect(out).toContain("gh:unset");
			expect(out).toContain("key:unset");
			expect(out).toContain("term:xterm");
			expect(out).toContain("probe-ok");
			expect(out).toContain("stdin:eof");
			for (const dir of ["shell_snapshots", "memories", ".tmp"])
				expect(existsSync(join(home, ".codex", dir))).toBe(false);
			for (const dir of ["cache", "tmp", "ipc", "attachments"])
				expect(existsSync(join(home, ".codex", dir))).toBe(true);
			expect(execFileSync("ls", [join(root, "tmp")]).toString()).not.toMatch(/codex-run\./);
			expect(execFileSync("ls", [join(root, "tmp")]).toString()).not.toMatch(/codex-seatbelt/);
		});
	});
});

describe("codex-sandboxed.sh argument checks", () => {
	it("prints usage and exits 64 without a prompt file", () => {
		const result = failure(() => execFileSync(script, ["/tmp", "model"], { stdio: "pipe" }));
		expect(result.status).toBe(64);
		expect(result.stderr).toContain("usage: codex-sandboxed.sh");
	});
});

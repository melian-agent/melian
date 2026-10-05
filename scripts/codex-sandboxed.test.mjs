import { execFile, execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "codex-sandboxed.sh");
// Codex fails on a first run without these directories.
const codexNames = ["sessions", "log", "cache", "tmp", "ipc", "thread-writer-locks", "mcp-oauth-locks", "attachments"];
const git = (cwd, ...args) =>
	execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });

const sandboxExec = (() => {
	if (!existsSync("/usr/bin/sandbox-exec")) return false;
	try {
		execFileSync("sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"], { stdio: "ignore" });
		return true;
	} catch {
		// macOS refuses a nested sandbox when the test itself runs inside this wrapper.
		return false;
	}
})();
const realAgentSocket = (() => {
	try {
		return execFileSync("launchctl", ["getenv", "SSH_AUTH_SOCK"], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
})();

const calculatorRunning = () => {
	try {
		return (
			execFileSync("osascript", ["-e", 'application "Calculator" is running'], { encoding: "utf8" }).trim() ===
			"true"
		);
	} catch {
		return false;
	}
};

const failure = (fn) => {
	try {
		fn();
	} catch (error) {
		return { status: error.status, stderr: String(error.stderr) };
	}
	return { status: 0, stderr: "" };
};

describe("codex-sandboxed.sh profile", { timeout: 60_000 }, () => {
	let root;
	let main;
	let linked;
	let home;
	let run;
	let scratch;
	let profilePath;
	let admin;
	let bin;

	const env = () => ({
		...process.env,
		HOME: home,
		CODEX_HOME: join(home, ".codex"),
		PI_CODING_AGENT_DIR: "",
		TMPDIR: join(root, "tmp"),
		PATH: `${bin}:${process.env.PATH}`,
	});
	const profile = (cwd, scratchDir = run) =>
		execFileSync(script, ["--print-profile", cwd, scratchDir, run], { encoding: "utf8", env: env() });
	const block = (text, head) => {
		const start = text.indexOf(`(${head}\n`);
		return text.slice(start, text.indexOf("\n)", start));
	};

	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "codex-sandboxed-")));
		main = join(root, "main");
		// The directory name holds regex metacharacters, so the escaping in the deny regexes is exercised.
		linked = join(root, "a+b (c).d", "linked");
		home = join(root, "home");
		run = join(root, "tmp", "codex-run");
		scratch = join(root, "scratch");
		mkdirSync(run, { recursive: true });
		mkdirSync(scratch);
		mkdirSync(main);
		git(main, "init", "-q");
		git(main, "commit", "-q", "--allow-empty", "-m", "init");
		mkdirSync(join(root, "a+b (c).d"));
		git(main, "worktree", "add", "-q", linked);
		admin = join(main, ".git", "worktrees", "linked");
		bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "codex"),
			'#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\nenv | sed \'s/^/env:/\'\ntouch "$TMPDIR/probe" && echo probe-ok\nzsh -lc \'cat <<EOF\nzsh-heredoc-ok\nEOF\' || echo zsh-heredoc-failed\ntouch "$npm_config_cache/probe" && echo cache-ok\nif read -r line; then echo "stdin:data"; else echo "stdin:eof"; fi\n',
		);
		chmodSync(join(bin, "codex"), 0o755);
		for (const dir of ["sessions", "log", "hooks"]) mkdirSync(join(home, ".codex", dir), { recursive: true });
		writeFileSync(join(home, ".codex", "config.toml"), "");
		profilePath = join(root, "profile.sb");
		writeFileSync(profilePath, profile(linked, scratch));
	});

	const tmpProbe = () => `/private/tmp/codex-sandboxed-probe-${basename(root)}`;

	const calculatorWasRunning = sandboxExec && calculatorRunning();

	afterAll(() => {
		if (sandboxExec) {
			try {
				execFileSync("launchctl", ["remove", "melian-probe"], { stdio: "ignore" });
			} catch {}
			if (!calculatorWasRunning && calculatorRunning()) {
				try {
					execFileSync("osascript", ["-e", 'tell application "Calculator" to quit'], { stdio: "ignore" });
				} catch {}
			}
		}
		rmSync(tmpProbe(), { force: true });
		if (existsSync(join(linked, "flagged"))) execFileSync("chflags", ["nouchg", join(linked, "flagged")]);
		rmSync(root, { recursive: true, force: true });
	});

	it("looks up only named Mach services, never launchd or LaunchServices", () => {
		const text = profile(linked, scratch);
		expect(text).not.toMatch(/^\(allow mach-lookup\)$/m);
		for (const name of [
			"com.apple.SecurityServer",
			"com.apple.securityd.xpc",
			"com.apple.trustd",
			"com.apple.trustd.agent",
			"com.apple.system.opendirectoryd.libinfo",
		])
			expect(text).toContain(`(global-name "${name}")`);
		for (const name of ["com.apple.coreservices.launchservicesd", "com.apple.lsd.mapdb", "com.apple.xpc.launchd"])
			expect(text).not.toContain(name);
	});

	it("filters the network: IP only, loopback servers, and the resolver's socket, with no blanket allow", () => {
		const text = profile(linked, scratch);
		expect(text).not.toMatch(/^\(allow network\*\)$/m);
		expect(text).not.toMatch(/^\(allow system-socket\)$/m);
		expect(text).toContain("(allow network-outbound (remote ip))");
		expect(text).toContain('(remote unix-socket (path-literal "/private/var/run/mDNSResponder"))');
	});

	it("denies symlinks and file flags in the worktree, with an allowance for node_modules after the deny", () => {
		const text = profile(linked, scratch);
		const deny = text.indexOf(
			`(deny file-write-create\n  (require-all\n    (subpath "${linked}")\n    (vnode-type SYMLINK)))`,
		);
		const allow = text.indexOf(
			'(allow file-write-create\n  (require-all\n    (regex #"^' +
				linked.replace(/[+().]/g, "\\$&") +
				'/(.*/)?node_modules/")',
		);
		expect(deny).toBeGreaterThan(-1);
		expect(allow).toBeGreaterThan(deny);
		expect(text.indexOf("(deny file-write-flags)")).toBeGreaterThan(-1);
		expect(text.indexOf("(deny file-write*")).toBeGreaterThan(allow);
	});

	it("allows only the git state a commit needs, as literal files in the administrative directory", () => {
		const allow = block(profile(linked), "allow file-write*");
		for (const path of ["objects", "refs", "logs"]) expect(allow).toContain(`(subpath "${main}/.git/${path}")`);
		expect(allow).toContain(`(literal "${main}/.git/packed-refs")`);
		for (const file of [
			"HEAD",
			"index",
			"index.lock",
			"ORIG_HEAD",
			"MERGE_MSG",
			"COMMIT_EDITMSG",
			"FETCH_HEAD",
			"FETCH_HEAD.lock",
		]) {
			expect(allow).toContain(`(literal "${admin}/${file}")`);
		}
		for (const file of ["gc.pid", "gc.pid.lock", "shallow", "shallow.lock"]) {
			expect(allow).toContain(`(literal "${main}/.git/${file}")`);
			expect(allow).not.toContain(`(literal "${admin}/${file}")`);
		}
		expect(allow).toContain(`(subpath "${admin}/logs")`);
		for (const dir of ["rebase-merge", "rebase-apply"]) expect(allow).not.toContain(dir);
		const escaped = linked.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
		expect(allow).toContain(`(regex #"^${escaped}/")`);
		expect(allow).not.toContain(`(subpath "${admin}")`);
		expect(allow).not.toContain(`"${main}/.git")`);
		for (const path of ["hooks", "config", "info", "commondir", "gitdir"])
			expect(allow).not.toContain(`/.git/${path}`);
	});

	it("allows Codex's sqlite databases by a regex over the escaped home path", () => {
		const escaped = `${home}/.codex`.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
		expect(block(profile(linked), "allow file-write*")).toContain(
			`(regex #"^${escaped}/[^/]+\\.sqlite(-shm|-wal)?$")`,
		);
	});

	it("allows Codex to rewrite auth.json and a temporary beside it, which a login refresh needs", () => {
		const escaped = `${home}/.codex`.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
		expect(block(profile(linked), "allow file-write*")).toContain(
			`(regex #"^${escaped}/(auth\\.json([.][^/]*)?|[.]tmp[^/]+)$")`,
		);
	});

	it("defaults to .codex under HOME when CODEX_HOME is unset", () => {
		const fakeHome = join(root, "default-home");
		mkdirSync(fakeHome);
		const defaultEnv = { ...env(), HOME: fakeHome };
		delete defaultEnv.CODEX_HOME;
		const text = execFileSync(script, ["--print-profile", linked, scratch, run], {
			encoding: "utf8",
			env: defaultEnv,
		});
		const codex = join(fakeHome, ".codex");
		const escaped = codex.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
		const allow = block(text, "allow file-write*");
		for (const name of codexNames) expect(allow).toContain(`(regex #"^${escaped}/${name}/")`);
		expect(allow).toContain(`(literal "${codex}/history.jsonl")`);
		expect(allow).toContain(`(regex #"^${escaped}/(auth\\.json([.][^/]*)?|[.]tmp[^/]+)$")`);
		expect(allow).toContain(`(regex #"^${escaped}/[^/]+\\.sqlite(-shm|-wal)?$")`);
		expect(text).not.toContain(join(home, ".codex"));
	});

	it("names CODEX_HOME instead of ~/.codex when it is set, and refuses a relative one", () => {
		const elsewhere = join(root, "elsewhere-codex");
		const text = execFileSync(script, ["--print-profile", linked, run, run], {
			encoding: "utf8",
			env: { ...env(), CODEX_HOME: elsewhere },
		});
		const allow = block(text, "allow file-write*");
		const escaped = elsewhere.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
		expect(allow).toContain(`(regex #"^${escaped}/sessions/")`);
		expect(allow).toContain(`(literal "${elsewhere}/history.jsonl")`);
		expect(allow).toContain(`^${escaped}/[^/]+\\.sqlite`);
		expect(block(text, "deny file-write*")).toContain(`(literal "${elsewhere}/config.toml")`);
		expect(block(text, "deny file-write*")).toContain(`(subpath "${elsewhere}/hooks")`);
		expect(text).not.toContain(`${home}/.codex`);
		const refused = failure(() =>
			execFileSync(script, ["--print-profile", linked], { stdio: "pipe", env: { ...env(), CODEX_HOME: "rel" } }),
		);
		expect(refused.status).toBe(64);
		expect(refused.stderr).toContain("CODEX_HOME must be an absolute path");
	});

	it("allows the per-run directory, never /private/tmp, /private/var/folders, or ~/.npm", () => {
		const allow = block(profile(linked), "allow file-write*");
		const escaped = run.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
		expect(allow).toContain(`(regex #"^${escaped}/")`);
		expect(allow).not.toContain('"/private/tmp"');
		expect(allow).not.toContain('"/private/var/folders"');
		expect(allow).not.toContain(".npm");
	});

	it("allows only children of the worktree, scratch, and run, and fixes the persistent roots after the allow", () => {
		const text = profile(linked, scratch);
		const allow = block(text, "allow file-write*");
		for (const path of [linked, scratch, run]) {
			const escaped = path.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
			expect(allow).toContain(`(regex #"^${escaped}/")`);
			expect(allow).not.toContain(`(subpath "${path}")`);
		}
		const deny = block(text, "deny file-write*");
		for (const path of [linked, scratch]) expect(deny).toContain(`(literal "${path}")`);
		expect(text.indexOf(deny)).toBeGreaterThan(text.indexOf(allow));
	});

	it("lists each allowed entry once", () => {
		const lines = block(profile(linked), "allow file-write*").split("\n");
		expect(new Set(lines).size).toBe(lines.length);
	});

	it("allows the named Codex runtime paths, never the home directory or its secrets and caches", () => {
		const allow = block(profile(linked), "allow file-write*");
		const escaped = `${home}/.codex`.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
		expect(allow).toContain(`(regex #"^${escaped}/sessions/")`);
		expect(allow).toContain(`(regex #"^${escaped}/log/")`);
		expect(allow).not.toContain(`(subpath "${home}/.codex")`);
		for (const path of ["config.toml", "hooks", "shell_snapshots", "memories", ".tmp"]) {
			expect(allow).not.toContain(`${home}/.codex/${path}`);
		}
		expect(allow).not.toContain(".config/gh");
		expect(allow).not.toContain("Library/Caches");
	});

	it("allows and denies each required Codex runtime directory", () => {
		const text = profile(linked);
		const allow = block(text, "allow file-write*");
		const deny = block(text, "deny file-write*");
		const escaped = `${home}/.codex`.replace(/[[\\.*^$+?(){}|\]]/g, "\\$&");
		for (const name of codexNames) {
			expect(allow, name).toContain(`(regex #"^${escaped}/${name}/")`);
			expect(allow, name).not.toContain(`(subpath "${home}/.codex/${name}")`);
			expect(deny, name).toContain(`^${escaped}/${name}/(.*/)?[.][gG][iI][tT](/|$)`);
			expect(text, name).toContain(
				`^${escaped}/${name}/(.*/)?([hH][eE][aA][dD]|[cC][oO][mM][mM][oO][nN][dD][iI][rR])$`,
			);
		}
	});

	it("denies symlink creation under Codex's home after the runtime allowances", () => {
		const text = profile(linked);
		const deny = `(deny file-write-create\n  (require-all\n    (subpath "${home}/.codex")\n    (vnode-type SYMLINK)))`;
		expect(text.indexOf(deny)).toBeGreaterThan(text.indexOf("(allow file-write*"));
	});

	it("refuses symlinked Codex paths before printing a profile", () => {
		const names = [...codexNames, "auth.json", "."];
		for (const [index, name] of names.entries()) {
			const fakeHome = join(root, `symlink-home-${index}`);
			const codex = join(fakeHome, ".codex");
			mkdirSync(fakeHome);
			if (name !== ".") mkdirSync(codex);
			symlinkSync(run, name === "." ? codex : join(codex, name));
			try {
				execFileSync(script, ["--print-profile", linked], {
					env: { ...env(), HOME: fakeHome, CODEX_HOME: codex },
					stdio: "pipe",
				});
				throw new Error(`accepted symlink: ${name}`);
			} catch (error) {
				expect(error.status, name).toBe(64);
				expect(String(error.stdout), name).toBe("");
				expect(String(error.stderr), name).toContain("symlink");
			}
		}
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
			`(literal "${home}/.codex/config.toml")`,
			`(subpath "${home}/.codex/hooks")`,
		]) {
			expect(deny).toContain(path);
		}
		expect(deny).not.toContain("auth.json");
		expect(text.indexOf("(deny file-write*")).toBeGreaterThan(text.indexOf("(allow file-write*"));
	});

	it("denies a planted repository in every persistent writable subtree, with the path escaped", () => {
		const text = profile(linked, scratch);
		const deny = block(text, "deny file-write*");
		const files = block(text, "deny file-write-create file-write-data file-write-unlink");
		expect(linked).toContain("a+b (c).d");
		expect(deny).toContain("a\\+b \\(c\\)\\.d");
		const codex = [`${home}/.codex/cache`, `${home}/.codex/sessions`, `${home}/.codex/attachments`];
		const common = `${main}/.git`;
		for (const path of [
			linked,
			scratch,
			`${common}/objects`,
			`${common}/refs`,
			`${common}/logs`,
			`${admin}/logs`,
			...codex,
		]) {
			const escaped = path.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
			expect(deny).toContain(`(regex #"^${escaped}/(.*/)?[.][gG][iI][tT](/|$)")`);
			expect(files).toContain(
				`(regex #"^${escaped}/(.*/)?([hH][eE][aA][dD]|[cC][oO][mM][mM][oO][nN][dD][iI][rR])$")`,
			);
		}
		expect(files).toContain("(require-not (vnode-type DIRECTORY))");
		expect(deny).not.toContain("[hH][eE][aA][dD]");
		expect(deny).not.toContain("/(.*/)?[oO][bB][jJ][eE][cC][tT][sS]");
		expect(deny).toContain("/(logs/)?refs/remotes/[^/]+/[oO][bB][jJ][eE][cC][tT][sS](/|$)");
	});

	it("allows the HEAD files git writes under the denied trees, after the deny", () => {
		const text = profile(linked);
		const files = block(text, "deny file-write-create file-write-data file-write-unlink");
		const allowAt = text.indexOf("(allow file-write-create file-write-data file-write-unlink\n");
		expect(allowAt).toBeGreaterThan(text.indexOf(files));
		const allow = text.slice(allowAt);
		for (const path of ["logs/HEAD", "logs/HEAD.lock"]) expect(allow).toContain(`(literal "${main}/.git/${path}")`);
		for (const path of ["logs/HEAD", "logs/HEAD.lock"]) expect(allow).toContain(`(literal "${admin}/${path}")`);
		const escaped = `${main}/.git`.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
		for (const tree of ["refs", "logs/refs"])
			expect(allow).toContain(`(regex #"^${escaped}/${tree}/remotes/[^/]+/HEAD([.]lock)?$")`);
		expect(allow).not.toContain("commondir");
	});

	it("denies nothing under the run directory, which the wrapper deletes, but everything under a separate scratch", () => {
		expect(block(profile(linked), "deny file-write*")).not.toContain(`^${run}/`);
		const text = profile(linked, scratch);
		const escaped = scratch.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
		expect(block(text, "deny file-write*")).not.toContain(`^${run}/`);
		for (const name of ["[.][gG][iI][tT](/|$)", "([hH][eE][aA][dD]|[cC][oO][mM][mM][oO][nN][dD][iI][rR])$"])
			expect(text).toContain(`^${escaped}/(.*/)?${name}`);
		const apart = block(text, "deny file-write*");
		expect(apart).not.toContain(`(subpath "${run}")`);
	});

	it("allows the lock and temporary index files of a partial commit and a stash, by regex in the administrative directory", () => {
		const allow = block(profile(linked), "allow file-write*");
		const esc = admin.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
		expect(allow).toContain(`(regex #"^${esc}/next-index-[0-9]+\\.lock$")`);
		expect(allow).toContain(`(regex #"^${esc}/index\\.stash\\.[0-9]+(\\.lock)?$")`);
	});

	it("denies reads of credentials and .env files, but not Codex's auth.json", () => {
		const text = profile(linked);
		const deny = block(text, "deny file-read*");
		for (const path of [
			`(subpath "${home}/.ssh")`,
			`(subpath "${main}/.git/melian")`,
			`(subpath "${linked}/.git/melian")`,
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

	it("keeps Pi auth unreadable with no later read allowance", () => {
		const text = profile(linked);
		const denyAt = text.lastIndexOf("(deny file-read*\n");
		expect(denyAt).toBeGreaterThan(text.lastIndexOf("(allow file-read"));
		expect(block(text.slice(denyAt), "deny file-read*")).toContain(`(literal "${home}/.pi/agent/auth.json")`);
		expect(text.slice(denyAt)).not.toMatch(/\(allow file-read/);
	});

	it("denies the default Pi store when PI_CODING_AGENT_DIR is unset or empty", () => {
		for (const unset of [false, true]) {
			const defaultEnv = env();
			if (unset) delete defaultEnv.PI_CODING_AGENT_DIR;
			const text = execFileSync(script, ["--print-profile", linked, scratch, run], {
				encoding: "utf8",
				env: defaultEnv,
			});
			expect(block(text, "deny file-read*")).toContain(`(literal "${home}/.pi/agent/auth.json")`);
		}
	});

	it("denies both Pi stores and resolves the configured store's symlinks", () => {
		const store = join(root, "pi-store");
		const target = join(root, "pi-auth.json");
		const link = join(root, "pi-link");
		mkdirSync(store);
		symlinkSync(store, link);
		writeFileSync(target, "synthetic-pi-credential\n");
		symlinkSync(target, join(store, "auth.json"));
		const text = execFileSync(script, ["--print-profile", linked, scratch, run], {
			encoding: "utf8",
			env: { ...env(), PI_CODING_AGENT_DIR: link },
		});
		const deny = block(text, "deny file-read*");
		for (const path of [join(home, ".pi/agent/auth.json"), target])
			expect(deny).toContain(`(literal "${path}")`);
		expect(deny).not.toContain(`${link}/auth.json`);
		expect(text.slice(text.lastIndexOf("(deny file-read*\n"))).not.toMatch(/\(allow file-read/);
	});

	it("refuses a Pi directory holding a quote, backslash, or newline before printing a profile", () => {
		for (const name of ['pi"store', "pi\\store", "pi\nstore", "pi-store\n"]) {
			try {
				execFileSync(script, ["--print-profile", linked, scratch, run], {
					stdio: "pipe",
					env: { ...env(), PI_CODING_AGENT_DIR: join(root, name) },
				});
				throw new Error(`accepted Pi directory: ${name}`);
			} catch (error) {
				expect(error.status, name).toBe(64);
				expect(String(error.stdout), name).toBe("");
				expect(String(error.stderr), name).toContain("backslash, quote, or newline");
			}
		}
	});

	it("denies all writes to root .env files after the write allowances", () => {
		const text = profile(linked);
		const denyAt = text.lastIndexOf("(deny file-write*\n");
		expect(denyAt).toBeGreaterThan(text.lastIndexOf("(allow file-write"));
		for (const path of [join(linked, ".env"), join(main, ".env")])
			expect(text.slice(denyAt)).toContain(`(literal "${path}")`);
	});

	it("names the target of a symlinked .env, since seatbelt matches real paths", () => {
		const target = join(root, "readonly-env", "real.env");
		mkdirSync(join(root, "readonly-env"));
		writeFileSync(target, "SECRET=1\n");
		symlinkSync(target, join(linked, ".env"));
		try {
			const deny = block(profile(linked), "deny file-read*");
			expect(deny).toContain(`(literal "${target}")`);
			expect(deny).not.toContain(`(literal "${linked}/.env")`);
			const writes = profile(linked).slice(profile(linked).lastIndexOf("(deny file-write*\n"));
			expect(writes).toContain(`(literal "${linked}/.env")`);
			expect(writes).toContain(`(literal "${target}")`);
		} finally {
			rmSync(join(linked, ".env"), { force: true });
		}
	});

	it("names the target of a relative symlinked .env too", () => {
		const target = join(root, "relative-readonly-env", "real.env");
		mkdirSync(join(root, "relative-readonly-env"));
		writeFileSync(target, "SECRET=1\n");
		symlinkSync(relative(linked, target), join(linked, ".env"));
		try {
			const deny = block(profile(linked), "deny file-read*");
			expect(deny).toContain(`(literal "${target}")`);
			expect(deny).not.toContain(`(literal "${linked}/.env")`);
			const writes = profile(linked).slice(profile(linked).lastIndexOf("(deny file-write*\n"));
			expect(writes).toContain(`(literal "${linked}/.env")`);
			expect(writes).toContain(`(literal "${target}")`);
		} finally {
			rmSync(join(linked, ".env"), { force: true });
			rmSync(target, { force: true });
		}
	});

	it("refuses root .env symlinks into every writable subtree", () => {
		const trees = [
			linked,
			scratch,
			run,
			...["objects", "refs", "logs"].map((name) => join(main, ".git", name)),
			...["logs", "sequencer"].map((name) => join(admin, name)),
			...codexNames.map((name) => join(home, ".codex", name)),
		];
		for (const directory of [linked, main]) {
			for (const tree of trees) {
				const parent = join(tree, "env-parent");
				const file = join(directory, ".env");
				mkdirSync(parent, { recursive: true });
				writeFileSync(join(parent, "secret"), "SYNTHETIC_TEST_SECRET=1\n");
				symlinkSync(relative(directory, join(parent, "secret")), file);
				try {
					const result = failure(() => profile(linked, scratch));
					expect(result.status, `${directory}: ${tree}`).toBe(64);
					expect(result.stderr).toContain(".env must be a regular file or absent");
				} finally {
					rmSync(file);
					rmSync(parent, { recursive: true, force: true });
				}
			}
		}
	});

	it("refuses a writable .env symlink before starting a task", () => {
		const launcher = join(root, "env-startup-bin");
		mkdirSync(launcher);
		writeFileSync(join(launcher, "uname"), "#!/bin/sh\necho Darwin\n");
		chmodSync(join(launcher, "uname"), 0o755);
		const prompt = join(root, "env-prompt.md");
		writeFileSync(prompt, "go\n");
		symlinkSync("env-target", join(linked, ".env"));
		try {
			const result = failure(() =>
				execFileSync(script, [linked, "m", prompt, join(root, "env-task.log")], {
					stdio: "pipe",
					env: { ...env(), PATH: `${launcher}:${env().PATH}` },
				}),
			);
			expect(result.status).toBe(64);
			expect(result.stderr).toContain(".env must be a regular file or absent");
		} finally {
			rmSync(join(linked, ".env"));
		}
	});

	it("refuses the main checkout, where the worktree allowance would cover .git", () => {
		const refused = failure(() => profile(main));
		expect(refused.status).toBe(64);
		expect(refused.stderr).toContain("not a linked worktree");
	});

	it.skipIf(!sandboxExec)("refuses the main checkout when running a task too", () => {
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

	it.skipIf(process.platform !== "darwin")(
		"refuses a symlinked cache before creating a profile or running Codex",
		() => {
			const fakeHome = join(root, "wrapper-symlink-home");
			const temp = join(root, "wrapper-symlink-tmp");
			mkdirSync(join(fakeHome, ".codex"), { recursive: true });
			mkdirSync(temp);
			symlinkSync(run, join(fakeHome, ".codex", "cache"));
			const prompt = join(root, "symlink.md");
			const log = join(root, "symlink.log");
			writeFileSync(prompt, "go\n");
			const result = failure(() =>
				execFileSync(script, [linked, "m", prompt, log], {
					env: { ...env(), HOME: fakeHome, CODEX_HOME: join(fakeHome, ".codex"), TMPDIR: temp },
					stdio: "pipe",
				}),
			);
			expect(result.status).toBe(64);
			expect(result.stderr).toContain("symlink");
			expect(readdirSync(temp)).toEqual([]);
			expect(existsSync(log)).toBe(false);
		},
	);

	it("builds the full-access Codex command with the model, worktree, and prompt", () => {
		const freshHome = join(root, "command-home");
		mkdirSync(freshHome);
		expect(existsSync(join(freshHome, ".codex"))).toBe(false);
		const launcher = join(root, "launcher-bin");
		mkdirSync(launcher);
		writeFileSync(join(launcher, "uname"), "#!/bin/sh\necho Darwin\n");
		writeFileSync(
			join(launcher, "sandbox-exec"),
			'#!/bin/sh\n[ "$1" = "-f" ] || exit 99\n[ -f "$2" ] || exit 98\nshift 2\nexec "$@"\n',
		);
		for (const name of ["uname", "sandbox-exec"]) chmodSync(join(launcher, name), 0o755);
		const prompt = join(root, "command.md");
		const log = join(root, "command.log");
		writeFileSync(prompt, "--not-an-option please\n");
		execFileSync(script, [linked, "test-model", prompt, log], {
			stdio: "pipe",
			env: { ...env(), HOME: freshHome, CODEX_HOME: join(freshHome, ".codex"), PATH: `${launcher}:${env().PATH}` },
		});
		const args = readFileSync(log, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("arg:"))
			.map((line) => line.slice(4));
		for (const name of codexNames) expect(existsSync(join(freshHome, ".codex", name)), name).toBe(true);
		expect(args).toEqual([
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
			"--model",
			"test-model",
			"-C",
			linked,
			"--",
			"--not-an-option please",
		]);
	});

	it.skipIf(!sandboxExec)("refuses an empty prompt instead of running Codex", () => {
		const prompt = join(root, "empty.md");
		writeFileSync(prompt, "\n");
		expect(() => execFileSync(script, [linked, "model", prompt], { stdio: "pipe", env: env() })).toThrow(
			/prompt file is empty/,
		);
	});

	describe.skipIf(!sandboxExec)("under sandbox-exec", () => {
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

		it("cannot move the worktree or scratch into the run directory or to a sibling", () => {
			for (const [index, path] of [linked, scratch].entries()) {
				for (const destination of [join(run, `moved-root-${index}`), `${path}2`]) {
					const result = failure(() => sh(root, `mv '${path}' '${destination}'`));
					expect(result.status, destination).not.toBe(0);
					expect(result.stderr, destination).toContain("Operation not permitted");
					expect(existsSync(path), path).toBe(true);
					expect(existsSync(destination), destination).toBe(false);
				}
			}
		});

		it("cannot remove or replace empty worktree and scratch roots, even under an allowed parent", () => {
			const emptyWorktree = join(run, "empty-worktree");
			const emptyScratch = join(run, "empty-scratch");
			const emptyProfile = join(root, "empty-roots.sb");
			git(main, "worktree", "add", "-q", "--detach", emptyWorktree);
			mkdirSync(emptyScratch);
			writeFileSync(emptyProfile, profile(emptyWorktree, emptyScratch));
			const pointer = readFileSync(join(emptyWorktree, ".git"));
			rmSync(join(emptyWorktree, ".git"));
			try {
				for (const [index, path] of [emptyWorktree, emptyScratch].entries()) {
					expect(readdirSync(path)).toEqual([]);
					const removed = failure(() =>
						execFileSync("sandbox-exec", ["-f", emptyProfile, "/bin/rmdir", path], { env: env() }),
					);
					expect(removed.status, path).not.toBe(0);
					expect(removed.stderr, path).toContain("Operation not permitted");
					const replacement = join(run, `replacement-${index}`);
					mkdirSync(replacement);
					const replaced = failure(() =>
						execFileSync(
							"sandbox-exec",
							[
								"-f",
								emptyProfile,
								process.execPath,
								"-e",
								"require('fs').renameSync(process.argv[1], process.argv[2])",
								replacement,
								path,
							],
							{ env: env() },
						),
					);
					expect(replaced.status, path).not.toBe(0);
					expect(replaced.stderr, path).toContain("EPERM");
					expect(existsSync(replacement)).toBe(true);
				}
			} finally {
				mkdirSync(emptyWorktree, { recursive: true });
				writeFileSync(join(emptyWorktree, ".git"), pointer);
				git(main, "worktree", "remove", "--force", emptyWorktree);
			}
		});

		it("resolves the user, yet cannot start a process through launchd or LaunchServices", () => {
			expect(sh(linked, "id -un").toString().trim()).not.toBe("");
			for (const command of ["launchctl submit -l melian-probe -- /usr/bin/true", "open -g -j -a Calculator"])
				expect(failure(() => sh(linked, command)).status, command).not.toBe(0);
		});

		it("serves and fetches over loopback, but cannot connect to a unix-domain socket", async () => {
			const loopback =
				"const h=require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',async()=>{console.log('served',await (await fetch('http://127.0.0.1:'+h.address().port)).text());h.close()})";
			const served = execFileSync("sandbox-exec", ["-f", profilePath, process.execPath, "-e", loopback], {
				env: env(),
			}).toString();
			expect(served).toContain("served ok");
			const socketPath = join(root, "agent.sock");
			const server = createServer((connection) => connection.end("secret"));
			await new Promise((resolve) => server.listen(socketPath, resolve));
			const connect = `require('net').connect(${JSON.stringify(socketPath)}).on('data',d=>console.log(String(d))).on('error',e=>{console.log(e.code);process.exit(3)})`;
			try {
				const direct = await promisify(execFile)(process.execPath, ["-e", connect]);
				expect(direct.stdout).toContain("secret");
				const sandboxed = promisify(execFile)("sandbox-exec", ["-f", profilePath, process.execPath, "-e", connect]);
				await expect(sandboxed).rejects.toMatchObject({ code: 3 });
			} finally {
				server.close();
			}
		});

		it.skipIf(process.env.MELIAN_SANDBOX_NETWORK !== "1")(
			"reaches the registry over TLS and the keychain service",
			() => {
				const fetchRegistry = 'fetch("https://registry.npmjs.org/").then(r=>process.exit(r.ok?0:1))';
				execFileSync("sandbox-exec", ["-f", profilePath, process.execPath, "-e", fetchRegistry], { env: env() });
				const keychain = failure(() => sh(linked, "security find-generic-password -s nothing-here"));
				expect(keychain.stderr).not.toMatch(/Operation not permitted|Sandbox|deny/i);
			},
		);

		it.skipIf(!realAgentSocket)("cannot reach the user's ssh agent", () => {
			expect(failure(() => sh(linked, `SSH_AUTH_SOCK='${realAgentSocket}' ssh-add -l`)).status).toBe(2);
		});

		it("cannot create a symlink in the worktree outside node_modules, nor move one in, nor set a file flag", () => {
			sh(linked, `ln -s /tmp '${run}/outside-link'`);
			const blocked = [
				"ln -s /tmp link",
				"mkdir -p src && ln -s /tmp src/link",
				`mv '${run}/outside-link' moved-link`,
				`cp -P '${run}/outside-link' copied-link`,
				`ln -P '${run}/outside-link' hard-link`,
				"touch flagged && chflags uchg flagged",
				"mkdir -p node_modules/.bin && ln -s x node_modules/.bin/y && mv node_modules/.bin/y y-out",
				"mkdir -p node_modules && ln -s x node_modules/HEAD",
			];
			for (const command of blocked) expect(failure(() => sh(linked, command)).status, command).not.toBe(0);
			for (const name of ["link", "moved-link", "copied-link", "hard-link", "y-out"])
				expect(existsSync(join(linked, name))).toBe(false);
			sh(linked, "mkdir -p node_modules/.bin && ln -s x node_modules/.bin/z && ln -sf w node_modules/.bin/z");
			expect(readdirSync(join(linked, "node_modules", ".bin"))).toContain("z");
			rmSync(join(run, "outside-link"), { force: true });
		});

		it("runs npm ci for a package whose dependency has a bin, which links it under node_modules/.bin", () => {
			const dep = join(root, "dep-with-bin");
			mkdirSync(join(dep, "bin"), { recursive: true });
			writeFileSync(
				join(dep, "package.json"),
				'{"name":"dep-with-bin","version":"1.0.0","bin":{"depbin":"bin/x.js"}}',
			);
			writeFileSync(join(dep, "bin", "x.js"), '#!/usr/bin/env node\nconsole.log("bin-ok")\n');
			chmodSync(join(dep, "bin", "x.js"), 0o755);
			const app = join(linked, "npm-app");
			mkdirSync(app);
			execFileSync("npm", ["pack", "--silent", "--pack-destination", app], { cwd: dep, stdio: "pipe" });
			writeFileSync(
				join(app, "package.json"),
				'{"name":"app","version":"1.0.0","dependencies":{"dep-with-bin":"file:dep-with-bin-1.0.0.tgz"}}',
			);
			execFileSync("npm", ["install", "--package-lock-only", "--offline", "--no-audit", "--no-fund", "--silent"], {
				cwd: app,
				stdio: "pipe",
				env: { ...process.env, npm_config_cache: join(root, "npm-cache-outside") },
			});
			const out = sh(
				app,
				`npm_config_cache='${scratch}/npm-cache' npm ci --offline --no-audit --no-fund --silent && node_modules/.bin/depbin`,
			).toString();
			expect(out).toContain("bin-ok");
		}, 60_000);

		it("commits in the linked worktree", () => {
			sh(linked, "echo x > f && git add f && git commit -q -m sandboxed");
			expect(git(linked, "log", "-1", "--format=%s").toString().trim()).toBe("sandboxed");
		});

		it("fetches from a file:// remote, writing FETCH_HEAD to the administrative directory", () => {
			const remote = join(root, "remote.git");
			git(root, "init", "-q", "--bare", remote);
			git(main, "push", "-q", remote, "HEAD:refs/heads/upstream");
			git(main, "remote", "add", "origin", `file://${remote}`);
			sh(linked, "git fetch origin");
			expect(existsSync(join(admin, "FETCH_HEAD"))).toBe(true);
			expect(git(linked, "rev-parse", "refs/remotes/origin/upstream").toString().trim()).toMatch(/^[0-9a-f]{40}$/);
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

		it("denies commondir, gitdir, and config even under a broader allow of the administrative directory", () => {
			const text = profile(linked).replace(
				"(deny file-write*",
				`(allow file-write* (subpath "${admin}") (subpath "${main}/.git"))\n(deny file-write*`,
			);
			const widened = join(root, "widened.sb");
			writeFileSync(widened, text);
			const widenedSh = (command) =>
				execFileSync("sandbox-exec", ["-f", widened, "/bin/sh", "-c", command], { cwd: linked, stdio: "pipe" });
			widenedSh(`touch '${admin}/probe-allowed'`);
			expect(existsSync(join(admin, "probe-allowed"))).toBe(true);
			for (const file of [`${admin}/commondir`, `${admin}/gitdir`, `${main}/.git/config`]) {
				const before = readFileSync(file, "utf8");
				expect(failure(() => widenedSh(`echo evil > '${file}'`)).status).not.toBe(0);
				expect(readFileSync(file, "utf8")).toBe(before);
			}
		});

		it("cannot create a nested repository or .git file in a subdirectory of the worktree", () => {
			sh(linked, "mkdir -p sub");
			expect(failure(() => sh(linked, "git -C sub init -q")).status).not.toBe(0);
			expect(failure(() => sh(linked, "echo x > sub/.git")).status).not.toBe(0);
			expect(failure(() => sh(linked, "mkdir -p deep/er/.git")).status).not.toBe(0);
			expect(existsSync(join(linked, "sub", ".git"))).toBe(false);
			sh(linked, "echo ok > sub/file");
		});

		it("cannot plant a repository in scratch, the object store, the refs, or Codex's directories", () => {
			mkdirSync(join(home, ".codex", "cache"), { recursive: true });
			mkdirSync(join(admin, "logs"), { recursive: true });
			const planted = [
				`mkdir -p '${scratch}/x/.git'`,
				`echo x > '${scratch}/x/HEAD'`,
				`mkdir -p '${main}/.git/objects/x/.git'`,
				`echo x > '${main}/.git/objects/x/HEAD'`,
				`mkdir -p '${home}/.codex/cache/x/.git'`,
			];
			for (const command of planted) expect(failure(() => sh(linked, command)).status, command).not.toBe(0);
			for (const path of [join(scratch, "x", ".git"), join(scratch, "x", "HEAD")])
				expect(existsSync(path)).toBe(false);
			sh(linked, "echo z > h && git add h && git commit -q -m after-plant");
			expect(git(linked, "log", "-1", "--format=%s").toString().trim()).toBe("after-plant");
		});

		it("cannot create a .git in another case, nested or beside the pointer file", () => {
			sh(linked, "mkdir -p casesub");
			expect(failure(() => sh(linked, "mkdir -p casesub/.GIT")).status).not.toBe(0);
			expect(failure(() => sh(linked, "echo x > casesub/.Git")).status).not.toBe(0);
			expect(failure(() => sh(linked, "echo x > .GiT")).status).not.toBe(0);
			expect(readdirSync(join(linked, "casesub"))).toEqual([]);
			expect(existsSync(join(linked, ".git"))).toBe(true);
		});

		it("cannot build a bare repository, which needs a HEAD file in any case", () => {
			sh(linked, "mkdir -p bare/objects bare/refs");
			expect(failure(() => sh(linked, "echo 'ref: refs/heads/main' > bare/HEAD")).status).not.toBe(0);
			expect(failure(() => sh(linked, "echo 'ref: refs/heads/main' > bare/head")).status).not.toBe(0);
			expect(failure(() => sh(linked, "echo 'ref: refs/heads/main' > bare/objects/Head")).status).not.toBe(0);
			expect(existsSync(join(linked, "bare", "HEAD"))).toBe(false);
			const gitDir = git(join(linked, "bare"), "rev-parse", "--absolute-git-dir").toString().trim();
			expect(realpathSync(gitDir)).toBe(realpathSync(admin));
		});

		it("can create, rename, and remove a directory named head, though no file", () => {
			sh(linked, "mkdir -p src/head && mv src/head src/Head && rmdir src/Head");
			expect(existsSync(join(linked, "src", "Head"))).toBe(false);
			sh(linked, "mkdir -p src/head/inner && touch src/head/inner/f && rm -r src/head");
			for (const command of ["touch src/HEAD", "ln -s x src/HEAD", "echo x > src/x && mv src/x src/head"])
				expect(failure(() => sh(linked, command)).status, command).not.toBe(0);
			expect(readdirSync(join(linked, "src")).filter((name) => /^head$/i.test(name))).toEqual([]);
		});

		it("cannot create a ref whose last component is head, a known limit of the HEAD deny", () => {
			expect(failure(() => sh(linked, "git branch feature/head")).status).not.toBe(0);
			expect(failure(() => sh(linked, "git branch melian/head")).status).not.toBe(0);
			expect(failure(() => sh(linked, "git tag head")).status).not.toBe(0);
			sh(linked, "git branch feature/ahead");
			sh(linked, "git branch -D feature/ahead");
		});

		it("writes and deletes Melian's refs/melian/pull/<N>/head, though no other ref named head", () => {
			sh(linked, "git update-ref --create-reflog refs/melian/pull/7/head HEAD");
			expect(git(linked, "rev-parse", "refs/melian/pull/7/head").toString().trim()).toMatch(/^[0-9a-f]{40}$/);
			sh(linked, "git update-ref -d refs/melian/pull/7/head");
			expect(failure(() => git(linked, "rev-parse", "--verify", "-q", "refs/melian/pull/7/head")).status).not.toBe(
				0,
			);
			expect(failure(() => sh(linked, "git branch feature/head")).status).not.toBe(0);
		});

		it("cannot plant a repository through a commondir file or a HEAD file under refs, logs, or objects", () => {
			sh(linked, "mkdir -p sub");
			const common = `${main}/.git`;
			for (const path of [
				`${common}/refs/x/commondir`,
				`${common}/refs/x/HEAD`,
				`${common}/objects/x/HEAD`,
				`${common}/logs/x/HEAD`,
				`${admin}/logs/x/commondir`,
				`${common}/refs/remotes/x/objects/f`,
				`${common}/logs/refs/remotes/x/objects/f`,
				`${linked}/sub/commondir`,
			])
				expect(
					failure(() => sh(linked, `mkdir -p '${join(path, "..")}' && echo x > '${path}'`)).status,
					path,
				).not.toBe(0);
			expect(existsSync(join(linked, "sub", "commondir"))).toBe(false);
			git(linked, "branch", "objects/y");
			sh(linked, "git branch objects/x && git branch -d objects/x");
		});

		it("writes logs/HEAD on a commit and refs/remotes/origin/HEAD on set-head", () => {
			sh(linked, "echo lh > lh && git add lh && git commit -q -m logged");
			expect(readFileSync(join(admin, "logs", "HEAD"), "utf8")).toContain("logged");
			const remote = join(root, "remote-head.git");
			git(root, "init", "-q", "--bare", "-b", "main", remote);
			git(main, "push", "-q", remote, "HEAD:refs/heads/main");
			git(main, "remote", "add", "headremote", `file://${remote}`);
			sh(linked, "git fetch headremote && git remote set-head headremote -a");
			expect(readFileSync(join(main, ".git", "refs", "remotes", "headremote", "HEAD"), "utf8")).toContain(
				"headremote/main",
			);
			git(main, "remote", "remove", "headremote");
		});

		it("cannot start a rebase, whose todo file the host would later run", () => {
			for (const dir of ["rebase-merge", "rebase-apply"]) {
				expect(failure(() => sh(linked, `mkdir '${admin}/${dir}'`)).status).not.toBe(0);
				expect(existsSync(join(admin, dir))).toBe(false);
			}
		});

		it("cannot write git config or hooks", () => {
			expect(failure(() => sh(linked, "git config core.fsmonitor evil")).status).not.toBe(0);
			expect(failure(() => sh(linked, `echo x > '${main}/.git/hooks/pre-commit'`)).status).not.toBe(0);
		});

		it("cannot read, rename, unlink, or create root .env files", () => {
			for (const directory of [linked, main]) {
				const file = join(directory, ".env");
				writeFileSync(file, "SYNTHETIC_TEST_SECRET=1\n");
				try {
					for (const command of ["cat .env", "mv .env renamed-env", "rm .env"])
						expect(failure(() => sh(directory, command)).status, command).not.toBe(0);
					expect(existsSync(file)).toBe(true);
					expect(existsSync(join(directory, "renamed-env"))).toBe(false);
					rmSync(file);
					expect(failure(() => sh(directory, "touch .env")).status).not.toBe(0);
				} finally {
					rmSync(file, { force: true });
					rmSync(join(directory, "renamed-env"), { force: true });
				}
			}
		});

		it("cannot read the host's Melian storage in the git common directory", () => {
			const state = join(main, ".git", "melian");
			mkdirSync(state);
			writeFileSync(join(state, "ledger.sqlite"), "host-ledger-secret\n");
			try {
				const result = failure(() => sh(linked, `cat '${state}/ledger.sqlite'`));
				expect(result.status).not.toBe(0);
				expect(result.stderr).toContain("Operation not permitted");
			} finally {
				rmSync(state, { recursive: true, force: true });
			}
		});

		it("cannot write under the home directory, /private/tmp, or ~/.npm", () => {
			expect(failure(() => sh(linked, `touch '${home}/escape'`)).status).not.toBe(0);
			expect(failure(() => sh(linked, `mkdir -p '${home}/.npm/_npx'`)).status).not.toBe(0);
			expect(failure(() => sh(linked, `touch '${tmpProbe()}'`)).status).not.toBe(0);
			expect(failure(() => sh(linked, `touch '${join(root, "tmp")}/outside-run'`)).status).not.toBe(0);
		});

		it("keeps Codex's cache directory fixed while allowing files inside it", () => {
			const cache = join(home, ".codex", "cache");
			rmSync(cache, { recursive: true, force: true });
			mkdirSync(cache, { recursive: true });
			for (const command of [
				`mv '${cache}' '${home}/.codex/auth.json.tmp'`,
				`ln -s /tmp '${home}/.codex/cache2'`,
				`rmdir '${cache}'`,
			])
				expect(failure(() => sh(linked, command)).status, command).not.toBe(0);
			sh(linked, `mkdir -p '${cache}/x' && touch '${cache}/x/probe'`);
			expect(existsSync(join(cache, "x", "probe"))).toBe(true);
		});

		it("rewrites auth.json through a temporary and a rename, as a login refresh does", () => {
			mkdirSync(join(home, ".codex"), { recursive: true });
			sh(
				linked,
				`echo old > '${home}/.codex/auth.json' && echo new > '${home}/.codex/.tmpAB12' && mv '${home}/.codex/.tmpAB12' '${home}/.codex/auth.json'`,
			);
			expect(readFileSync(join(home, ".codex", "auth.json"), "utf8")).toBe("new\n");
			sh(linked, `touch '${home}/.codex/auth.json.bak'`);
			rmSync(join(home, ".codex", "auth.json.bak"));
			expect(failure(() => sh(linked, `touch '${home}/.codex/auth.jsonx'`)).status).not.toBe(0);
			expect(failure(() => sh(linked, `touch '${home}/.codex/auth'`)).status).not.toBe(0);
			rmSync(join(home, ".codex", "auth.json"));
		});

		it("writes Codex's sqlite files directly under ~/.codex only", () => {
			mkdirSync(join(home, ".codex", "deep"), { recursive: true });
			sh(linked, `touch '${home}/.codex/x.sqlite' '${home}/.codex/x.sqlite-wal'`);
			expect(existsSync(join(home, ".codex", "x.sqlite-wal"))).toBe(true);
			expect(failure(() => sh(linked, `touch '${home}/.codex/deep/x.sqlite'`)).status).not.toBe(0);
			expect(failure(() => sh(linked, `touch '${home}/.codex/other.txt'`)).status).not.toBe(0);
		});

		it("can create repositories and commit under the per-run directory, which the wrapper deletes", () => {
			sh(run, "git init -q repo && cd repo && echo x > f && git add f && git commit -q -m inner");
			expect(git(join(run, "repo"), "log", "-1", "--format=%s").toString().trim()).toBe("inner");
			rmSync(join(run, "repo"), { recursive: true, force: true });
		});

		it("merges diverging branches with --no-ff, writing MERGE_HEAD before the merge commit", () => {
			sh(
				linked,
				"git checkout -q -b merge-topic && echo topic > merge-topic-file && git add merge-topic-file && git commit -q -m topic",
			);
			const topic = git(linked, "rev-parse", "HEAD").toString().trim();
			sh(
				linked,
				"git checkout -q -b merge-target HEAD~1 && echo target > merge-target-file && git add merge-target-file && git commit -q -m target",
			);
			const target = git(linked, "rev-parse", "HEAD").toString().trim();
			sh(linked, "git merge --no-ff --no-commit merge-topic");
			expect(readFileSync(join(admin, "MERGE_HEAD"), "utf8").trim()).toBe(topic);
			sh(linked, "git commit -q -m merged");
			expect(git(linked, "show", "-s", "--format=%P", "HEAD").toString().trim().split(" ")).toEqual([target, topic]);
			expect(existsSync(join(admin, "MERGE_HEAD"))).toBe(false);
			for (const file of ["merge-topic-file", "merge-target-file"])
				expect(existsSync(join(linked, file))).toBe(true);
		});

		it("squash-merges, and cherry-picks two commits, which write SQUASH_MSG and the sequencer directory", () => {
			sh(
				linked,
				"git checkout -q -b topic-sq && echo s1 > sq1 && git add sq1 && git commit -q -m s1 && echo s2 > sq2 && git add sq2 && git commit -q -m s2",
			);
			const [one, two] = git(linked, "rev-list", "--reverse", "-2", "HEAD").toString().trim().split("\n");
			sh(
				linked,
				"git checkout -q -b squash-target HEAD~2 && git merge --squash topic-sq && git commit -q -m squashed",
			);
			expect(existsSync(join(linked, "sq2"))).toBe(true);
			sh(linked, `git checkout -q -b pick-target HEAD~1 && git cherry-pick ${one} ${two}`);
			expect(git(linked, "log", "-2", "--format=%s").toString().trim().split("\n")).toEqual(["s2", "s1"]);
		});

		it("cannot plant a repository in the sequencer directory, whose head file stays writable for git", () => {
			for (const command of [
				`mkdir -p '${admin}/sequencer/x/.git'`,
				`mkdir -p '${admin}/sequencer/objects'`,
				`mkdir -p '${admin}/sequencer/refs'`,
			])
				expect(failure(() => sh(linked, command)).status, command).not.toBe(0);
			expect(existsSync(join(admin, "sequencer", "x", ".git"))).toBe(false);
			expect(existsSync(join(admin, "sequencer", "objects"))).toBe(false);
			expect(existsSync(join(admin, "sequencer", "refs"))).toBe(false);
			rmSync(join(admin, "sequencer"), { recursive: true, force: true });
			sh(linked, "git checkout -q -b seq-target topic-sq~2 && git cherry-pick topic-sq~1 topic-sq");
			expect(git(linked, "log", "-2", "--format=%s").toString().trim().split("\n")).toEqual(["s2", "s1"]);
		});

		it("commits only the named paths, and stashes and restores changes", () => {
			sh(linked, "echo a > pa && echo b > pb && git add pa pb && git commit -q -m both");
			sh(linked, "echo a2 > pa && echo b2 > pb && git commit -q -m partial -- pa");
			expect(git(linked, "show", "--stat", "--format=%s", "HEAD").toString()).toContain("pa");
			expect(git(linked, "show", "--stat", "--format=%s", "HEAD").toString()).not.toContain("pb");
			sh(linked, "git stash && git stash pop");
			expect(readFileSync(join(linked, "pb"), "utf8")).toBe("b2\n");
		});

		it("runs here-documents in zsh, bash, and sh with the wrapper's temp variables", () => {
			const heredoc = (shell, flags) =>
				execFileSync(
					"sandbox-exec",
					[
						"-f",
						profilePath,
						"env",
						`TMPDIR=${run}`,
						`TMPPREFIX=${run}/zsh`,
						shell,
						flags,
						"cat <<EOF\nhello\nEOF",
					],
					{ cwd: linked, encoding: "utf8", stdio: "pipe", env: env() },
				);
			expect(heredoc("/bin/zsh", "-lc")).toBe("hello\n");
			expect(heredoc("/bin/bash", "-c")).toBe("hello\n");
			expect(heredoc("/bin/sh", "-c")).toBe("hello\n");
		});

		it("can write the per-run directory", () => {
			sh(linked, `touch '${run}/ok'`);
			expect(existsSync(join(run, "ok"))).toBe(true);
		});
	});

	describe.skipIf(!sandboxExec)("the wrapper end to end, with a stand-in codex", () => {
		it("passes only an allow-list of variables, points TMPDIR and the npm cache at the run, passes the prompt after --, and cleans up", () => {
			const freshHome = join(root, "runtime-home");
			mkdirSync(freshHome);
			expect(existsSync(join(freshHome, ".codex"))).toBe(false);
			const prompt = join(root, "dash.md");
			writeFileSync(prompt, "--not-an-option please\n");
			const log = join(root, "wrapper.log");
			const kept = {
				USER: "u",
				LOGNAME: "u",
				SHELL: "/bin/sh",
				TERM: "xterm",
				LANG: "en_AU.UTF-8",
				LC_ALL: "en_AU.UTF-8",
				TZ: "UTC",
				EDITOR: "vi",
				CODEX_FOO: "c",
				GIT_AUTHOR_NAME: "a",
				GIT_COMMITTER_NAME: "c",
			};
			const dropped = {
				SSH_AUTH_SOCK: "/tmp/agent",
				AWS_SECRET_ACCESS_KEY: "s",
				NPM_CONFIG_FOO: "s",
				OPENAI_API_KEY: "s",
				GH_TOKEN: "s",
				DATABASE_URL: "s",
				SOME_SECRET_X: "s",
				DB_PASSWORD: "s",
			};
			execFileSync(script, [linked, "m", prompt, log], {
				stdio: "pipe",
				input: "pending input\n",
				env: { ...env(), ...kept, ...dropped, HOME: freshHome, CODEX_HOME: join(freshHome, ".codex") },
			});
			const out = readFileSync(log, "utf8");
			expect(out.split("\n").filter((line) => line.startsWith("arg:"))).toEqual([
				"arg:exec",
				"arg:--dangerously-bypass-approvals-and-sandbox",
				"arg:--model",
				"arg:m",
				"arg:-C",
				`arg:${linked}`,
				"arg:--",
				"arg:--not-an-option please",
			]);
			expect(out).toMatch(/env:TMPDIR=.*\/codex-run\.[A-Za-z0-9]+/);
			expect(out).toMatch(/env:npm_config_cache=.*\/codex-run\.[A-Za-z0-9]+\/npm-cache/);
			expect(out).toMatch(/env:MELIAN_STATE_DIR=.*\/codex-run\.[A-Za-z0-9]+\/melian\n/);
			expect(out).toMatch(/env:TMPPREFIX=.*\/codex-run\.[A-Za-z0-9]+\/zsh\n/);
			expect(out).toContain("zsh-heredoc-ok");
			expect(out).not.toContain("zsh-heredoc-failed");
			expect(out).toContain(`env:HOME=${freshHome}`);
			expect(out).toContain(`env:PATH=${bin}:`);
			for (const [name, value] of Object.entries(kept)) expect(out).toContain(`env:${name}=${value}\n`);
			for (const name of Object.keys(dropped)) expect(out).not.toContain(`env:${name}=`);
			expect(out).toContain("probe-ok");
			expect(out).toContain("cache-ok");
			expect(out).toContain("stdin:eof");
			for (const dir of ["shell_snapshots", "memories", ".tmp"])
				expect(existsSync(join(freshHome, ".codex", dir))).toBe(false);
			for (const dir of codexNames) expect(existsSync(join(freshHome, ".codex", dir))).toBe(true);
			expect(execFileSync("ls", [join(root, "tmp")]).toString()).not.toMatch(/codex-run\./);
			expect(execFileSync("ls", [join(root, "tmp")]).toString()).not.toMatch(/codex-seatbelt/);
		});

		it("runs codex inside the sandbox: a write to the home directory and a nested .git both fail", () => {
			const escapeBin = join(root, "escape-bin");
			mkdirSync(escapeBin);
			writeFileSync(
				join(escapeBin, "codex"),
				'#!/bin/sh\ntouch "$HOME/escape" 2>/dev/null && echo escape:allowed || echo escape:denied\nmkdir -p sub-e2e && mkdir sub-e2e/.git 2>/dev/null && echo nested:allowed || echo nested:denied\n',
			);
			chmodSync(join(escapeBin, "codex"), 0o755);
			const prompt = join(root, "escape.md");
			writeFileSync(prompt, "go\n");
			const log = join(root, "escape.log");
			execFileSync(script, [linked, "m", prompt, log], {
				stdio: "pipe",
				env: { ...env(), PATH: `${escapeBin}:${env().PATH}` },
			});
			const out = readFileSync(log, "utf8");
			expect(out).toContain("escape:denied");
			expect(out).toContain("nested:denied");
			expect(existsSync(join(home, "escape"))).toBe(false);
			expect(existsSync(join(linked, "sub-e2e", ".git"))).toBe(false);
			expect(existsSync(join(linked, "sub-e2e"))).toBe(true);
		});

		it("points MELIAN_STATE_DIR into scratch, where Melian can write, and keeps the clone's own state closed", () => {
			const stateBin = join(root, "state-bin");
			mkdirSync(stateBin);
			writeFileSync(
				join(stateBin, "codex"),
				`#!/bin/sh\necho "state:$MELIAN_STATE_DIR"\nmkdir -p "$MELIAN_STATE_DIR/clone" && touch "$MELIAN_STATE_DIR/clone/x.sqlite" && echo state:writable\nmkdir '${main}/.git/melian' 2>/dev/null && echo clone:allowed || echo clone:denied\n`,
			);
			chmodSync(join(stateBin, "codex"), 0o755);
			const prompt = join(root, "state.md");
			writeFileSync(prompt, "go\n");
			const log = join(root, "state.log");
			const stateScratch = join(root, "state-scratch");
			execFileSync(script, [linked, "m", prompt, log, stateScratch], {
				stdio: "pipe",
				env: { ...env(), PATH: `${stateBin}:${env().PATH}` },
			});
			const out = readFileSync(log, "utf8");
			expect(out).toContain(`state:${stateScratch}/melian\n`);
			expect(out).toContain("state:writable");
			expect(out).toContain("clone:denied");
			expect(existsSync(join(stateScratch, "melian", "clone", "x.sqlite"))).toBe(true);
			expect(existsSync(join(main, ".git", "melian"))).toBe(false);
		});

		it("exits 143 on TERM, killing the task's background child and removing the run directory and profile", async () => {
			const termBin = join(root, "term-bin");
			const termTmp = join(root, "tmp-term");
			mkdirSync(termBin);
			mkdirSync(termTmp);
			writeFileSync(join(termBin, "codex"), "#!/bin/sh\nsleep 3019 &\necho $! > term-sleeper.pid\nsleep 3018\n");
			chmodSync(join(termBin, "codex"), 0o755);
			const prompt = join(root, "term.md");
			writeFileSync(prompt, "go\n");
			const pidFile = join(linked, "term-sleeper.pid");
			const wrapper = spawn(script, [linked, "m", prompt, join(root, "term.log")], {
				stdio: "ignore",
				env: { ...env(), TMPDIR: termTmp, PATH: `${termBin}:${env().PATH}` },
			});
			const exited = new Promise((resolve) => wrapper.on("exit", (code, signal) => resolve({ code, signal })));
			try {
				for (let i = 0; i < 300 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()); i++)
					await new Promise((resolve) => setTimeout(resolve, 100));
				const pid = Number(readFileSync(pidFile, "utf8"));
				expect(pid).toBeGreaterThan(1);
				expect(readdirSync(termTmp).some((name) => name.startsWith("codex-run."))).toBe(true);
				wrapper.kill("SIGTERM");
				expect(await exited).toEqual({ code: 143, signal: null });
				expect(() => process.kill(pid, 0)).toThrow();
				expect(readdirSync(termTmp)).toEqual([]);
			} finally {
				if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
				if (existsSync(pidFile)) {
					try {
						process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
					} catch {}
					rmSync(pidFile);
				}
			}
		});

		it("kills a backgrounded child when the wrapper returns, and returns codex's exit status", () => {
			const sleeperBin = join(root, "sleeper-bin");
			mkdirSync(sleeperBin);
			writeFileSync(join(sleeperBin, "codex"), "#!/bin/sh\nsleep 3017 &\necho $! > sleeper.pid\nexit 7\n");
			chmodSync(join(sleeperBin, "codex"), 0o755);
			const prompt = join(root, "sleeper.md");
			writeFileSync(prompt, "go\n");
			const pidFile = join(linked, "sleeper.pid");
			try {
				const result = failure(() =>
					execFileSync(script, [linked, "m", prompt, join(root, "sleeper.log")], {
						stdio: "pipe",
						env: { ...env(), PATH: `${sleeperBin}:${env().PATH}` },
					}),
				);
				expect(result.status).toBe(7);
				const pid = Number(readFileSync(pidFile, "utf8"));
				expect(pid).toBeGreaterThan(1);
				expect(() => process.kill(pid, 0)).toThrow();
			} finally {
				if (existsSync(pidFile)) {
					const pid = Number(readFileSync(pidFile, "utf8"));
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
					rmSync(pidFile);
				}
			}
		});

		it("creates the Codex directories under CODEX_HOME and passes it through", () => {
			const elsewhere = join(root, "elsewhere-codex");
			const prompt = join(root, "home.md");
			writeFileSync(prompt, "go\n");
			const log = join(root, "home.log");
			execFileSync(script, [linked, "m", prompt, log], { stdio: "pipe", env: { ...env(), CODEX_HOME: elsewhere } });
			expect(readFileSync(log, "utf8")).toContain(`env:CODEX_HOME=${elsewhere}\n`);
			for (const dir of ["sessions", "cache", "attachments"]) expect(existsSync(join(elsewhere, dir))).toBe(true);
		});

		it("writes under a CODEX_HOME that does not exist yet and sits behind a symlinked parent", () => {
			const realParent = join(root, "real-codex-parent");
			mkdirSync(realParent);
			symlinkSync(realParent, join(root, "link-codex-parent"));
			const spy = join(root, "spy-bin");
			mkdirSync(spy);
			writeFileSync(
				join(spy, "codex"),
				'#!/bin/sh\ntouch "$CODEX_HOME/sessions/probe" 2>/dev/null && echo sessions:allowed || echo sessions:denied\n',
			);
			chmodSync(join(spy, "codex"), 0o755);
			const prompt = join(root, "link.md");
			writeFileSync(prompt, "go\n");
			const log = join(root, "link.log");
			execFileSync(script, [linked, "m", prompt, log], {
				stdio: "pipe",
				env: { ...env(), PATH: `${spy}:${env().PATH}`, CODEX_HOME: join(root, "link-codex-parent", "codex-home") },
			});
			expect(readFileSync(log, "utf8")).toContain("sessions:allowed");
			expect(existsSync(join(realParent, "codex-home", "sessions", "probe"))).toBe(true);
		});

		it("makes a relative scratch directory absolute for the profile and the npm cache", () => {
			const prompt = join(root, "rel.md");
			writeFileSync(prompt, "go\n");
			const log = join(root, "rel.log");
			execFileSync(script, [linked, "m", prompt, log, "rel-scratch"], { stdio: "pipe", cwd: root, env: env() });
			const out = readFileSync(log, "utf8");
			expect(out).toContain(`env:npm_config_cache=${root}/rel-scratch/npm-cache\n`);
			expect(out).toContain("cache-ok");
			expect(existsSync(join(root, "rel-scratch", "npm-cache", "probe"))).toBe(true);
			expect(existsSync(join(linked, "rel-scratch"))).toBe(false);
		});

		it("allows a scratch directory that differs from the run directory, and points the cache at it", () => {
			const scratch = join(root, "scratch-abs");
			const prompt = join(root, "abs.md");
			writeFileSync(prompt, "go\n");
			const log = join(root, "abs.log");
			execFileSync(script, [linked, "m", prompt, log, scratch], { stdio: "pipe", env: env() });
			const out = readFileSync(log, "utf8");
			expect(out).toContain(`env:npm_config_cache=${scratch}/npm-cache\n`);
			expect(out).toMatch(/env:TMPDIR=.*\/codex-run\.[A-Za-z0-9]+\n/);
			expect(out).not.toContain(`env:TMPDIR=${scratch}`);
			expect(out).toContain("cache-ok");
			const text = execFileSync(script, ["--print-profile", linked, scratch, run], { encoding: "utf8", env: env() });
			const escaped = scratch.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
			expect(block(text, "allow file-write*")).toContain(`(regex #"^${escaped}/")`);
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

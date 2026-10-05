import { execFile, execFileSync } from "node:child_process";
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
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "codex-sandboxed.sh");
const git = (cwd, ...args) =>
	execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });

const sandboxExec = existsSync("/usr/bin/sandbox-exec");
const realAgentSocket = (() => {
	try {
		return execFileSync("launchctl", ["getenv", "SSH_AUTH_SOCK"], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
})();

const failure = (fn) => {
	try {
		fn();
	} catch (error) {
		return { status: error.status, stderr: String(error.stderr) };
	}
	return { status: 0, stderr: "" };
};

describe("codex-sandboxed.sh profile", () => {
	let root;
	let main;
	let linked;
	let home;
	let run;
	let scratch;
	let profilePath;
	let admin;
	let bin;

	const env = () => ({ ...process.env, HOME: home, TMPDIR: join(root, "tmp"), PATH: `${bin}:${process.env.PATH}` });
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
			'#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\nenv | sed \'s/^/env:/\'\ntouch "$TMPDIR/probe" && echo probe-ok\ntouch "$npm_config_cache/probe" && echo cache-ok\nif read -r line; then echo "stdin:data"; else echo "stdin:eof"; fi\n',
		);
		chmodSync(join(bin, "codex"), 0o755);
		for (const dir of ["sessions", "log", "hooks"]) mkdirSync(join(home, ".codex", dir), { recursive: true });
		writeFileSync(join(home, ".codex", "config.toml"), "");
		profilePath = join(root, "profile.sb");
		writeFileSync(profilePath, profile(linked, scratch));
	});

	const tmpProbe = () => `/private/tmp/codex-sandboxed-probe-${basename(root)}`;

	afterAll(() => {
		rmSync(tmpProbe(), { force: true });
		rmSync(root, { recursive: true, force: true });
	});

	it("looks up only named Mach services, never launchd or LaunchServices", () => {
		const text = profile(linked, scratch);
		expect(text).not.toMatch(/^\(allow mach-lookup\)$/m);
		for (const name of [
			"com.apple.SecurityServer",
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
			'(deny file-write-create\n  (require-all\n    (subpath "' + linked + '")\n    (vnode-type SYMLINK)))',
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
		expect(allow).toContain(`(subpath "${linked}")`);
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

	it("names CODEX_HOME instead of ~/.codex when it is set, and refuses a relative one", () => {
		const elsewhere = join(root, "elsewhere-codex");
		const text = execFileSync(script, ["--print-profile", linked, run, run], {
			encoding: "utf8",
			env: { ...env(), CODEX_HOME: elsewhere },
		});
		const allow = block(text, "allow file-write*");
		expect(allow).toContain(`(subpath "${elsewhere}/sessions")`);
		expect(allow).toContain(`(literal "${elsewhere}/history.jsonl")`);
		expect(allow).toContain(`^${elsewhere}/[^/]+\\.sqlite`);
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
			`(literal "${home}/.codex/config.toml")`,
			`(literal "${home}/.codex/auth.json")`,
			`(subpath "${home}/.codex/hooks")`,
		]) {
			expect(deny).toContain(path);
		}
		expect(text.indexOf("(deny file-write*")).toBeGreaterThan(text.indexOf("(allow file-write*"));
	});

	it("denies a planted repository in every persistent writable subtree, with the path escaped", () => {
		const text = profile(linked, scratch);
		const deny = block(text, "deny file-write*");
		const files = block(text, "deny file-write-create file-write-data file-write-unlink");
		const esc = (path) => path.replace(/[[\].*^$+?(){}|\\]/g, "\\$&");
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
			const escaped = esc(path);
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
		for (const tree of ["refs", "logs/refs"])
			expect(allow).toContain(`(regex #"^${main}/\\.git/${tree}/remotes/[^/]+/HEAD([.]lock)?$")`);
		expect(allow).not.toContain("commondir");
	});

	it("denies nothing under the run directory, which the wrapper deletes, but everything under a separate scratch", () => {
		expect(profile(linked)).not.toContain(`^${run}/`);
		const text = profile(linked, scratch);
		expect(text).not.toContain(`^${run}/`);
		for (const name of ["[.][gG][iI][tT](/|$)", "([hH][eE][aA][dD]|[cC][oO][mM][mM][oO][nN][dD][iI][rR])$"])
			expect(text).toContain(`^${scratch}/(.*/)?${name}`);
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

	it("names the target of a symlinked .env, since seatbelt matches real paths", () => {
		const target = join(run, "real.env");
		writeFileSync(target, "SECRET=1\n");
		symlinkSync(target, join(linked, ".env"));
		try {
			const deny = block(profile(linked), "deny file-read*");
			expect(deny).toContain(`(literal "${target}")`);
			expect(deny).not.toContain(`(literal "${linked}/.env")`);
		} finally {
			rmSync(join(linked, ".env"), { force: true });
		}
	});

	it("names the target of a relative symlinked .env too", () => {
		const target = join(linked, "real.env");
		writeFileSync(target, "SECRET=1\n");
		symlinkSync("./real.env", join(linked, ".env"));
		try {
			const deny = block(profile(linked), "deny file-read*");
			expect(deny).toContain(`(literal "${target}")`);
			expect(deny).not.toContain(`(literal "${linked}/.env")`);
		} finally {
			rmSync(join(linked, ".env"), { force: true });
			rmSync(target, { force: true });
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

		it("resolves the user, yet cannot start a process through launchd or LaunchServices", () => {
			expect(sh(linked, "id -un").toString().trim()).not.toBe("");
			for (const command of ["launchctl submit -l melian-probe -- /usr/bin/true", "open -g -j -a Calculator"])
				expect(failure(() => sh(linked, command)).status, command).not.toBe(0);
		});

		it("serves and fetches over loopback, but cannot connect to a unix-domain socket", async () => {
			const loopback =
				"const h=require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',async()=>{console.log('served',await (await fetch('http://127.0.0.1:'+h.address().port)).text());h.close()})";
			expect(sandboxedNode(loopback)).toContain("served ok");
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

		it.skipIf(!realAgentSocket)("cannot reach the user's ssh agent", () => {
			expect(failure(() => sh(linked, `SSH_AUTH_SOCK='${realAgentSocket}' ssh-add -l`)).status).toBe(2);
		});

		const sandboxedNode = (code) =>
			execFileSync("sandbox-exec", ["-f", profilePath, process.execPath, "-e", code], { env: env() }).toString();

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
		});

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

		it("cannot write under the home directory, /private/tmp, or ~/.npm", () => {
			expect(failure(() => sh(linked, `touch '${home}/escape'`)).status).not.toBe(0);
			expect(failure(() => sh(linked, `mkdir -p '${home}/.npm/_npx'`)).status).not.toBe(0);
			expect(failure(() => sh(linked, `touch '${tmpProbe()}'`)).status).not.toBe(0);
			expect(failure(() => sh(linked, `touch '${join(root, "tmp")}/outside-run'`)).status).not.toBe(0);
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

		it("commits only the named paths, and stashes and restores changes", () => {
			sh(linked, "echo a > pa && echo b > pb && git add pa pb && git commit -q -m both");
			sh(linked, "echo a2 > pa && echo b2 > pb && git commit -q -m partial -- pa");
			expect(git(linked, "show", "--stat", "--format=%s", "HEAD").toString()).toContain("pa");
			expect(git(linked, "show", "--stat", "--format=%s", "HEAD").toString()).not.toContain("pb");
			sh(linked, "git stash && git stash pop");
			expect(readFileSync(join(linked, "pb"), "utf8")).toBe("b2\n");
		});

		it("can write the per-run directory", () => {
			sh(linked, `touch '${run}/ok'`);
			expect(existsSync(join(run, "ok"))).toBe(true);
		});
	});

	describe.skipIf(!sandboxExec)("the wrapper end to end, with a stand-in codex", () => {
		it("passes only an allow-list of variables, points TMPDIR and the npm cache at the run, passes the prompt after --, and cleans up", () => {
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
				env: { ...env(), ...kept, ...dropped },
			});
			const out = readFileSync(log, "utf8");
			expect(out).toContain("arg:--\narg:--not-an-option please");
			expect(out).toMatch(/env:TMPDIR=.*\/codex-run\.[A-Za-z0-9]+/);
			expect(out).toMatch(/env:npm_config_cache=.*\/codex-run\.[A-Za-z0-9]+\/npm-cache/);
			expect(out).toContain(`env:HOME=${home}`);
			expect(out).toContain(`env:PATH=${bin}:`);
			for (const [name, value] of Object.entries(kept)) expect(out).toContain(`env:${name}=${value}\n`);
			for (const name of Object.keys(dropped)) expect(out).not.toContain(`env:${name}=`);
			expect(out).toContain("probe-ok");
			expect(out).toContain("cache-ok");
			expect(out).toContain("stdin:eof");
			for (const dir of ["shell_snapshots", "memories", ".tmp"])
				expect(existsSync(join(home, ".codex", dir))).toBe(false);
			for (const dir of ["cache", "tmp", "ipc", "attachments"])
				expect(existsSync(join(home, ".codex", dir))).toBe(true);
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
		});

		it("kills a backgrounded child when the wrapper returns, and returns codex's exit status", () => {
			const sleeperBin = join(root, "sleeper-bin");
			mkdirSync(sleeperBin);
			writeFileSync(join(sleeperBin, "codex"), "#!/bin/sh\nsleep 3017 &\necho $! > sleeper.pid\nexit 7\n");
			chmodSync(join(sleeperBin, "codex"), 0o755);
			const prompt = join(root, "sleeper.md");
			writeFileSync(prompt, "go\n");
			const result = failure(() =>
				execFileSync(script, [linked, "m", prompt, join(root, "sleeper.log")], {
					stdio: "pipe",
					env: { ...env(), PATH: `${sleeperBin}:${env().PATH}` },
				}),
			);
			expect(result.status).toBe(7);
			const pid = Number(readFileSync(join(linked, "sleeper.pid"), "utf8"));
			expect(pid).toBeGreaterThan(1);
			expect(() => process.kill(pid, 0)).toThrow();
			rmSync(join(linked, "sleeper.pid"));
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
			expect(block(text, "allow file-write*")).toContain(`(subpath "${scratch}")`);
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

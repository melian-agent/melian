import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Probe } from "../packages/pipeline/src/probe.ts";
import {
	containmentPlan,
	expectedEnvironment,
	hostAddress,
	judge,
	Listener,
	loginNames,
	main,
	observeHost,
	outcome,
	probeRead,
	probeScript,
	publicRoots,
	recording,
	reportFields,
	shmId,
	tokenShapes,
	unfinished,
	walked,
} from "./round-probe-containment.mjs";

const canary = "melian-canary-0123";
const walkSummary = (files) => ({ files, directories: 1, unreadable: 0, bytes: 10, matches: [], cut: false, top: [] });

function plan() {
	return {
		canary,
		environment: [...expectedEnvironment],
		read: ["/tree", "/canary", "/home"],
		readable: ["/tree"],
		write: ["/run/home/written", "/tmp/melian-written"],
		writable: ["/run/home/written"],
		walk: ["/tree", "/usr"],
		network: [{ host: "api.github.com", port: 443 }],
		own: ["/tree"],
		public: ["/usr"],
	};
}

function report() {
	return {
		environment: [...expectedEnvironment],
		environmentCanary: false,
		selfEnviron: "clean",
		environCanary: [],
		reads: { "/tree": "listed", "/canary": "missing", "/home": "listed" },
		listings: { "/home": ["runner"] },
		writes: { "/run/home/written": "wrote", "/tmp/melian-written": "wrote" },
		tcp: { "api.github.com:443": "refused" },
		dns: "failed",
		httpProxy: { "CONNECT api.github.com:443": "403", "GET api.github.com:443": "closed" },
		socksProxy: { "api.github.com:443": "reply 2", "169.254.169.254:80": "request closed" },
		sudo: "refused",
		udp: "ENETUNREACH",
		ipc: { listed: false, removed: false },
		processes: 1,
		walk: { "/tree": walkSummary(3), "/usr": walkSummary(5) },
		sys: walkSummary(2),
	};
}

function host() {
	return {
		names: { "/home": ["runner", "melian"] },
		passages: { "/home": ["runner"] },
		written: [],
		listener: { connections: 0, datagrams: 0 },
	};
}

const argv = [["/usr/bin/unshare", "--ipc", "--", "bwrap", "sh"]];

describe("judge", () => {
	it("passes a probe every route of which was shut", () => {
		expect(judge(report(), plan(), argv, host())).toEqual([]);
	});

	it.each([
		["tcp", "api.github.com:443"],
		["httpProxy", "CONNECT api.github.com:443"],
		["httpProxy", "GET api.github.com:443"],
		["socksProxy", "api.github.com:443"],
	])("fails a probe whose %s report has no attempt %s", (route, attempt) => {
		const r = report();
		delete r[route][attempt];
		expect(judge(r, plan(), argv, host())).toEqual(["the probe did not try every route to api.github.com:443"]);
	});

	it("fails a probe whose connection or datagram reached the host's listener, whatever the probe reported", () => {
		for (const [listener, failure] of [
			[{ connections: 1, datagrams: 0 }, "1 connection reached the host's listener"],
			[{ connections: 0, datagrams: 2 }, "2 datagrams reached the host's listener"],
		])
			expect(judge(report(), plan(), argv, { ...host(), listener })).toEqual([failure]);
	});

	it.each([
		"dns",
		"environCanary",
		"environment",
		"environmentCanary",
		"httpProxy",
		"ipc",
		"listings",
		"processes",
		"reads",
		"selfEnviron",
		"socksProxy",
		"sudo",
		"sys",
		"tcp",
		"udp",
		"walk",
		"writes",
	])("fails, and judges nothing else, a probe that did not report %s", (field) => {
		const r = report();
		delete r[field];
		expect(judge(r, plan(), argv, host())).toEqual([`the probe did not report ${field}`]);
	});

	it("names each variable outside the expected set, and passes every expected one", () => {
		const r = report();
		r.environment = [...expectedEnvironment, "CLAUDE_CODE_OAUTH_TOKEN"];
		expect(judge(r, plan(), argv, host())).toEqual([
			"the probe's environment holds unexpected variables: CLAUDE_CODE_OAUTH_TOKEN",
		]);
	});

	it("judges against the plan's set, not the full list", () => {
		const r = report();
		r.environment = expectedEnvironment.filter((name) => name !== "LANG");
		const withoutLang = { ...plan(), environment: r.environment };
		expect(judge(r, withoutLang, argv, host())).toEqual([]);
		r.environment = [...expectedEnvironment];
		expect(judge(r, withoutLang, argv, host())).toEqual(["the probe's environment holds unexpected variables: LANG"]);
	});

	it("names each expected variable the probe lacks", () => {
		const r = report();
		r.environment = expectedEnvironment.filter((name) => name !== "PATH" && name !== "PWD");
		expect(judge(r, plan(), argv, host())).toEqual(["the probe's environment lacks expected variables: PATH, PWD"]);
	});

	it("fails on the canary in the environment, in /proc/self/environ, or in another process", () => {
		const r = report();
		r.environmentCanary = true;
		r.selfEnviron = "canary";
		r.environCanary = [12, 40];
		expect(judge(r, plan(), argv, host())).toEqual([
			"the probe's environment holds the canary",
			"/proc/self/environ read as canary, not clean",
			"the canary is in /proc of processes 12, 40",
		]);
	});

	it("fails when nothing was wrapped, or a command line holds the canary", () => {
		expect(judge(report(), plan(), [], host())).toEqual(["the sandbox wrapped no command"]);
		expect(judge(report(), plan(), [["sh"], ["sh", `-c=${canary}`]], host())).toEqual([
			"the sandbox's command line holds the canary",
		]);
	});

	it("fails a readable path the probe could not read, and accepts one it read", () => {
		const r = report();
		r.reads["/tree"] = "denied";
		expect(judge(r, plan(), argv, host())).toEqual(["/tree should be readable, and read as denied"]);
		r.reads["/tree"] = "read";
		expect(judge(r, plan(), argv, host())).toEqual([]);
	});

	it("fails a denied path that read or held the canary", () => {
		for (const outcome of ["read", "canary"]) {
			const r = report();
			r.reads["/canary"] = outcome;
			expect(judge(r, plan(), argv, host())).toEqual([`/canary read as ${outcome}`]);
		}
	});

	it("fails a denied listing that shows a host entry beyond bubblewrap's passages, and not one the host lacks", () => {
		const r = report();
		r.listings["/home"] = ["runner", "melian", "made-in-the-sandbox"];
		expect(judge(r, plan(), argv, host())).toEqual(["/home lists 1 of the host's entries"]);
		r.listings["/home"] = ["made-in-the-sandbox"];
		expect(judge(r, plan(), argv, host())).toEqual([]);
	});

	it("fails a writable path the probe could not write, and a refused write that reached the host", () => {
		const r = report();
		r.writes["/run/home/written"] = "denied";
		expect(judge(r, plan(), argv, { ...host(), written: ["/tmp/melian-written"] })).toEqual([
			"/run/home/written should be writable, and wrote denied",
			"the probe's write to /tmp/melian-written reached the host",
		]);
	});

	it("fails on a TCP connection or a DNS answer", () => {
		const r = report();
		r.tcp["169.254.169.254:80"] = "connected";
		r.dns = "resolved";
		expect(judge(r, plan(), argv, host())).toEqual([
			"a TCP connection to 169.254.169.254:80 opened",
			"a DNS lookup resolved",
		]);
	});

	it("fails when the HTTP proxy let a request through, never answered, or was not there to try", () => {
		for (const status of ["200", "302"]) {
			const r = report();
			r.httpProxy["GET api.github.com:443"] = status;
			expect(judge(r, plan(), argv, host())).toEqual([
				`the HTTP proxy answered GET api.github.com:443 with ${status}`,
			]);
		}
		const r = report();
		r.httpProxy = { missing: "HTTP_PROXY", "CONNECT api.github.com:443": "ECONNREFUSED" };
		expect(judge(r, { ...plan(), network: [] }, argv, host())).toEqual([
			"the probe has no HTTP_PROXY to try",
			"the HTTP proxy never answered CONNECT api.github.com:443: ECONNREFUSED",
		]);
	});

	it("fails a close that came after part of a reply", () => {
		const r = report();
		r.httpProxy["GET api.github.com:443"] = "closed after 12 bytes";
		r.socksProxy["169.254.169.254:80"] = "request closed after 1 bytes";
		expect(judge(r, plan(), argv, host())).toEqual([
			"the HTTP proxy never answered GET api.github.com:443: closed after 12 bytes",
			"the SOCKS proxy never answered for 169.254.169.254:80: request closed after 1 bytes",
		]);
	});

	it("accepts each answer a refusing SOCKS proxy gives, and fails a connection or a silence", () => {
		const r = report();
		r.socksProxy = { a: "reply 5", b: "authentication refused", c: "no acceptable method", d: "greeting closed" };
		expect(judge(r, { ...plan(), network: [] }, argv, host())).toEqual([]);
		r.socksProxy = { missing: "ALL_PROXY", a: "succeeded", b: "ECONNREFUSED" };
		expect(judge(r, { ...plan(), network: [] }, argv, host())).toEqual([
			"the probe has no ALL_PROXY to try",
			"the SOCKS proxy connected a",
			"the SOCKS proxy never answered for b: ECONNREFUSED",
		]);
	});

	it("fails when sudo ran", () => {
		const r = report();
		r.sudo = "ran";
		expect(judge(r, plan(), argv, host())).toEqual(["sudo -n true ran"]);
	});

	it("fails when the host's segment was listed, removed, or the check could not tell", () => {
		const cases = [
			[{ listed: true, removed: false }, "listed"],
			[{ listed: false, removed: true }, "removed"],
			[{ error: "ipcs failed" }, "ipcs failed"],
		];
		for (const [ipc, word] of cases) {
			const r = report();
			r.ipc = ipc;
			expect(judge(r, plan(), argv, host())).toEqual([`the host's System V segment was ${word}`]);
		}
	});

	it("fails a canary anywhere and a token shape outside public roots, and lets a public token shape pass", () => {
		const r = report();
		r.walk["/usr"].matches = [
			{ kind: "jwt", path: "/usr/lib/a" },
			{ kind: "canary", path: "/usr/lib/b" },
		];
		r.walk["/tree"].matches = [{ kind: "github token", path: "/tree/c" }];
		r.sys.matches = [{ kind: "private key", path: "/sys/d" }];
		expect(judge(r, plan(), argv, host())).toEqual([
			"/tree/c holds a github token",
			"/usr/lib/b holds a canary",
			"/sys/d holds a private key",
		]);
	});

	it("fails a walk cut at its limit, and a first root it read no file of", () => {
		const r = report();
		r.sys.cut = true;
		r.walk["/tree"].files = 0;
		expect(judge(r, plan(), argv, host())).toEqual([
			"the walk of /sys stopped at its entry or byte limit",
			"the walk read no file of /tree",
		]);
		const later = report();
		later.walk["/usr"].files = 0;
		expect(judge(later, plan(), argv, host())).toEqual([]);
	});

	it("fails a first root the walk has no summary of", () => {
		const r = report();
		delete r.walk["/tree"];
		expect(judge(r, plan(), argv, host())).toEqual(["the walk read no file of /tree"]);
	});

	it("reads a status as the proxy's only when it is the whole answer", () => {
		const r = report();
		r.httpProxy = { a: "ECONNRESET at 200", b: "200 then ECONNRESET", c: "half closed" };
		r.socksProxy = { d: "reply 91", e: "no reply 5", f: "ECONNRESET in reply 5 x" };
		expect(judge(r, { ...plan(), network: [] }, argv, host())).toEqual([
			"the HTTP proxy never answered a: ECONNRESET at 200",
			"the HTTP proxy never answered b: 200 then ECONNRESET",
			"the HTTP proxy never answered c: half closed",
			"the SOCKS proxy never answered for e: no reply 5",
			"the SOCKS proxy never answered for f: ECONNRESET in reply 5 x",
		]);
	});
});

describe("judge's read roots", () => {
	it("fails a root the policy grants that is neither the probe's own nor public", () => {
		const r = report();
		r.walk["/opt/secrets"] = walkSummary(1);
		const wider = { ...plan(), walk: ["/tree", "/usr", "/opt/secrets"] };
		expect(judge(r, wider, argv, host())).toEqual([
			"the policy lets a probe read /opt/secrets, which is neither its own nor a named public root",
		]);
	});
});

describe("walked", () => {
	it("summarises each walk and names each match, without its text", () => {
		const r = report();
		r.sys.top = ["class:3"];
		r.walk["/usr"].matches = [
			{ kind: "jwt", path: "/usr/lib/a" },
			{ kind: "canary", path: "/usr/lib/b" },
			{ kind: "anthropic key", path: "/usr/lib/e" },
		];
		r.walk["/tree"].matches = [{ kind: "github token", path: "/tree/c" }];
		expect(walked(r, plan())).toEqual([
			"/tree: 3 files, 1 directories, 0 unreadable, 10 bytes read",
			"/usr: 5 files, 1 directories, 0 unreadable, 10 bytes read",
			"/sys: 2 files, 1 directories, 0 unreadable; class:3",
			"/tree holds a github token shape in /tree/c",
			"/usr holds a jwt shape in /usr/lib/a",
			"/usr holds a canary shape in /usr/lib/b",
			"/usr holds a anthropic key shape in /usr/lib/e",
			"token shapes listed in 1 public roots: 2",
		]);
	});
});

describe("publicRoots", () => {
	const reasons = (path) => publicRoots.filter((root) => root.matches(path)).map((root) => root.reason);

	it("names the system's directories, npm packages and the running Node as public", () => {
		expect(["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/usr", "/usr/share"].map(reasons)).toEqual(
			Array(7).fill(["the system's programs and libraries"]),
		);
		expect(reasons("/work/melian/node_modules/@octokit")).toEqual(["installed npm packages"]);
		expect(reasons(process.execPath)).toEqual(["the Node binary that runs the round"]);
	});

	it("leaves every other root, and a name that only starts like a public one, not public", () => {
		for (const path of [
			"/tmp/melian-probe-x/tree",
			"/home/runner",
			"/usr2",
			"/binary",
			"/work/node_modules2",
			`${process.execPath}2`,
			"/opt/usr",
		])
			expect(reasons(path), path).toEqual([]);
	});
});

describe("tokenShapes", () => {
	it("matches each login shape a probe might find, and not text short of it", () => {
		const samples = {
			"github token": `ghp_${"a".repeat(36)}`,
			"github fine-grained token": `github_pat_${"a".repeat(50)}`,
			"anthropic key": `sk-ant-${"a".repeat(20)}`,
			jwt: `eyJ${"a".repeat(10)}.eyJ${"a".repeat(10)}.${"a".repeat(10)}`,
			// Joined at run time: the containment walk reads this file in the probe's tree, and a whole header there fails it.
			"private key": ["-----BEGIN RSA PRIVATE", "KEY-----"].join(" "),
		};
		const short = {
			"github token": `ghp_${"a".repeat(35)}`,
			"github fine-grained token": `github_pat_${"a".repeat(49)}`,
			"anthropic key": `sk-ant-${"a".repeat(19)}`,
			jwt: `eyJ${"a".repeat(9)}.eyJ${"a".repeat(10)}.${"a".repeat(10)}`,
			"private key": "-----BEGIN RSA PUBLIC KEY-----",
		};
		for (const short of [
			`eyJ${"a".repeat(10)}.eyJ${"a".repeat(9)}.${"a".repeat(10)}`,
			`eyJ${"a".repeat(10)}.eyJ${"a".repeat(10)}.${"a".repeat(9)}`,
		])
			expect(tokenShapes.jwt.test(short), short).toBe(false);
		expect(Object.keys(tokenShapes).sort()).toEqual(Object.keys(samples).sort());
		for (const [kind, shape] of Object.entries(tokenShapes)) {
			expect(shape.test(samples[kind]), kind).toBe(true);
			expect(shape.test(short[kind]), kind).toBe(false);
		}
	});
});

describe("the probe script", () => {
	const dirs = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("connects to a listener it may reach, and sends it a datagram", async () => {
		const dir = mkdtempSync(join(tmpdir(), "melian-containment-listener-"));
		dirs.push(dir);
		const seen = { connections: 0, datagrams: 0 };
		const tcp = createServer((socket) => {
			seen.connections++;
			socket.destroy();
		});
		const udp = createSocket("udp4").on("message", () => {
			seen.datagrams++;
		});
		try {
			await new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve));
			await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
			const targets = {
				canary: "melian-canary-unused",
				shm: "",
				shapes: {},
				read: [],
				write: [],
				network: [{ host: "127.0.0.1", port: tcp.address().port }],
				udp: { host: "127.0.0.1", port: udp.address().port },
				walk: [],
				byteLimit: 1,
				self: join(dir, "targets.json"),
			};
			writeFileSync(join(dir, "probe.mjs"), probeScript);
			writeFileSync(targets.self, JSON.stringify(targets));
			const child = spawn(process.execPath, [join(dir, "probe.mjs")], {
				cwd: dir,
				env: { PATH: process.env.PATH },
				stdio: ["ignore", "pipe", "inherit"],
			});
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk;
			});
			const status = await new Promise((resolve) => child.on("close", resolve));
			expect(status).toBe(0);
			const report = JSON.parse(output);
			expect(report.tcp).toEqual({ [`127.0.0.1:${targets.network[0].port}`]: "connected" });
			expect(report.udp).toBe("sent");
			expect(Object.keys(report).sort()).toEqual([...reportFields]);
			expect(seen).toEqual({ connections: 1, datagrams: 1 });
		} finally {
			await new Promise((resolve) => tcp.close(resolve));
			udp.close();
		}
	});

	// Runs the script outside the sandbox, on fake values, so what it detects is tested apart from what the sandbox hides.
	// With a sibling, another process holds the canary in its environment and its command line while the script runs.
	function collect(env, byteLimit = 16 * 1024 ** 3, sibling = false) {
		const dir = mkdtempSync(join(tmpdir(), "melian-containment-script-"));
		dirs.push(dir);
		const secret = `melian-canary-${randomBytes(16).toString("hex")}`;
		const walked = join(dir, "walked");
		mkdirSync(walked);
		const files = {
			late: join(walked, "late"),
			straddle: join(walked, "straddle"),
			clean: join(walked, "clean"),
			leak: join(dir, "leak"),
		};
		// A canary past the first 256 KiB, and a token across the boundary between two of the script's 1 MiB reads.
		writeFileSync(files.late, `${" ".repeat(300_000)}${secret}\n`);
		writeFileSync(files.straddle, `${" ".repeat(1_048_576 - 10)} ghp_${"A".repeat(36)} \n`);
		writeFileSync(files.clean, "nothing here\n");
		writeFileSync(files.leak, `${secret}\n`);
		const targets = {
			canary: secret,
			shm: "",
			shapes: Object.fromEntries(Object.entries(tokenShapes).map(([kind, shape]) => [kind, shape.source])),
			read: [files.leak, files.clean],
			write: [],
			network: [],
			udp: { host: "127.0.0.1", port: 9 },
			walk: [walked],
			byteLimit,
			self: join(dir, "targets.json"),
		};
		writeFileSync(join(dir, "probe.mjs"), probeScript);
		writeFileSync(targets.self, JSON.stringify(targets));
		const holder = sibling
			? spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)", secret], {
					env: { PATH: process.env.PATH, MELIAN_HELD: secret },
					stdio: "ignore",
				})
			: undefined;
		let run;
		try {
			run = spawnSync(process.execPath, [join(dir, "probe.mjs")], {
				cwd: dir,
				env: { PATH: process.env.PATH, ...env(secret) },
				encoding: "utf8",
				timeout: 120_000,
			});
		} finally {
			holder?.kill("SIGKILL");
		}
		expect(run.status).toBe(0);
		const bytes = Object.values(files)
			.filter((file) => file.startsWith(walked))
			.reduce((total, file) => total + readFileSync(file).length, 0);
		return { report: JSON.parse(run.stdout.trim().split("\n").at(-1)), files, bytes, walked, holder: holder?.pid };
	}

	it.runIf(process.platform === "linux")(
		"finds a canary in its environment and in a file it reads, and every match to the end of each walked file",
		{ timeout: 300_000 },
		() => {
			const { report, files, bytes, walked } = collect((secret) => ({ MELIAN_LEAKED: secret }));
			expect(report.environmentCanary).toBe(true);
			expect(report.selfEnviron).toBe("canary");
			expect(report.reads).toEqual({ [files.leak]: "canary", [files.clean]: "read" });
			const summary = report.walk[walked];
			expect(summary.files).toBe(3);
			expect(summary.bytes).toBe(bytes);
			expect(summary.cut).toBe(false);
			expect([...summary.matches].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
				{ kind: "canary", path: files.late },
				{ kind: "github token", path: files.straddle },
			]);
		},
	);

	it.runIf(process.platform === "linux")(
		"marks a walk cut once it reads its byte limit, and not one whose files end a byte short of it",
		{ timeout: 300_000 },
		() => {
			const whole = collect(() => ({}));
			const under = collect(() => ({}), whole.bytes + 1);
			expect(under.report.walk[under.walked].cut).toBe(false);
			const at = collect(() => ({}), whole.bytes);
			expect(at.report.walk[at.walked].cut).toBe(true);
		},
	);

	it.runIf(process.platform === "linux")(
		"finds the canary in another process's environment and command line",
		{ timeout: 300_000 },
		() => {
			const { report, holder } = collect(() => ({}), undefined, true);
			expect(report.environmentCanary).toBe(false);
			expect(report.environCanary).toEqual([`${holder}`, `${holder} cmdline`]);
		},
	);

	it.runIf(process.platform === "linux")(
		"fails every route the real script finds open, run outside the sandbox with each route left open",
		{ timeout: 300_000 },
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "melian-containment-open-"));
			dirs.push(dir);
			const secret = `melian-canary-${randomBytes(16).toString("hex")}`;
			// Stand-ins on PATH for a sudo that runs and an ipcs that lists the host's segment, which ipcrm then removes.
			const bin = join(dir, "bin");
			mkdirSync(bin);
			for (const [name, body] of [
				["sudo", "exit 0"],
				["ipcs", 'echo "0x00000000 4242 runner 600 1 0"'],
				["ipcrm", "exit 0"],
			])
				writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
			const leak = join(dir, "leak");
			writeFileSync(leak, `${secret}\n`);
			const listed = join(dir, "listed");
			mkdirSync(listed);
			writeFileSync(join(listed, "entry"), "x\n");
			const walkedRoot = join(dir, "walked");
			mkdirSync(walkedRoot);
			writeFileSync(join(walkedRoot, "file"), `${secret}\n`);
			const written = join(dir, "written");
			const listener = await Listener.open("127.0.0.1");
			const http = createServer((socket) => socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\n\r\n")));
			const socks = createServer((socket) => {
				// It asks for a username and password, then lets the request through, so the script must go on after it logs in.
				const replies = [
					[5, 2],
					[1, 0],
					[5, 0, 0, 1, 0, 0, 0, 0, 0, 0],
				];
				socket.on("data", () => socket.write(Buffer.from(replies.shift() ?? [])));
			});
			const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)", secret], {
				env: { PATH: process.env.PATH, MELIAN_HELD: secret },
				stdio: "ignore",
			});
			try {
				await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
				await new Promise((resolve) => socks.listen(0, "127.0.0.1", resolve));
				const { tcp, udp } = listener.targets();
				const plan = {
					canary: secret,
					shm: "4242",
					shapes: {},
					environment: ["PATH"],
					readable: [],
					read: [leak, listed],
					writable: [],
					write: [written],
					network: [tcp],
					udp,
					dns: "localhost",
					walk: [walkedRoot],
					byteLimit: 1,
					own: [walkedRoot],
					public: [],
					self: join(dir, "targets.json"),
				};
				writeFileSync(join(dir, "probe.mjs"), probeScript);
				writeFileSync(plan.self, JSON.stringify(plan));
				const child = spawn(process.execPath, [join(dir, "probe.mjs")], {
					cwd: dir,
					env: {
						PATH: `${bin}:${process.env.PATH}`,
						MELIAN_LEAKED: secret,
						HTTP_PROXY: `http://127.0.0.1:${http.address().port}`,
						ALL_PROXY: `socks5h://melian:open@127.0.0.1:${socks.address().port}`,
					},
					stdio: ["ignore", "pipe", "inherit"],
				});
				let output = "";
				child.stdout.on("data", (chunk) => {
					output += chunk;
				});
				expect(await new Promise((resolve) => child.on("close", resolve))).toBe(0);
				const report = JSON.parse(output);
				const host = {
					...observeHost(plan, []),
					listener: { connections: listener.connections, datagrams: listener.datagrams },
				};
				const target = `${tcp.host}:${tcp.port}`;
				const [first, second] = [child.pid, holder.pid].sort((a, b) => a - b);
				const inProc = (pid) => (pid === holder.pid ? [`${pid}`, `${pid} cmdline`] : [`${pid}`]);
				expect(judge(report, plan, [["node", "probe.mjs"]], host)).toEqual([
					"the probe's environment holds unexpected variables: ALL_PROXY, HTTP_PROXY, MELIAN_LEAKED",
					"the probe's environment holds the canary",
					"/proc/self/environ read as canary, not clean",
					`the canary is in /proc of processes ${[...inProc(first), ...inProc(second)].join(", ")}`,
					`${leak} read as canary`,
					`${listed} lists 1 of the host's entries`,
					`the probe's write to ${written} reached the host`,
					`a TCP connection to ${target} opened`,
					"a DNS lookup resolved",
					"1 connection reached the host's listener",
					"1 datagram reached the host's listener",
					`the HTTP proxy answered CONNECT ${target} with 200`,
					`the HTTP proxy answered GET ${target} with 200`,
					`the SOCKS proxy connected ${target}`,
					"sudo -n true ran",
					"the host's System V segment was listed",
					`${join(walkedRoot, "file")} holds a canary`,
					`the walk of ${walkedRoot} stopped at its entry or byte limit`,
					"the walk of /sys stopped at its entry or byte limit",
				]);
			} finally {
				holder.kill("SIGKILL");
				await listener.close();
				await new Promise((resolve) => http.close(resolve));
				await new Promise((resolve) => socks.close(resolve));
			}
		},
	);

	it.runIf(process.platform === "linux")(
		"reports a clean environment when no variable holds the canary",
		{ timeout: 300_000 },
		() => {
			const { report } = collect(() => ({ MELIAN_OTHER: "nothing" }));
			expect(report.environmentCanary).toBe(false);
			expect(report.selfEnviron).toBe("clean");
		},
	);
});

describe("unfinished", () => {
	const done = { exitCode: 0, signal: undefined, timedOut: false, truncated: false };

	it("passes a probe that exited 0 in time with its whole output", () => {
		expect(unfinished(done)).toBeUndefined();
	});

	it("names a probe that exited non-zero, was killed, timed out or was cut", () => {
		expect(unfinished({ ...done, exitCode: 2 })).toBe(
			"the containment probe did not finish: exit 2, timed out false, cut false",
		);
		expect(unfinished({ ...done, exitCode: undefined, signal: "SIGKILL" })).toBe(
			"the containment probe did not finish: exit SIGKILL, timed out false, cut false",
		);
		expect(unfinished({ ...done, timedOut: true })).toBe(
			"the containment probe did not finish: exit 0, timed out true, cut false",
		);
		expect(unfinished({ ...done, truncated: true })).toBe(
			"the containment probe did not finish: exit 0, timed out false, cut true",
		);
	});

	it("names a probe that exited 0 but whose processes could not be stopped", () => {
		expect(unfinished({ ...done, error: "the process table could not be read" })).toBe(
			"the containment probe's processes could not be stopped: the process table could not be read",
		);
	});
});

describe("observeHost", () => {
	let root;
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("lists each readable path with the way to what the policy reaches, and removes each refused write it finds", () => {
		root = mkdtempSync(join(tmpdir(), "melian-observe-"));
		const home = join(root, "home");
		mkdirSync(join(home, "runner", "work"), { recursive: true });
		mkdirSync(join(home, "melian"));
		const refused = join(root, "refused");
		const writable = join(root, "writable");
		writeFileSync(refused, "x");
		writeFileSync(writable, "x");
		const plan = {
			read: [home, join(root, "missing")],
			write: [writable, refused, join(root, "absent")],
			writable: [writable],
		};
		const host = observeHost(plan, [join(home, "runner", "work"), join(root, "elsewhere")]);
		expect({ ...host, names: { [home]: [...host.names[home]].sort() } }).toEqual({
			names: { [home]: ["melian", "runner"] },
			passages: { [home]: ["runner"] },
			written: [refused],
		});
		expect(existsSync(refused)).toBe(false);
		expect(existsSync(writable)).toBe(true);
	});

	it("reads the way to each reached path under the root", () => {
		root = mkdtempSync(join(tmpdir(), "melian-observe-"));
		const host = observeHost({ read: ["/"], write: [], writable: [] }, ["/usr/lib", "/tmp/x"]);
		expect(host.passages).toEqual({ "/": ["usr", "tmp"] });
	});

	it("leaves a host that holds a listing beyond the passages for judge to fail", () => {
		root = mkdtempSync(join(tmpdir(), "melian-observe-"));
		mkdirSync(join(root, "runner"));
		mkdirSync(join(root, "melian"));
		const p = { ...plan(), read: [root], readable: [] };
		const r = { ...report(), reads: { [root]: "listed" }, listings: { [root]: ["runner", "melian"] } };
		const observed = {
			...observeHost({ ...p, write: [], writable: [] }, [join(root, "runner", "x")]),
			listener: host().listener,
		};
		expect(judge(r, p, argv, observed)).toEqual([`${root} lists 1 of the host's entries`]);
	});
});

describe("outcome", () => {
	it("exits 0 with one line only when judge found nothing", () => {
		expect(outcome([])).toEqual({ code: 0, lines: ["every route tried is shut"] });
	});

	it("exits 1 and names each failure, a canary found or a write that reached the host", () => {
		expect(outcome(["/canary read as canary", "the probe's write to /tmp/x reached the host"])).toEqual({
			code: 1,
			lines: [
				"not contained: /canary read as canary",
				"not contained: the probe's write to /tmp/x reached the host",
			],
		});
	});
});

describe("containmentPlan", () => {
	const input = {
		canary,
		tag: "ab12",
		shm: "7",
		policy: { read: ["/r/tree", "/usr/lib", "/opt/x", "/usr/x/run", "/usr/x/probe"], write: ["/usr/x/run"] },
		files: ["/s/canary", "/h/.melian-canary-1"],
		scratch: "/s",
		temp: "/t",
		checkout: "/c",
		home: "/h",
		pid: 42,
		held: 9,
		runtimeUrl: undefined,
		lang: "C.UTF-8",
		listener: { tcp: { host: "10.1.0.4", port: 4100 }, udp: { host: "10.1.0.4", port: 4101 } },
	};

	it("tries every route out, and counts only public roots that are not the probe's own as public", () => {
		expect(containmentPlan(input)).toEqual({
			canary,
			shm: "7",
			shapes: Object.fromEntries(Object.entries(tokenShapes).map(([kind, shape]) => [kind, shape.source])),
			environment: [...expectedEnvironment],
			readable: ["/r/tree/package.json", "/r/tree"],
			read: [
				"/r/tree/package.json",
				"/r/tree",
				"/s/canary",
				"/h/.melian-canary-1",
				"/s",
				"/t",
				"/c",
				"/c/.git/config",
				"/c/package.json",
				"/h/.gitconfig",
				"/h",
				"/home/runner/actions-runner",
				"/home/runner/actions-runner/.credentials",
				"/home/runner/actions-runner/.runner",
				"/proc/42/environ",
				"/proc/42/fd/9",
				"/proc/42/cwd/package.json",
				"/proc/42/root/etc/passwd",
				"/etc/passwd",
				"/etc/hostname",
			],
			writable: ["/usr/x/run/home/written"],
			write: [
				"/usr/x/run/home/written",
				"/r/tree/written",
				"/s/written",
				"/tmp/melian-written-ab12",
				"/h/melian-written-ab12",
			],
			network: [
				{ host: "10.1.0.4", port: 4100 },
				{ host: "api.github.com", port: 443 },
				{ host: "169.254.169.254", port: 80 },
			],
			udp: { host: "10.1.0.4", port: 4101 },
			dns: "api.github.com",
			walk: input.policy.read,
			byteLimit: 17_179_869_184,
			own: ["/r/tree", "/usr/x/run", "/usr/x/probe"],
			public: ["/usr/lib"],
			self: "/usr/x/probe/targets.json",
		});
	});

	it("tries the Actions runtime's host when the runner names one, and expects LANG only when the host has it", () => {
		const plan = containmentPlan({ ...input, runtimeUrl: "https://runtime.example/x", lang: undefined });
		expect(plan.network).toEqual([
			{ host: "10.1.0.4", port: 4100 },
			{ host: "api.github.com", port: 443 },
			{ host: "169.254.169.254", port: 80 },
			{ host: "runtime.example", port: 443 },
		]);
		expect(plan.environment).toEqual(expectedEnvironment.filter((name) => name !== "LANG"));
		expect(expectedEnvironment).toContain("LANG");
	});
});

describe("shmId", () => {
	it("reads the last number ipcmk printed, with or without a line end, and none when it printed none", () => {
		expect(shmId("Shared memory id: 1234\n")).toBe("1234");
		expect(shmId("Shared memory id: 1234")).toBe("1234");
		expect(shmId("Shared memory id: 12 x")).toBe("");
	});
});

describe("hostAddress", () => {
	it("takes the first IPv4 address outside loopback, past an IPv6 one", () => {
		const interfaces = {
			lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
			eth0: [
				{ family: "IPv6", internal: false, address: "fe80::1" },
				{ family: "IPv4", internal: false, address: "10.0.0.5" },
				{ family: "IPv4", internal: false, address: "10.0.0.6" },
			],
		};
		expect(hostAddress(interfaces)).toBe("10.0.0.5");
	});

	it("finds none where every IPv4 address is loopback", () => {
		expect(
			hostAddress({
				lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
				eth0: [{ family: "IPv6", internal: false, address: "fe80::1" }],
			}),
		).toBeUndefined();
	});
});

describe("Listener", () => {
	it("passes its own control, starts its counts again, and then counts what reaches it", async () => {
		const listener = await Listener.open("127.0.0.1");
		try {
			await listener.control();
			expect([listener.connections, listener.datagrams]).toEqual([0, 0]);
			const { tcp, udp } = listener.targets();
			const socket = createConnection(tcp).on("error", () => {});
			const closed = new Promise((resolve) => socket.once("close", resolve));
			await new Promise((resolve) => socket.once("connect", resolve));
			const sender = createSocket("udp4");
			await new Promise((resolve) => sender.send("x", udp.port, udp.host, resolve));
			sender.close();
			await vi.waitFor(() => expect([listener.connections, listener.datagrams]).toEqual([1, 1]));
			await closed;
		} finally {
			await listener.close();
		}
	});

	it("closes the sockets it reaches itself from", async () => {
		const listener = await Listener.open("127.0.0.1");
		const open = () => process.getActiveResourcesInfo().filter((kind) => kind === "UDPWrap").length;
		try {
			const before = open();
			await listener.control();
			await vi.waitFor(() => expect(open()).toBe(before));
		} finally {
			await listener.close();
		}
	});

	it("frees both ports when it closes", async () => {
		const listener = await Listener.open("127.0.0.1");
		const { tcp, udp } = listener.targets();
		await listener.close();
		const server = createServer();
		const socket = createSocket("udp4");
		try {
			await new Promise((resolve, reject) => server.once("error", reject).listen(tcp.port, tcp.host, resolve));
			await new Promise((resolve, reject) => socket.once("error", reject).bind(udp.port, udp.host, resolve));
		} finally {
			await new Promise((resolve) => server.close(resolve));
			socket.close();
		}
	});

	it("fails its control, and throws nothing else, when its connection errors", { timeout: 20_000 }, async () => {
		const uncaught = [];
		const record = (error) => uncaught.push(error);
		process.on("uncaughtException", record);
		const listener = await Listener.open("127.0.0.1");
		const { udp } = listener.targets();
		listener.targets = () => ({ tcp: { host: "melian.invalid", port: 1 }, udp });
		try {
			await expect(listener.control()).rejects.toThrow("no connection from the host reached melian.invalid:1");
		} finally {
			await listener.close();
			process.off("uncaughtException", record);
		}
		expect(uncaught).toEqual([]);
	});

	it("fails its control, and throws nothing else, when its datagram errors", { timeout: 20_000 }, async () => {
		const uncaught = [];
		const record = (error) => uncaught.push(error);
		process.on("uncaughtException", record);
		const listener = await Listener.open("127.0.0.1");
		const { tcp } = listener.targets();
		listener.targets = () => ({ tcp, udp: { host: "melian.invalid", port: 1 } });
		try {
			await expect(listener.control()).rejects.toThrow("no datagram from the host reached melian.invalid:1");
		} finally {
			await listener.close();
			process.off("uncaughtException", record);
		}
		expect(uncaught).toEqual([]);
	});

	it("fails its control when no connection reaches it", { timeout: 20_000 }, async () => {
		const listener = new Listener("127.0.0.1", createServer(), createSocket("udp4"));
		await new Promise((resolve) => listener.tcp.listen(0, "127.0.0.1", resolve));
		await new Promise((resolve) => listener.udp.bind(0, "127.0.0.1", resolve));
		try {
			await expect(listener.control()).rejects.toThrow(/^no connection from the host reached 127\.0\.0\.1:\d+$/);
		} finally {
			await listener.close();
		}
	});

	it("fails its control when no datagram reaches it", { timeout: 20_000 }, async () => {
		const listener = new Listener("127.0.0.1", createServer(), createSocket("udp4"));
		listener.tcp.on("connection", (socket) => {
			listener.connections++;
			socket.destroy();
		});
		await new Promise((resolve) => listener.tcp.listen(0, "127.0.0.1", resolve));
		await new Promise((resolve) => listener.udp.bind(0, "127.0.0.1", resolve));
		try {
			await expect(listener.control()).rejects.toThrow(/^no datagram from the host reached 127\.0\.0\.1:\d+$/);
		} finally {
			await listener.close();
		}
	});
});

describe("main", () => {
	it("fails, and opens no probe, when the sandbox cannot run", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const open = vi.fn();
			const probes = { availability: async () => ({ available: false, reason: "bubblewrap is missing" }), open };
			await expect(main(probes)).resolves.toBe(1);
			expect(log.mock.calls).toEqual([["probes cannot run here: bubblewrap is missing"]]);
			expect(open).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

	function stoppedProbes(root, removed, result) {
		const tree = join(root, "tree");
		const run = join(root, "run");
		mkdirSync(tree);
		mkdirSync(run);
		mkdirSync(join(root, "probe"));
		return {
			availability: async () => ({ available: true }),
			sandbox: {},
			open: async () => ({
				policy: { read: [tree], write: [run] },
				run: async () =>
					result ?? { exitCode: null, signal: "SIGKILL", timedOut: true, truncated: false, output: "" },
				close: async () => ({ removed, leftover: removed ? undefined : join(root, "left") }),
			}),
		};
	}

	async function mainWith(probes, read = async () => ["node_modules"], interfaces = networkInterfaces()) {
		const root = mkdtempSync(join(tmpdir(), "melian-containment-main-"));
		const saved = Object.fromEntries(["HOME", "RUNNER_TEMP", ...loginNames].map((name) => [name, process.env[name]]));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const segments = () => spawnSync("ipcs", ["-m"], { encoding: "utf8" }).stdout;
		const before = { segments: segments(), fds: readdirSync("/proc/self/fd").length };
		try {
			mkdirSync(join(root, "home"));
			mkdirSync(join(root, "temp"));
			process.env.HOME = join(root, "home");
			process.env.RUNNER_TEMP = join(root, "temp");
			const opened = probes(root);
			const open = opened.open;
			let options;
			opened.open = async (script, given) => {
				options = given;
				return open(script, given);
			};
			const code = await main(opened, read, interfaces);
			return {
				code,
				logs: log.mock.calls,
				// A CI runner's git counts its calls in a file under HOME or RUNNER_TEMP; main did not plant it.
				left: [...readdirSync(join(root, "home")), ...readdirSync(join(root, "temp"))].filter(
					(name) => name !== ".git-invocation-counts.json",
				),
				segmentsKept: segments() === before.segments,
				fdsKept: readdirSync("/proc/self/fd").length === before.fds,
				head: options?.head,
			};
		} finally {
			log.mockRestore();
			for (const [name, value] of Object.entries(saved))
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			rmSync(root, { recursive: true, force: true });
		}
	}

	it.runIf(process.platform === "linux")(
		"fails a probe that did not finish, and leaves nothing it planted",
		async () => {
			const result = await mainWith((root) => stoppedProbes(root, true));
			expect(result).toEqual({
				code: 1,
				logs: [["the containment probe did not finish: exit SIGKILL, timed out true, cut false"]],
				left: [],
				segmentsKept: true,
				fdsKept: true,
				head: { checkout: process.cwd(), commit: head, read: ["node_modules"] },
			});
		},
	);

	it.runIf(process.platform === "linux")(
		"hands the probe the policy's probe.read, as read at the checkout's HEAD",
		async () => {
			const asked = [];
			const result = await mainWith(
				(root) => stoppedProbes(root, true),
				async (checkout, commit) => {
					asked.push([checkout, commit]);
					return ["node_modules", "extra"];
				},
			);
			expect(asked).toEqual([[process.cwd(), head]]);
			expect(result.head).toEqual({ checkout: process.cwd(), commit: head, read: ["node_modules", "extra"] });
		},
	);

	it.runIf(process.platform === "linux")(
		"fails, escaped and before it plants anything, when the policy cannot be read",
		async () => {
			const result = await mainWith(
				(root) => stoppedProbes(root, true),
				async () => {
					throw new Error("bad melian.yaml\u001b[2J");
				},
			);
			expect(result).toEqual({
				code: 1,
				logs: [["the policy's probe.read could not be read: bad melian.yaml\\u001b[2J"]],
				left: [],
				segmentsKept: true,
				fdsKept: true,
				head: undefined,
			});
		},
	);

	describe("probeRead", () => {
		const repos = [];
		afterEach(() => {
			for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
		});

		function commitWith(files) {
			const repo = mkdtempSync(join(tmpdir(), "melian-containment-policy-"));
			repos.push(repo);
			const git = (...args) =>
				spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
					cwd: repo,
					encoding: "utf8",
					env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" },
				}).stdout.trim();
			git("init", "--quiet");
			for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
			writeFileSync(join(repo, "README"), "x\n");
			git("add", ".");
			git("commit", "--quiet", "-m", "policy");
			const commit = git("rev-parse", "HEAD");
			// The working tree changes after the commit, and probeRead reads the commit.
			writeFileSync(join(repo, "melian.yaml"), "probe:\n  read: [node_modules, uncommitted]\n");
			return { repo, commit };
		}

		it("reads the committed policy's probe.read", async () => {
			const { repo, commit } = commitWith({ "melian.yaml": "probe:\n  read: [node_modules, extra]\n" });
			expect(await probeRead(repo, commit)).toEqual(["node_modules", "extra"]);
		});

		it("reads the default when the commit sets none", async () => {
			const { repo, commit } = commitWith({});
			expect(await probeRead(repo, commit)).toEqual(["node_modules"]);
		});
	});

	it.runIf(process.platform === "linux")("writes control characters it prints as visible escapes", async () => {
		const result = await mainWith((root) =>
			stoppedProbes(root, true, {
				exitCode: 0,
				signal: null,
				timedOut: false,
				truncated: false,
				output: "{}",
				error: "kill failed\u001b[2J",
			}),
		);
		expect(result.logs).toEqual([["the containment probe's processes could not be stopped: kill failed\\u001b[2J"]]);
	});

	it.runIf(process.platform === "linux")("names the probe's scratch when closing it left some", async () => {
		const result = await mainWith((root) => stoppedProbes(root, false));
		expect(result.logs).toEqual([
			["the containment probe did not finish: exit SIGKILL, timed out true, cut false"],
			[expect.stringMatching(/^the probe's scratch was left at \/.*\/left$/)],
		]);
	});

	it.runIf(process.platform === "linux")("fails a probe that finished when closing it left its scratch", async () => {
		const finished = { exitCode: 0, signal: null, timedOut: false, truncated: false, output: "{}" };
		const result = await mainWith((root) => stoppedProbes(root, false, finished));
		expect(result).toMatchObject({
			code: 1,
			logs: [[expect.stringMatching(/^the probe's scratch was left at \/.*\/left$/)]],
		});
	});

	it.runIf(process.platform === "linux")(
		"fails, and plants nothing, when the host has no address outside loopback",
		async () => {
			const loopback = { lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] };
			const result = await mainWith((root) => stoppedProbes(root, true), undefined, loopback);
			expect(result).toEqual({
				code: 1,
				logs: [["the host has no IPv4 address outside loopback for the probe to try"]],
				left: [],
				segmentsKept: true,
				fdsKept: true,
				head: undefined,
			});
		},
	);

	it.runIf(process.platform === "linux")(
		"fails, opens no probe, and leaves nothing, when its listener cannot open",
		async () => {
			const elsewhere = { eth0: [{ family: "IPv4", internal: false, address: "192.0.2.77" }] };
			const result = await mainWith((root) => stoppedProbes(root, true), undefined, elsewhere);
			expect(result).toEqual({
				code: 1,
				logs: [
					[expect.stringMatching(/^the host could not reach its own listener on 192\.0\.2\.77: .*EADDRNOTAVAIL/)],
				],
				left: [],
				segmentsKept: true,
				fdsKept: true,
				head: undefined,
			});
		},
	);

	it.runIf(process.platform === "linux")("leaves a file that was at a write target before it ran", async () => {
		const report = {
			walk: {},
			sys: { files: 0, directories: 0, unreadable: 0, top: [], matches: [] },
			environment: [],
			environCanary: [],
			selfEnviron: "clean",
			listings: {},
			processes: 0,
			tcp: {},
			httpProxy: {},
			socksProxy: {},
			ipc: {},
			reads: {},
			writes: {},
		};
		const finished = { exitCode: 0, signal: null, timedOut: false, truncated: false, output: JSON.stringify(report) };
		const result = await mainWith((root) => {
			writeFileSync(join(root, "home", "melian-written"), "mine\n");
			return stoppedProbes(root, true, finished);
		});
		expect(result.left).toEqual(["melian-written"]);
	});

	it.runIf(process.platform === "linux")(
		"fails a probe whose connection and datagram reached its listener",
		async () => {
			const result = await mainWith((root) => {
				const probes = stoppedProbes(root, true);
				const open = probes.open;
				probes.open = async (...given) => {
					const probe = await open(...given);
					probe.run = async () => {
						const plan = JSON.parse(readFileSync(join(root, "probe", "targets.json"), "utf8"));
						const socket = createConnection(plan.network[0]).on("error", () => {});
						await new Promise((resolve) => socket.once("close", resolve));
						const sender = createSocket("udp4");
						await new Promise((resolve) => sender.send("x", plan.udp.port, plan.udp.host, resolve));
						sender.close();
						await new Promise((resolve) => setTimeout(resolve, 200));
						return {
							exitCode: 0,
							signal: null,
							timedOut: false,
							truncated: false,
							output: JSON.stringify(report()),
						};
					};
					return probe;
				};
				return probes;
			});
			expect(result.code).toBe(1);
			expect(result.logs.flat()).toEqual(
				expect.arrayContaining([
					"not contained: 1 connection reached the host's listener",
					"not contained: 1 datagram reached the host's listener",
				]),
			);
		},
	);

	it("runs nothing when another module imports it", () => {
		const run = spawnSync(
			process.execPath,
			[
				"--conditions=@melian-agent/source",
				"--input-type=module",
				"-e",
				`await import(${JSON.stringify(join(import.meta.dirname, "round-probe-containment.mjs"))});`,
			],
			{ encoding: "utf8", timeout: 120_000 },
		);
		expect([run.status, run.stdout]).toEqual([0, ""]);
	});
});

// The step itself, run as CI and the round job run it. MELIAN_PROBE_SANDBOX=1 makes a missing sandbox fail this test.
const availability = await Probe.availability();
const required = process.env.MELIAN_PROBE_SANDBOX === "1";
describe.runIf(process.platform === "linux" && (availability.available || required))("the containment step", () => {
	it("shuts every route on this machine, and prints each line a reader of the log needs", { timeout: 600_000 }, () => {
		const run = spawnSync(
			process.execPath,
			["--conditions=@melian-agent/source", "scripts/round-probe-containment.mjs"],
			{
				cwd: join(import.meta.dirname, ".."),
				encoding: "utf8",
				timeout: 540_000,
			},
		);
		const lines = run.stdout.trim().split("\n");
		expect(lines.filter((line) => line.startsWith("not contained:"))).toEqual([]);
		expect(run.status).toBe(0);
		const kinds = lines
			.map(
				(line) =>
					/^(\/sys|token shapes listed|environment|processes visible|tcp|http proxy|socks proxy|ipc|reads|writes|udp|every route tried is shut)\b/.exec(
						line,
					)?.[1],
			)
			.filter((kind) => kind !== undefined);
		expect(kinds).toEqual([
			"/sys",
			"token shapes listed",
			"environment",
			"processes visible",
			"tcp",
			"http proxy",
			"socks proxy",
			"ipc",
			"reads",
			"writes",
			"udp",
			"every route tried is shut",
		]);
		expect(
			lines.filter((line) => / files, \d+ directories, \d+ unreadable, \d+ bytes read$/.test(line)).length,
		).toBeGreaterThan(0);
	});
});

describe("loginNames", () => {
	it("names every login the round job holds in its environment", () => {
		const workflow = readFileSync(
			join(import.meta.dirname, "..", ".github", "workflows", "melian-round.yml"),
			"utf8",
		);
		expect(loginNames).toEqual([
			"CLAUDE_CODE_OAUTH_TOKEN",
			"MELIAN_CODEX_ACCESS_TOKEN",
			"GITHUB_TOKEN",
			"ACTIONS_RUNTIME_TOKEN",
		]);
		for (const name of loginNames.slice(0, 2)) expect(workflow, name).toContain(name);
	});
});

describe("recording", () => {
	it("forwards every call to the sandbox, and records each command line", async () => {
		const calls = [];
		const sandbox = {
			platform: "linux",
			kind: "fake",
			unavailable: () => "no bwrap",
			open: async () => calls.push("open"),
			wrap: async (command) => [command, "wrapped"],
			cleanup: () => calls.push("cleanup"),
			close: async () => calls.push("close"),
		};
		const argv = [];
		const wrapped = recording(sandbox, argv);
		expect([wrapped.platform, wrapped.kind, wrapped.unavailable()]).toEqual(["linux", "fake", "no bwrap"]);
		await wrapped.open();
		expect(await wrapped.wrap("sh", {})).toEqual(["sh", "wrapped"]);
		wrapped.cleanup();
		await wrapped.close();
		expect(calls).toEqual(["open", "cleanup", "close"]);
		expect(argv).toEqual([["sh", "wrapped"]]);
	});
});

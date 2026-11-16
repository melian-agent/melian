import { describe, expect, it } from "vitest";
import { expectedEnvironment, judge, publicRoots, tokenShapes, walked } from "./round-probe-containment.mjs";

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
		ipc: { listed: false, removed: false },
		walk: { "/tree": walkSummary(3), "/usr": walkSummary(5) },
		sys: walkSummary(2),
	};
}

function host() {
	return { names: { "/home": ["runner", "melian"] }, passages: { "/home": ["runner"] }, written: [] };
}

const argv = [["/usr/bin/unshare", "--ipc", "--", "bwrap", "sh"]];

describe("judge", () => {
	it("passes a probe every route of which was shut", () => {
		expect(judge(report(), plan(), argv, host())).toEqual([]);
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
		expect(judge(r, plan(), argv, host())).toEqual([
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
		expect(judge(r, plan(), argv, host())).toEqual([]);
		r.socksProxy = { missing: "ALL_PROXY", a: "succeeded", b: "ECONNREFUSED" };
		expect(judge(r, plan(), argv, host())).toEqual([
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
			"the walk of /sys stopped at its entry limit",
			"the walk read no file of /tree",
		]);
		const later = report();
		later.walk["/usr"].files = 0;
		expect(judge(later, plan(), argv, host())).toEqual([]);
	});
});

describe("walked", () => {
	it("summarises each walk and names each match, without its text", () => {
		const r = report();
		r.sys.top = ["class:3"];
		r.walk["/usr"].matches = [
			{ kind: "jwt", path: "/usr/lib/a" },
			{ kind: "canary", path: "/usr/lib/b" },
		];
		r.walk["/tree"].matches = [{ kind: "github token", path: "/tree/c" }];
		expect(walked(r, plan())).toEqual([
			"/tree: 3 files, 1 directories, 0 unreadable, 10 bytes read",
			"/usr: 5 files, 1 directories, 0 unreadable, 10 bytes read",
			"/sys: 2 files, 1 directories, 0 unreadable; class:3",
			"/tree holds a github token shape in /tree/c",
			"/usr holds a jwt shape in /usr/lib/a",
			"/usr holds a canary shape in /usr/lib/b",
			"token shapes listed in 1 public roots: 1",
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
		expect(Object.keys(tokenShapes).sort()).toEqual(Object.keys(samples).sort());
		for (const [kind, shape] of Object.entries(tokenShapes)) {
			expect(shape.test(samples[kind]), kind).toBe(true);
			expect(shape.test(short[kind]), kind).toBe(false);
		}
	});
});

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	nodeReads,
	Probe,
	ProbeError,
	type ProbeInput,
	type ProbeOptions,
	type ProbePolicy,
	probeLimits,
	RuntimeSandbox,
	type SandboxRuntime,
} from "../src/probe.ts";

// Probe's own rules, on a sandbox that runs the command unconfined and records what it was asked. Every script here is
// the test's own. The real sandbox's attacks are in probe-sandbox.test.ts.

const original = process.env.TMPDIR;
let scratch: string;
let worktree: string;

function passthrough(
	overrides: {
		unavailable?: string;
		open?: () => Promise<void>;
		wrap?: () => Promise<never>;
		platform?: "darwin" | "linux";
	} = {},
) {
	const asked: { command: string; policy: ProbePolicy }[] = [];
	const sandbox = {
		platform: overrides.platform ?? "darwin",
		unavailable: vi.fn(() => overrides.unavailable),
		open: vi.fn(overrides.open ?? (async () => {})),
		wrap: vi.fn(
			overrides.wrap ??
				(async (command: string, policy: ProbePolicy) => {
					asked.push({ command, policy });
					return ["/bin/bash", "-c", command];
				}),
		),
		cleanup: vi.fn(),
		close: vi.fn(async () => {}),
	};
	return { sandbox, asked };
}

function options(sandbox: ProbeOptions["sandbox"], more: Partial<ProbeOptions> = {}): ProbeOptions {
	return { worktree, writer: { trusted: true, by: "writer" }, trustWriters: true, sandbox, ...more };
}

async function refusal(input: ProbeInput, given: ProbeOptions): Promise<ProbeError> {
	const error = await Probe.open(input, given).then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	if (!(error instanceof ProbeError)) throw new Error(`expected a ProbeError, got ${String(error)}`);
	expect(error.name).toBe("ProbeError");
	return error;
}

const left = () => readdirSync(scratch).filter((name) => name.startsWith("melian-probe-"));

beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(original ?? tmpdir(), "melian-probe-test-")));
	process.env.TMPDIR = scratch;
	worktree = join(scratch, "worktree");
	mkdirSync(worktree);
});

afterEach(() => {
	process.env.TMPDIR = original;
	if (original === undefined) delete process.env.TMPDIR;
	rmSync(scratch, { recursive: true, force: true });
});

describe("Probe.open", () => {
	it("refuses a head the host has not allowed, before anything else", async () => {
		const { sandbox } = passthrough();
		const error = await refusal(
			{ script: "" },
			options(sandbox, { writer: { trusted: false, detail: "the head is from a fork" } }),
		);
		expect(error.code).toBe("headNotAllowed");
		expect(error.message).toBe("the head's code may not run here: the head is from a fork");
		expect(sandbox.unavailable).not.toHaveBeenCalled();
		expect(sandbox.open).not.toHaveBeenCalled();
		expect(left()).toEqual([]);
	});

	it("refuses a writer's head when the policy trusts no writers, and runs a reviewer's", async () => {
		const { sandbox } = passthrough();
		const error = await refusal({ script: "" }, options(sandbox, { trustWriters: false }));
		expect(error.code).toBe("headNotAllowed");
		expect(error.message).toContain("trust.writers is false");
		const probe = await Probe.open(
			{ script: "" },
			options(sandbox, { trustWriters: false, writer: { trusted: true, by: "reviewer" } }),
		);
		await probe.close();
		expect(sandbox.open).toHaveBeenCalledOnce();
	});

	it("refuses where the sandbox cannot run, and never opens it", async () => {
		const { sandbox } = passthrough({ unavailable: "bubblewrap not found" });
		const error = await refusal({ script: "" }, options(sandbox));
		expect(error.code).toBe("sandboxUnavailable");
		expect(error.message).toBe("bubblewrap not found");
		expect(sandbox.open).not.toHaveBeenCalled();
		expect(left()).toEqual([]);
	});

	it("refuses when the sandbox fails to start, and removes its scratch", async () => {
		const { sandbox } = passthrough({
			open: async () => {
				throw new Error("user namespaces are restricted");
			},
		});
		const error = await refusal({ script: "" }, options(sandbox));
		expect(error.code).toBe("sandboxUnavailable");
		expect(error.message).toBe("the probe could not start: Error: user namespaces are restricted");
		expect(error.cause).toEqual(new Error("user namespaces are restricted"));
		expect(left()).toEqual([]);
	});

	it.each([
		["../escape"],
		["/absolute"],
		["a//b"],
		["a/./b"],
		["a/../b"],
		[".hidden"],
		["-flag"],
		["a/"],
		[""],
		["sp ace"],
		["probe.mjs"],
		["PROBE.MJS"],
	])("refuses the file path %j", async (path) => {
		const { sandbox } = passthrough();
		const error = await refusal({ script: "", files: [{ path, text: "" }] }, options(sandbox));
		expect(error.code).toBe("invalidProbe");
		expect(sandbox.open).not.toHaveBeenCalled();
	});

	it.each([
		[["a", "A"]],
		[["a", "a/b"]],
		[["a/b", "a"]],
		[["x/y", "x/y"]],
		[["a/b", "a/b/c"]],
		[["a/b/c", "a/b"]],
		[["a/b", "a/b/c/d"]],
	])("refuses colliding paths %j", async (paths) => {
		const { sandbox } = passthrough();
		const error = await refusal({ script: "", files: paths.map((path) => ({ path, text: "" })) }, options(sandbox));
		expect(error.code).toBe("invalidProbe");
		expect(error.message).toContain("collides");
	});

	it("writes the script and its files beside each other, readable and outside the writable directory", async () => {
		const { sandbox } = passthrough();
		const probe = await Probe.open(
			{
				script: "// s",
				files: [
					{ path: "a/b.json", text: "{}" },
					{ path: "a/c-1_x.txt", text: "c" },
				],
			},
			options(sandbox),
		);
		const { policy } = probe;
		const root = dirname(policy.write[0]!);
		expect(readdirSync(join(root, "probe")).sort()).toEqual(["a", "probe.mjs"]);
		expect(readdirSync(join(root, "probe", "a")).sort()).toEqual(["b.json", "c-1_x.txt"]);
		expect(policy.write).toEqual([join(root, "run")]);
		await probe.close();
		expect(existsSync(root)).toBe(false);
	});

	it.each([
		["timeout", probeLimits.timeout.max],
		["outputLimit", probeLimits.output.max],
	] as const)("takes a %s at its bound and refuses one past it, or below one", async (name, max) => {
		const { sandbox } = passthrough();
		await (await Probe.open({ script: "" }, options(sandbox, { [name]: max }))).close();
		await (await Probe.open({ script: "" }, options(sandbox, { [name]: 1 }))).close();
		for (const value of [max + 1, 0, 1.5])
			expect((await refusal({ script: "" }, options(sandbox, { [name]: value }))).code).toBe("invalidProbe");
	});

	it("refuses a script that is not text", async () => {
		const { sandbox } = passthrough();
		expect((await refusal({ script: 5 as never }, options(sandbox))).code).toBe("invalidProbe");
	});

	it("takes the script, file count, file bytes and path length at their bounds and refuses one past", async () => {
		const { sandbox } = passthrough();
		const name = (length: number) => "p".repeat(length);
		const many = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `f${index}`, text: "" }));
		const fits: ProbeInput[] = [
			{ script: "x".repeat(probeLimits.script) },
			{ script: "", files: many(probeLimits.files) },
			{ script: "", files: [{ path: "a", text: "x".repeat(probeLimits.fileBytes) }] },
			{ script: "", files: [{ path: name(probeLimits.path), text: "" }] },
		];
		const past: ProbeInput[] = [
			{ script: "x".repeat(probeLimits.script + 1) },
			{ script: "", files: many(probeLimits.files + 1) },
			{
				script: "",
				files: [
					{ path: "a", text: "x".repeat(probeLimits.fileBytes) },
					{ path: "b", text: "x" },
				],
			},
			{ script: "", files: [{ path: name(probeLimits.path + 1), text: "" }] },
		];
		for (const input of fits) await (await Probe.open(input, options(sandbox))).close();
		for (const input of past) expect((await refusal(input, options(sandbox))).code).toBe("invalidProbe");
	});

	it("refuses a worktree that is missing, a file, the home directory or above it", async () => {
		const { sandbox } = passthrough();
		writeFileSync(join(scratch, "file"), "");
		for (const path of [join(scratch, "missing"), join(scratch, "file"), homedir(), dirname(homedir()), "/"]) {
			const error = await refusal({ script: "" }, options(sandbox, { worktree: path }));
			expect(error.code, path).toBe("invalidProbe");
		}
		const missing = await refusal({ script: "" }, options(sandbox, { install: join(scratch, "missing") }));
		expect(missing.message).toBe(`the install ${join(scratch, "missing")} cannot be read`);
		expect(missing.cause).toMatchObject({ code: "ENOENT" });
		expect(sandbox.open).not.toHaveBeenCalled();
	});

	it("takes a worktree inside the home directory, and refuses the home directory itself", async () => {
		const { sandbox } = passthrough();
		vi.stubEnv("HOME", scratch);
		try {
			await (await Probe.open({ script: "" }, options(sandbox))).close();
			expect((await refusal({ script: "" }, options(sandbox, { worktree: scratch }))).message).toBe(
				`the worktree ${scratch} holds the home directory`,
			);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("reads only the worktree, the install, Node, the sandbox's helpers, its own files and the system", async () => {
		const { sandbox } = passthrough();
		const install = join(scratch, "install");
		mkdirSync(install);
		const probe = await Probe.open({ script: "" }, options(sandbox, { install }));
		const { policy } = probe;
		const root = dirname(policy.write[0]!);
		const node = nodeReads(process.execPath);
		expect(policy.read.slice(0, 2 + node.length + 3)).toEqual([
			worktree,
			install,
			...node,
			expect.stringMatching(/node_modules\/@anthropic-ai\/sandbox-runtime$/),
			join(root, "probe"),
			join(root, "run"),
		]);
		for (const path of policy.read.slice(2 + node.length + 3))
			expect(path).toMatch(/^\/(bin|sbin|lib|usr|System|private\/var\/select)/);
		expect(policy.read).not.toContain("/usr/local");
		expect(policy.deny).toEqual(["/", join(worktree, ".git"), ...node.map((path) => join(path, "etc"))]);
		expect(policy.denyGlobs).toEqual([
			join(worktree, "**/.env*"),
			join(worktree, "**/melian.secrets.yaml"),
			join(worktree, "**/melian.local.yaml"),
		]);
		expect(policy.denyWrite).toContain("/tmp/claude");
		await probe.close();
		const plain = await Probe.open({ script: "" }, options(sandbox));
		expect(plain.policy.read[1]).toBe(node[0]);
		await plain.close();
	});
});

describe("Probe.policy", () => {
	const systems = {
		darwin: [
			"/bin",
			"/sbin",
			"/usr/bin",
			"/usr/sbin",
			"/usr/lib",
			"/usr/libexec",
			"/usr/share",
			"/System",
			"/private/var/select",
		],
		linux: [
			"/bin",
			"/sbin",
			"/lib",
			"/lib32",
			"/lib64",
			"/libx32",
			"/usr/bin",
			"/usr/sbin",
			"/usr/lib",
			"/usr/lib32",
			"/usr/lib64",
			"/usr/libexec",
			"/usr/share",
		],
	};

	it.each([
		["darwin", ["/tmp/claude", "/private/tmp/claude"], "/System"],
		["linux", ["/tmp/claude"], "/usr/lib"],
	] as const)("reads %s's own programs and libraries, each one present", async (platform, denyWrite, system) => {
		const { sandbox } = passthrough({ platform });
		const probe = await Probe.open({ script: "" }, options(sandbox));
		const { policy } = probe;
		await probe.close();
		expect(policy.denyWrite).toEqual(denyWrite);
		// A path the host lacks is left out, so the other system's mark is checked only where it exists.
		if (existsSync(system)) expect(policy.read).toContain(system);
		const before = 1 + nodeReads(process.execPath).length + 3;
		expect(policy.read.slice(before)).toEqual(systems[platform].filter((path) => existsSync(path)));
		expect(policy.read).not.toContain(platform === "linux" ? "/System" : "/lib64");
	});
});

describe("nodeReads", () => {
	// A Node-only prefix is granted whole; a system node grants its binary and module directory, never a shared prefix
	// such as /usr that would expose /usr/local/etc/npmrc. The host's own node proves the real path resolves.
	it("grants a whole nvm or node-* prefix", () => {
		const nvm = realpathSync(process.execPath);
		if (nvm.includes(`${sep}.nvm${sep}`)) expect(nodeReads(nvm)).toEqual([dirname(dirname(nvm))]);
		const node = join(scratch, "node-v24.0.0-linux-x64");
		mkdirSync(join(node, "bin"), { recursive: true });
		writeFileSync(join(node, "bin", "node"), "");
		expect(nodeReads(join(node, "bin", "node"))).toEqual([node]);
	});

	it("grants /usr/bin/node its binary and module directory, never /usr", () => {
		if (!existsSync("/usr/bin/node")) return;
		const reads = nodeReads("/usr/bin/node");
		expect(reads).not.toContain("/usr");
		expect(reads).toContain("/usr/bin/node");
		for (const path of reads) expect(path.startsWith("/usr/")).toBe(true);
	});
});

describe("makeWritable (through close)", () => {
	it("removes a scratch the probe left unreadable, without following a swapped symlink", async () => {
		// Stand in for a surviving child's swap: a directory inside the writable scratch is replaced by a symlink to an
		// outside directory. close() must make the scratch writable and remove it, and never chmod the outside target.
		const { sandbox } = passthrough();
		const outside = realpathSync(mkdtempSync(join(scratch, "outside-")));
		const outsideFile = join(outside, "keep");
		writeFileSync(outsideFile, "x");
		const probe = await Probe.open({ script: "" }, options(sandbox));
		const root = dirname(probe.policy.write[0]!);
		const swapped = join(root, "run", "home");
		rmSync(swapped, { recursive: true, force: true });
		symlinkSync(outside, swapped);
		const before = statSync(outside).mode;
		await probe.close();
		expect(existsSync(root)).toBe(false);
		// The outside directory and its file are untouched: the symlink was not followed.
		expect(existsSync(outside)).toBe(true);
		expect(statSync(outside).mode).toBe(before);
		expect(existsSync(outsideFile)).toBe(true);
		rmSync(outside, { recursive: true, force: true });
	});
});

describe("Probe.run", () => {
	async function ran(script: string, more: Partial<ProbeOptions> = {}) {
		const { sandbox, asked } = passthrough();
		const probe = await Probe.open({ script }, options(sandbox, more));
		try {
			return { result: await probe.run(), asked, sandbox };
		} finally {
			await probe.close();
		}
	}

	it("runs the script in the worktree with a scratch home and temporary directory and no other variable", async () => {
		writeFileSync(join(worktree, "marker"), "here");
		process.env.MELIAN_PROBE_SECRET = "secret";
		try {
			const { result, asked, sandbox } = await ran(`
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
writeFileSync(process.env.HOME + "/written", "x");
console.log(JSON.stringify({ marker: readFileSync("marker", "utf8"), home: process.env.HOME, tmp: tmpdir(), keys: Object.keys(process.env).sort() }));
`);
			expect(result.exitCode, result.output).toBe(0);
			const seen = JSON.parse(result.output) as { marker: string; home: string; tmp: string; keys: string[] };
			const root = dirname(asked[0]!.policy.write[0]!);
			expect(seen.marker).toBe("here");
			expect(seen.home).toBe(join(root, "run", "home"));
			expect(seen.tmp).toBe(join(root, "run", "tmp"));
			// bash adds PWD, SHLVL and _ to what the probe is given, and macOS adds __CF_USER_TEXT_ENCODING.
			const added = ["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"];
			expect(seen.keys.filter((key) => !added.includes(key))).toEqual(
				["HOME", "LANG", "PATH", "TMPDIR"].filter((key) => key !== "LANG" || process.env.LANG !== undefined),
			);
			expect(sandbox.cleanup).toHaveBeenCalledOnce();
		} finally {
			delete process.env.MELIAN_PROBE_SECRET;
		}
	});

	it("returns the exit code and output, uncut and in time", async () => {
		const { result } = await ran(`process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(3);`);
		expect(result).toEqual({ exitCode: 3, signal: null, output: "out\nerr\n", truncated: false, timedOut: false });
	});

	it("runs from a worktree whose path holds a quote", async () => {
		worktree = join(scratch, "it's here");
		mkdirSync(worktree);
		const { result } = await ran(`console.log(process.cwd());`);
		expect(result).toMatchObject({ exitCode: 0, output: `${worktree}\n` });
	});

	it("leaves no timer behind once the probe has ended", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await ran(`process.exit(0);`, { timeout: 60_000 });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cuts truncated output at a code-point boundary, not mid-character", async () => {
		// "\u20ac" is three bytes; with room for one, no whole character fits, so the output is empty, not a replacement char.
		const one = await ran('process.stdout.write("\u20ac");', { outputLimit: 1 });
		expect(one.result).toMatchObject({ output: "", truncated: true });
		// With room for two characters of a three-character run, the third is dropped whole rather than split.
		const two = await ran('process.stdout.write("\u20ac\u20ac\u20ac");', { outputLimit: 7 });
		expect(two.result).toMatchObject({ output: "\u20ac\u20ac", truncated: true });
	});

	it("keeps output at its limit whole and cuts one byte past it", async () => {
		const at = await ran(`process.stdout.write("x".repeat(100));`, { outputLimit: 100 });
		expect(at.result).toMatchObject({ output: "x".repeat(100), truncated: false });
		const past = await ran(`process.stdout.write("x".repeat(101));`, { outputLimit: 100 });
		expect(past.result).toMatchObject({ output: "x".repeat(100), truncated: true });
	});

	it("ends a probe that runs past its time limit", { timeout: 30_000 }, async () => {
		const began = Date.now();
		const { result } = await ran(`console.log("started"); setInterval(() => {}, 1000);`, { timeout: 1_000 });
		expect(result).toMatchObject({ timedOut: true, truncated: false, output: "started\n" });
		expect(result.exitCode).not.toBe(0);
		expect(Date.now() - began).toBeLessThan(15_000);
	});

	it("refuses a second run while one runs, and any run after close", async () => {
		const { sandbox } = passthrough();
		const probe = await Probe.open({ script: "setTimeout(() => {}, 300);" }, options(sandbox));
		const first = probe.run();
		await expect(probe.run()).rejects.toMatchObject({ code: "invalidProbe" });
		await first;
		expect((await probe.run()).exitCode).toBe(0);
		await probe.close();
		await probe.close();
		expect(sandbox.close).toHaveBeenCalledOnce();
		await expect(probe.run()).rejects.toMatchObject({ code: "closed" });
	});

	it("refuses to run when the sandbox refuses the wrap, and runs nothing", async () => {
		const { sandbox } = passthrough({
			wrap: async () => {
				throw new Error("profile too long");
			},
		});
		const probe = await Probe.open({ script: "" }, options(sandbox));
		await expect(probe.run()).rejects.toMatchObject({
			code: "sandboxUnavailable",
			message: "the sandbox refused the probe: Error: profile too long",
			cause: new Error("profile too long"),
		});
		expect(sandbox.cleanup).toHaveBeenCalledOnce();
		await probe.close();
	});

	it("removes a scratch directory the probe made unreadable", async () => {
		const { sandbox } = passthrough();
		const probe = await Probe.open(
			{
				script: `import { chmodSync, mkdirSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; mkdirSync(tmpdir() + "/locked/inner", { recursive: true }); writeFileSync(tmpdir() + "/locked/inner/f", "x"); chmodSync(tmpdir() + "/locked/inner", 0); chmodSync(tmpdir() + "/locked", 0);`,
			},
			options(sandbox),
		);
		const root = dirname(probe.policy.write[0]!);
		expect((await probe.run()).exitCode).toBe(0);
		await probe.close();
		expect(existsSync(root)).toBe(false);
	});
});

describe("Probe.availability", () => {
	it("says why a probe cannot run", async () => {
		expect(await Probe.availability(passthrough({ unavailable: "no bubblewrap" }).sandbox)).toEqual({
			available: false,
			reason: "no bubblewrap",
		});
	});

	it("runs an empty probe and reports how it ended", async () => {
		const { sandbox, asked } = passthrough();
		expect(await Probe.availability(sandbox)).toEqual({ available: true });
		expect(asked).toHaveLength(1);
		expect(sandbox.close).toHaveBeenCalledOnce();
		const failing = passthrough({ wrap: async () => ["/bin/sh", "-c", "echo broken; exit 4"] as never });
		expect(await Probe.availability(failing.sandbox)).toEqual({
			available: false,
			reason: "an empty probe exited 4: broken",
		});
		const silent = passthrough({ wrap: async () => ["/bin/sh", "-c", "exit 5"] as never });
		expect(await Probe.availability(silent.sandbox)).toEqual({ available: false, reason: "an empty probe exited 5" });
		expect(left()).toEqual([]);
	});
});

describe("RuntimeSandbox", () => {
	function runtime(
		answers: {
			supported?: boolean;
			errors?: string[];
			warnings?: string[];
			initialize?: () => Promise<void>;
			reset?: () => Promise<void>;
		} = {},
	) {
		const calls: unknown[][] = [];
		const fake = {
			isSupportedPlatform: () => {
				calls.push(["isSupportedPlatform"]);
				return answers.supported ?? true;
			},
			checkDependencies: () => {
				calls.push(["checkDependencies"]);
				return { errors: answers.errors ?? [], warnings: answers.warnings ?? [] };
			},
			initialize: async (config: unknown) => {
				calls.push(["initialize", config]);
				await answers.initialize?.();
			},
			wrapWithSandboxArgv: async (...args: unknown[]) => {
				calls.push(["wrapWithSandboxArgv", ...args]);
				return { argv: ["wrapped"], env: {} };
			},
			cleanupAfterCommand: () => {
				calls.push(["cleanupAfterCommand"]);
			},
			reset: async () => {
				calls.push(["reset"]);
				await answers.reset?.();
			},
		} as unknown as SandboxRuntime;
		return { fake, calls, names: () => calls.map(([name]) => name) };
	}

	it("runs on macOS and Linux alone, and asks sandbox-runtime nothing elsewhere", () => {
		const { fake, calls } = runtime();
		expect(new RuntimeSandbox(fake, "win32").unavailable()).toBe("probes run on macOS and Linux, not win32");
		expect(calls).toEqual([]);
		expect(new RuntimeSandbox(fake, "darwin").platform).toBe("darwin");
		expect(new RuntimeSandbox(fake, "linux").platform).toBe("linux");
	});

	it("says what sandbox-runtime lacks here, and refuses a warning that weakens confinement", () => {
		expect(new RuntimeSandbox(runtime({ supported: false }).fake, "linux").unavailable()).toBe(
			"sandbox-runtime does not support this platform",
		);
		const missing = runtime({ errors: ["bubblewrap (bwrap) not installed", "socat not found"] });
		expect(new RuntimeSandbox(missing.fake, "linux").unavailable()).toBe(
			"sandbox-runtime cannot run here: bubblewrap (bwrap) not installed; socat not found",
		);
		// A missing seccomp helper leaves unix sockets unrestricted; 0.0.81 reports it only as a warning.
		const weak = runtime({ warnings: ["seccomp not available - unix socket access not restricted"] });
		expect(new RuntimeSandbox(weak.fake, "linux").unavailable()).toBe(
			"sandbox-runtime cannot run here: seccomp not available - unix socket access not restricted",
		);
		const both = runtime({ errors: ["bwrap missing"], warnings: ["an old bubblewrap"] });
		expect(new RuntimeSandbox(both.fake, "linux").unavailable()).toBe(
			"sandbox-runtime cannot run here: bwrap missing; an old bubblewrap",
		);
		const ready = runtime();
		expect(new RuntimeSandbox(ready.fake, "darwin").unavailable()).toBeUndefined();
		expect(ready.names()).toEqual(["isSupportedPlatform", "checkDependencies"]);
	});

	it("serialises open and close so a reset never tears down a newer session", async () => {
		const order: string[] = [];
		const gap = () => new Promise((resolve) => setTimeout(resolve, 5));
		const { fake } = runtime({
			initialize: async () => {
				order.push("init-start");
				await gap();
				order.push("init-end");
			},
			reset: async () => {
				order.push("reset-start");
				await gap();
				order.push("reset-end");
			},
		});
		const sandbox = new RuntimeSandbox(fake, "linux");
		await sandbox.open();
		// A's close and B's open race on the shared manager; serialised, B initialises only after A's reset finishes.
		const closing = sandbox.close();
		const reopening = sandbox.open();
		await Promise.all([closing, reopening]);
		expect(order).toEqual(["init-start", "init-end", "reset-start", "reset-end", "init-start", "init-end"]);
		await sandbox.close();
	});

	it("opens one session with no network for every open probe, and resets it when the last closes", async () => {
		const { fake, calls, names } = runtime();
		const sandbox = new RuntimeSandbox(fake, "darwin");
		await sandbox.close();
		await sandbox.open();
		await sandbox.open();
		expect(calls).toEqual([
			[
				"initialize",
				{
					network: { allowedDomains: [], deniedDomains: [] },
					filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
				},
			],
		]);
		await sandbox.close();
		expect(names()).toEqual(["initialize"]);
		await sandbox.close();
		expect(names()).toEqual(["initialize", "reset"]);
		await sandbox.close();
		await sandbox.open();
		expect(names()).toEqual(["initialize", "reset", "initialize"]);
	});

	it("opens again after a session that failed to start", async () => {
		let attempts = 0;
		const { fake, names } = runtime({
			initialize: async () => {
				attempts++;
				if (attempts === 1) throw new Error("no user namespaces");
			},
		});
		const sandbox = new RuntimeSandbox(fake, "linux");
		await expect(sandbox.open()).rejects.toThrow("no user namespaces");
		await sandbox.close();
		expect(names()).toEqual(["initialize"]);
		await sandbox.open();
		await sandbox.close();
		expect(names()).toEqual(["initialize", "initialize", "reset"]);
	});

	it("passes every path as a literal, keeps deny globs as patterns, denies JAVA_TOOL_OPTIONS, and no network", async () => {
		const { fake, calls } = runtime();
		const sandbox = new RuntimeSandbox(fake, "linux");
		const policy = {
			read: ["/w", "/w/**"],
			deny: ["/", "/w/.git"],
			denyGlobs: ["/w/**/.env*"],
			write: ["/s/run"],
			denyWrite: ["/tmp/claude"],
		};
		expect(await sandbox.wrap("exec node probe.mjs", policy)).toEqual(["wrapped"]);
		sandbox.cleanup();
		const literal = (path: string) => ({ path, literal: true });
		expect(calls).toEqual([
			[
				"wrapWithSandboxArgv",
				"exec node probe.mjs",
				"/bin/bash",
				{
					network: { allowedDomains: [], deniedDomains: [] },
					filesystem: {
						// The literal paths carry a worktree named "/w/**" without reading as a glob; only the deny pattern is one.
						denyRead: [literal("/"), literal("/w/.git"), "/w/**/.env*"],
						allowRead: [literal("/w"), literal("/w/**")],
						allowWrite: [literal("/s/run")],
						denyWrite: [literal("/tmp/claude")],
					},
					credentials: { envVars: [{ name: "JAVA_TOOL_OPTIONS", mode: "deny" }] },
				},
			],
			["cleanupAfterCommand"],
		]);
	});
});

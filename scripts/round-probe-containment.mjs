// Proves, on the machine a round runs on, that a probe cannot reach what the round's own process holds. It plants a
// canary under the names of the round's logins, in files and in a System V segment, then runs one probe through the real
// Probe class, the code a round runs, which tries every route out it can and prints what it reached. It exits non-zero
// unless every route is shut. It prints names, paths, counts and outcomes, never a value it planted or a probe read.
// Usage: node --conditions=@melian-agent/source scripts/round-probe-containment.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../packages/core/src/config.ts";
import { visibleText } from "../packages/core/src/render.ts";
import { Probe } from "../packages/pipeline/src/probe.ts";

/** The names the round job's logins sit under, so the canary tests the variables a probe would have to reach. */
export const loginNames = [
	"CLAUDE_CODE_OAUTH_TOKEN",
	"MELIAN_CODEX_ACCESS_TOKEN",
	"GITHUB_TOKEN",
	"ACTIONS_RUNTIME_TOKEN",
];

/**
 * The read roots whose files are public, each with why. A token's shape in them is an example, such as a README's or a
 * test's, so the check lists it there and fails only on the canary. A root the policy grants that no rule names is not
 * public, so a token's shape in it fails.
 */
export const publicRoots = [
	{
		reason: "the system's programs and libraries",
		matches: (path) => /^\/(bin|sbin|lib|lib32|lib64|usr)(\/|$)/.test(path),
	},
	{ reason: "installed npm packages", matches: (path) => path.split("/").includes("node_modules") },
	{ reason: "the Node binary that runs the round", matches: (path) => path === process.execPath },
];

/**
 * Every variable a probe starts with: PATH, HOME and TMPDIR from Probe, LANG when the host has one, the shell's PWD,
 * OLDPWD and SHLVL, and those sandbox-runtime adds to reach its proxy, which allows no host. The set must match exactly.
 */
export const expectedEnvironment = [
	"ALL_PROXY",
	"CLAUDE_CODE_HOST_HTTP_PROXY_PORT",
	"CLAUDE_CODE_HOST_SOCKS_PROXY_PORT",
	"CLOUDSDK_PROXY_ADDRESS",
	"CLOUDSDK_PROXY_PASSWORD",
	"CLOUDSDK_PROXY_PORT",
	"CLOUDSDK_PROXY_TYPE",
	"CLOUDSDK_PROXY_USERNAME",
	"DOCKER_HTTPS_PROXY",
	"DOCKER_HTTP_PROXY",
	"FTP_PROXY",
	"GIT_CONFIG_PARAMETERS",
	"GIT_SSH_COMMAND",
	"GRPC_PROXY",
	"HOME",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"JAVA_TOOL_OPTIONS",
	"LANG",
	"NO_PROXY",
	"OLDPWD",
	"PATH",
	"PWD",
	"RSYNC_PROXY",
	"SANDBOX_RUNTIME",
	"SHLVL",
	"TMPDIR",
	"all_proxy",
	"ftp_proxy",
	"grpc_proxy",
	"https_proxy",
	"http_proxy",
	"no_proxy",
];

/** Shapes of the credentials a runner can hold. A match fails the check by its kind and path, never its text. */
export const tokenShapes = {
	"github token": /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
	"github fine-grained token": /\bgithub_pat_[A-Za-z0-9_]{50,}/,
	"anthropic key": /\bsk-ant-[A-Za-z0-9_-]{20,}/,
	jwt: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
	"private key": /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
};

// Runs inside the sandbox. It reads its targets from targets.json and prints one JSON report.
export const probeScript = `
import { readFileSync, readdirSync, lstatSync, openSync, readSync, closeSync, writeFileSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
const t = JSON.parse(readFileSync(new URL("./targets.json", import.meta.url), "utf8"));
const canary = t.canary;
const shapes = Object.entries(t.shapes).map(([kind, source]) => [kind, new RegExp(source)]);
const report = {};
const code = (error) => error?.code ?? error?.status ?? String(error);

report.environment = Object.keys(process.env).sort();
report.environmentCanary = Object.values(process.env).some((value) => value.includes(canary));
try { report.selfEnviron = readFileSync("/proc/self/environ", "latin1").includes(canary) ? "canary" : "clean"; }
catch (error) { report.selfEnviron = code(error); }

const pids = readdirSync("/proc").filter((name) => /^\\d+$/.test(name));
report.processes = pids.length;
report.environCanary = [];
for (const pid of pids) {
	try { if (readFileSync("/proc/" + pid + "/environ", "latin1").includes(canary)) report.environCanary.push(pid); } catch {}
	try { if (readFileSync("/proc/" + pid + "/cmdline", "latin1").includes(canary)) report.environCanary.push(pid + " cmdline"); } catch {}
}

report.reads = {};
report.listings = {};
for (const path of t.read) {
	try {
		const text = readFileSync(path, "latin1");
		report.reads[path] = text.includes(canary) ? "canary" : "read";
	} catch (error) {
		if (error.code !== "EISDIR") { report.reads[path] = code(error); continue; }
		try { report.listings[path] = readdirSync(path); report.reads[path] = "listed"; } catch (inner) { report.reads[path] = code(inner); }
	}
}
report.writes = {};
for (const path of t.write) {
	try { writeFileSync(path, "probe\\n"); report.writes[path] = "wrote"; } catch (error) { report.writes[path] = code(error); }
}

function exchange(host, port, send, done) {
	return new Promise((resolve) => {
		let data = Buffer.alloc(0);
		const socket = connect({ host, port });
		const finish = (outcome) => { socket.destroy(); resolve(outcome); };
		socket.setTimeout(5000, () => finish("timeout"));
		socket.once("error", (error) => finish(code(error)));
		socket.once("connect", () => { if (send === undefined) finish("connected"); else send(socket); });
		socket.on("data", (chunk) => {
			data = Buffer.concat([data, chunk]);
			const outcome = done?.(data, socket);
			if (outcome !== undefined) finish(outcome);
		});
		socket.once("end", () => finish(done?.(data, socket, true) ?? "closed"));
	});
}

report.tcp = {};
for (const { host, port } of t.network) report.tcp[host + ":" + port] = await exchange(host, port);
try { await lookup("api.github.com"); report.dns = "resolved"; } catch (error) { report.dns = code(error); }

const statusLine = (data, socket, ended) => {
	const text = data.toString("latin1");
	const end = text.indexOf("\\r\\n");
	if (end >= 0) return text.slice(0, end).split(" ")[1] ?? "unparsed";
	// A close counts as the proxy's refusal only when no byte of a reply came first.
	if (ended) return data.length === 0 ? "closed" : "closed after " + data.length + " bytes";
	return undefined;
};
// The probe cannot read /etc/hosts, so it reaches a proxy on localhost by address, as any probe could.
function proxyOf(name) {
	try {
		const url = new URL(process.env[name] ?? "");
		if (url.hostname === "localhost") url.hostname = "127.0.0.1";
		return url;
	} catch { return undefined; }
}
const http = proxyOf("HTTP_PROXY");
report.httpProxy = {};
if (http !== undefined) {
	const auth = http.username === "" ? "" : "Proxy-Authorization: Basic " +
		Buffer.from(decodeURIComponent(http.username) + ":" + decodeURIComponent(http.password)).toString("base64") + "\\r\\n";
	for (const { host, port } of t.network) {
		report.httpProxy["CONNECT " + host + ":" + port] = await exchange(http.hostname, Number(http.port), (socket) =>
			socket.write("CONNECT " + host + ":" + port + " HTTP/1.1\\r\\nHost: " + host + ":" + port + "\\r\\n" + auth + "\\r\\n"), statusLine);
		report.httpProxy["GET " + host + ":" + port] = await exchange(http.hostname, Number(http.port), (socket) =>
			socket.write("GET http://" + host + ":" + port + "/ HTTP/1.1\\r\\nHost: " + host + "\\r\\n" + auth + "Connection: close\\r\\n\\r\\n"), statusLine);
	}
} else report.httpProxy.missing = "HTTP_PROXY";

const socks = proxyOf("ALL_PROXY");
report.socksProxy = {};
if (socks !== undefined) {
	const user = Buffer.from(decodeURIComponent(socks.username));
	const pass = Buffer.from(decodeURIComponent(socks.password));
	for (const { host, port } of t.network) {
		const name = Buffer.from(host);
		const request = (socket) =>
			socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
		let stage = "greeting";
		let at = 0;
		report.socksProxy[host + ":" + port] = await exchange(socks.hostname, Number(socks.port), (socket) =>
			socket.write(Buffer.from([5, 1, user.length > 0 ? 2 : 0])), (data, socket, ended) => {
			const rest = data.subarray(at);
			if (stage === "greeting" && rest.length >= 2) {
				at += 2;
				if (rest[1] === 0xff) return "no acceptable method";
				if (rest[1] === 2) {
					stage = "auth";
					socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
				} else { stage = "request"; request(socket); }
				return undefined;
			}
			if (stage === "auth" && rest.length >= 2) {
				at += 2;
				if (rest[1] !== 0) return "authentication refused";
				stage = "request";
				request(socket);
				return undefined;
			}
			if (stage === "request" && rest.length >= 2) return rest[1] === 0 ? "succeeded" : "reply " + rest[1];
			if (ended) return rest.length === 0 ? stage + " closed" : stage + " closed after " + rest.length + " bytes";
			return undefined;
		});
	}
} else report.socksProxy.missing = "ALL_PROXY";

try { execFileSync("sudo", ["-n", "true"], { stdio: "ignore" }); report.sudo = "ran"; } catch (error) { report.sudo = code(error); }

try {
	const listed = execFileSync("ipcs", ["-m"], { encoding: "utf8" }).split("\\n").some((line) => line.trim().split(/\\s+/)[1] === t.shm);
	let removed = false;
	try { execFileSync("ipcrm", ["-m", t.shm], { stdio: "ignore" }); removed = true; } catch {}
	report.ipc = { listed, removed };
} catch (error) { report.ipc = { error: code(error) }; }

const buffer = Buffer.alloc(1048576);
// Each read after a file's first starts with the last bytes of the one before, so a match across two reads is whole.
const overlap = 4096;
function walk(root, maxDepth, readBytes) {
	const summary = { files: 0, directories: 0, unreadable: 0, bytes: 0, top: [], matches: [] };
	const stack = [[root, 0]];
	while (stack.length > 0 && summary.files + summary.directories < 400000 && summary.bytes < t.byteLimit) {
		const [path, depth] = stack.pop();
		let stat;
		try { stat = lstatSync(path); } catch { summary.unreadable++; continue; }
		if (stat.isDirectory()) {
			let names;
			try { names = readdirSync(path); } catch { summary.unreadable++; continue; }
			summary.directories++;
			if (depth === 1 && path !== root) summary.top.push(path);
			if (depth < maxDepth) for (const name of names) stack.push([path === "/" ? "/" + name : path + "/" + name, depth + 1]);
			continue;
		}
		if (!stat.isFile()) continue;
		summary.files++;
		let fd;
		try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); } catch { summary.unreadable++; continue; }
		const found = new Set();
		try {
			let at = 0;
			let carried = "";
			while (at < readBytes && summary.bytes < t.byteLimit) {
				const size = readSync(fd, buffer, 0, Math.min(readBytes - at, buffer.length), at);
				if (size === 0) break;
				at += size;
				summary.bytes += size;
				const text = carried + buffer.toString("latin1", 0, size);
				if (text.includes(canary) && path !== t.self) found.add("canary");
				for (const [kind, shape] of shapes) if (shape.test(text)) found.add(kind);
				carried = text.slice(-overlap);
			}
		} catch { summary.unreadable++; } finally { closeSync(fd); }
		for (const kind of found) summary.matches.push({ kind, path });
	}
	summary.cut = stack.length > 0 || summary.bytes >= t.byteLimit;
	summary.top = summary.top.slice(0, 40);
	summary.matches = summary.matches.slice(0, 200);
	return summary;
}
report.walk = {};
for (const root of t.walk) report.walk[root] = walk(root, 64, Infinity);
report.sys = walk("/sys", 8, 4096);
console.log(JSON.stringify(report));
`;

/**
 * What the probe's report shows getting through, as one line each. An empty list is containment. `report` is the probe's
 * printed JSON, `plan` the targets the host gave it, `argv` every command line the sandbox was given, and `host` what the
 * host saw: each listed directory's `names`, the `passages` bubblewrap makes in it toward an allowed path, and the paths
 * the probe was refused but that were `written` on the host after it ran.
 */
export function judge(report, plan, argv, host) {
	const failures = [];
	const unexpected = report.environment.filter((name) => !plan.environment.includes(name));
	if (unexpected.length > 0)
		failures.push(`the probe's environment holds unexpected variables: ${unexpected.join(", ")}`);
	const missing = plan.environment.filter((name) => !report.environment.includes(name));
	if (missing.length > 0) failures.push(`the probe's environment lacks expected variables: ${missing.join(", ")}`);
	if (report.environmentCanary) failures.push("the probe's environment holds the canary");
	if (report.selfEnviron !== "clean") failures.push(`/proc/self/environ read as ${report.selfEnviron}, not clean`);
	if (report.environCanary.length > 0)
		failures.push(`the canary is in /proc of processes ${report.environCanary.join(", ")}`);
	if (argv.length === 0) failures.push("the sandbox wrapped no command");
	if (argv.some((line) => line.some((word) => word.includes(plan.canary))))
		failures.push("the sandbox's command line holds the canary");
	for (const path of plan.read) {
		const outcome = report.reads[path];
		if (plan.readable.includes(path)) {
			if (outcome !== "read" && outcome !== "listed")
				failures.push(`${path} should be readable, and read as ${outcome}`);
		} else if (outcome === "read" || outcome === "canary") failures.push(`${path} read as ${outcome}`);
		else if (outcome === "listed") {
			// bubblewrap mounts an empty directory over what it denies, holding only the way to each allowed path.
			const leaked = (report.listings[path] ?? []).filter(
				(name) => (host.names[path] ?? []).includes(name) && !(host.passages[path] ?? []).includes(name),
			);
			if (leaked.length > 0) failures.push(`${path} lists ${leaked.length} of the host's entries`);
		}
	}
	for (const path of plan.write) {
		if (plan.writable.includes(path)) {
			if (report.writes[path] !== "wrote")
				failures.push(`${path} should be writable, and wrote ${report.writes[path]}`);
		} else if (host.written.includes(path)) failures.push(`the probe's write to ${path} reached the host`);
	}
	for (const { host, port } of plan.network) {
		const target = `${host}:${port}`;
		const tried = [report.tcp[target], report.httpProxy[`CONNECT ${target}`], report.httpProxy[`GET ${target}`]];
		if ([...tried, report.socksProxy[target]].includes(undefined))
			failures.push(`the probe did not try every route to ${target}`);
	}
	for (const [target, outcome] of Object.entries(report.tcp))
		if (outcome === "connected") failures.push(`a TCP connection to ${target} opened`);
	if (report.dns === "resolved") failures.push("a DNS lookup resolved");
	if (report.httpProxy.missing !== undefined) failures.push(`the probe has no ${report.httpProxy.missing} to try`);
	for (const [attempt, status] of Object.entries(report.httpProxy)) {
		if (attempt === "missing") continue;
		if (/^[23]\d\d$/.test(status)) failures.push(`the HTTP proxy answered ${attempt} with ${status}`);
		// A refusal must come from the proxy, a status or a close after connecting, or the attempt never reached it.
		else if (!/^(\d\d\d|closed)$/.test(status)) failures.push(`the HTTP proxy never answered ${attempt}: ${status}`);
	}
	if (report.socksProxy.missing !== undefined) failures.push(`the probe has no ${report.socksProxy.missing} to try`);
	for (const [target, outcome] of Object.entries(report.socksProxy)) {
		if (target === "missing") continue;
		if (outcome === "succeeded") failures.push(`the SOCKS proxy connected ${target}`);
		else if (!/^(reply \d+|authentication refused|no acceptable method|\w+ closed)$/.test(outcome))
			failures.push(`the SOCKS proxy never answered for ${target}: ${outcome}`);
	}
	if (report.sudo === "ran") failures.push("sudo -n true ran");
	if (report.ipc.listed !== false || report.ipc.removed !== false)
		failures.push(
			`the host's System V segment was ${report.ipc.error ?? (report.ipc.listed ? "listed" : "removed")}`,
		);
	for (const [root, summary] of [...Object.entries(report.walk), ["/sys", report.sys]]) {
		for (const { kind, path } of summary.matches)
			if (kind === "canary" || !plan.public.includes(root)) failures.push(`${path} holds a ${kind}`);
		if (summary.cut) failures.push(`the walk of ${root} stopped at its entry or byte limit`);
	}
	if ((report.walk[plan.walk[0]]?.files ?? 0) === 0) failures.push(`the walk read no file of ${plan.walk[0]}`);
	for (const root of plan.walk)
		if (!plan.own.includes(root) && !plan.public.includes(root))
			failures.push(`the policy lets a probe read ${root}, which is neither its own nor a named public root`);
	return failures;
}

/** One line per walked root: its counts and, for /sys, its top-level entries; then each match, and how many token shapes the public roots held. */
export function walked(report, plan) {
	const lines = Object.entries(report.walk).map(
		([root, s]) =>
			`${root}: ${s.files} files, ${s.directories} directories, ${s.unreadable} unreadable, ${s.bytes} bytes read`,
	);
	const sys = report.sys;
	lines.push(
		`/sys: ${sys.files} files, ${sys.directories} directories, ${sys.unreadable} unreadable; ${sys.top.join(" ")}`,
	);
	for (const [root, summary] of Object.entries(report.walk))
		for (const { kind, path } of summary.matches) lines.push(`${root} holds a ${kind} shape in ${path}`);
	const listed = Object.entries(report.walk)
		.filter(([root]) => plan.public.includes(root))
		.flatMap(([, summary]) => summary.matches)
		.filter(({ kind }) => kind !== "canary");
	lines.push(`token shapes listed in ${plan.public.length} public roots: ${listed.length}`);
	return lines;
}

/** A ProbeSandbox that forwards to `sandbox` and records each command line it is given. */
export function recording(sandbox, argv) {
	return {
		platform: sandbox.platform,
		kind: sandbox.kind,
		unavailable: () => sandbox.unavailable(),
		open: () => sandbox.open(),
		wrap: async (command, policy) => {
			const line = await sandbox.wrap(command, policy);
			argv.push(line);
			return line;
		},
		cleanup: () => sandbox.cleanup(),
		close: () => sandbox.close(),
	};
}

/** The line a probe that did not finish, or whose processes could not be stopped, prints; undefined when it exited 0 in time with its whole output. */
export function unfinished(result) {
	if (result.error !== undefined) return `the containment probe's processes could not be stopped: ${result.error}`;
	if (result.exitCode === 0 && !result.timedOut && !result.truncated) return undefined;
	return `the containment probe did not finish: exit ${result.exitCode ?? result.signal}, timed out ${result.timedOut}, cut ${result.truncated}`;
}

/**
 * What the host holds after the probe: each read path's entries, the way to each path the policy reaches through it,
 * and each refused write that exists on the host, which it removes.
 */
export function observeHost(plan, reached) {
	const host = { names: {}, passages: {}, written: [] };
	for (const path of plan.read) {
		try {
			host.names[path] = readdirSync(path);
		} catch {
			continue;
		}
		host.passages[path] = reached
			.filter((target) => target.startsWith(`${path === "/" ? "" : path}/`))
			.map((target) => relative(path, target).split(sep)[0]);
	}
	for (const path of plan.write)
		if (!plan.writable.includes(path) && existsSync(path)) {
			host.written.push(path);
			rmSync(path, { force: true });
		}
	return host;
}

/** The step's exit code and the lines it prints for the failures judge found. */
export function outcome(failures) {
	if (failures.length === 0) return { code: 0, lines: ["every route tried is shut"] };
	return { code: 1, lines: failures.map((failure) => `not contained: ${failure}`) };
}

/** What the containment probe tries, from the policy Probe gave it and what the step planted on the host. */
export function containmentPlan({
	canary,
	tag,
	shm,
	policy,
	files,
	scratch,
	temp,
	checkout,
	home,
	pid,
	held,
	runtimeUrl,
	lang,
}) {
	const tree = policy.read[0];
	const run = policy.write[0];
	const probeDirectory = join(run, "..", "probe");
	const runtime = new URL(runtimeUrl ?? "http://localhost").hostname;
	return {
		canary,
		shm,
		shapes: Object.fromEntries(Object.entries(tokenShapes).map(([kind, shape]) => [kind, shape.source])),
		// Probe passes the host's LANG on, so the probe holds it exactly when the host does.
		environment: expectedEnvironment.filter((name) => name !== "LANG" || lang !== undefined),
		readable: [join(tree, "package.json"), tree],
		read: [
			join(tree, "package.json"),
			tree,
			...files,
			scratch,
			temp,
			checkout,
			join(checkout, ".git", "config"),
			join(checkout, "package.json"),
			join(home, ".gitconfig"),
			home,
			"/home/runner/actions-runner",
			"/home/runner/actions-runner/.credentials",
			"/home/runner/actions-runner/.runner",
			`/proc/${pid}/environ`,
			`/proc/${pid}/fd/${held}`,
			`/proc/${pid}/cwd/package.json`,
			`/proc/${pid}/root/etc/passwd`,
			"/etc/passwd",
			"/etc/hostname",
		],
		writable: [join(run, "home", "written")],
		write: [
			join(run, "home", "written"),
			join(tree, "written"),
			join(scratch, "written"),
			// Shared directories take a fresh name each run, so the cleanup that follows removes nothing it did not plan.
			`/tmp/melian-written-${tag}`,
			join(home, `melian-written-${tag}`),
		],
		network: [
			{ host: "api.github.com", port: 443 },
			{ host: "169.254.169.254", port: 80 },
			...(runtime === "localhost" ? [] : [{ host: runtime, port: 443 }]),
		],
		walk: policy.read,
		// Bytes each walk reads before it stops, and the check fails; far above what a runner's roots hold.
		byteLimit: 16 * 1024 ** 3,
		own: [tree, run, probeDirectory],
		// A probe's own directories are never public, wherever they sit.
		public: policy.read.filter(
			(path) => ![tree, run, probeDirectory].includes(path) && publicRoots.some((root) => root.matches(path)),
		),
		self: join(probeDirectory, "targets.json"),
	};
}

/**
 * The policy's `probe.read` at `commit`, the paths a round's probes read beyond the tracked tree. The round job checks out
 * its base, and check.yml the result that would merge, so each proves the policy its probes will run under.
 */
export async function probeRead(checkout, commit) {
	return (await loadConfig(checkout, { kind: "revision", commit }, ".")).config.probe.read;
}

/** The id ipcmk printed for the segment it made, or "" when it printed none. */
export function shmId(made) {
	return /(\d+)\s*$/.exec(made)?.[1] ?? "";
}

/** Runs the containment probe through `probes`, Probe unless a test gives another, and returns the step's exit code. */
export async function main(probes = Probe, read = probeRead) {
	const say = (line) => console.log(visibleText(line));
	const available = await probes.availability();
	if (!available.available) {
		say(`probes cannot run here: ${available.reason}`);
		return 1;
	}
	const checkout = realpathSync(process.cwd());
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
	let allowed;
	try {
		allowed = [...(await read(checkout, commit))];
	} catch (error) {
		say(`the policy's probe.read could not be read: ${error.message}`);
		return 1;
	}
	const canary = `melian-canary-${randomBytes(16).toString("hex")}`;
	for (const name of loginNames) process.env[name] = canary;
	const temp = realpathSync(process.env.RUNNER_TEMP ?? tmpdir());
	const scratch = mkdtempSync(join(temp, "melian-containment-"));
	const files = [join(scratch, "canary"), join(homedir(), `.melian-canary-${randomBytes(4).toString("hex")}`)];
	for (const file of files) writeFileSync(file, `${canary}\n`);
	// An open descriptor, as a login file would be, which the probe must not reach through /proc/<pid>/fd.
	const held = openSync(files[0], "r");
	const made = execFileSync("ipcmk", ["--shmem", "64"], { encoding: "utf8" });
	const shm = shmId(made);
	try {
		const argv = [];
		const probe = await probes.open(
			{
				script: probeScript,
				files: [{ path: "targets.json", text: "{}" }],
			},
			{
				head: { checkout, commit, read: allowed },
				writer: { trusted: true, by: "reviewer" },
				trustWriters: true,
				sandbox: recording(probes.sandbox, argv),
				timeout: 600_000,
				outputLimit: 1_048_576,
			},
		);
		let report;
		let plan;
		let left;
		const { policy } = probe;
		try {
			plan = containmentPlan({
				canary,
				tag: randomBytes(8).toString("hex"),
				shm,
				policy,
				files,
				scratch,
				temp,
				checkout,
				home: homedir(),
				pid: process.pid,
				held,
				runtimeUrl: process.env.ACTIONS_RUNTIME_URL,
				lang: process.env.LANG,
			});
			writeFileSync(plan.self, JSON.stringify(plan));
			const result = await probe.run();
			const stopped = unfinished(result);
			if (stopped !== undefined) {
				say(stopped);
				return 1;
			}
			report = JSON.parse(result.output);
		} finally {
			const cleanup = await probe.close();
			left = !cleanup.removed;
			if (left) say(`the probe's scratch was left at ${cleanup.leftover}`);
		}
		if (left) return 1;
		for (const line of walked(report, plan)) say(line);
		say(`environment: ${report.environment.join(" ")}`);
		say(`processes visible: ${report.processes}; sudo: ${report.sudo}; dns: ${report.dns}`);
		say(`tcp: ${JSON.stringify(report.tcp)}`);
		say(`http proxy: ${JSON.stringify(report.httpProxy)}`);
		say(`socks proxy: ${JSON.stringify(report.socksProxy)}`);
		say(`ipc: ${JSON.stringify(report.ipc)}`);
		say(`reads: ${JSON.stringify(report.reads)}`);
		say(`writes: ${JSON.stringify(report.writes)}`);
		const host = observeHost(plan, [...policy.read, ...policy.write]);
		const { code, lines } = outcome(judge(report, plan, argv, host));
		for (const line of lines) say(line);
		return code;
	} finally {
		closeSync(held);
		for (const file of files) rmSync(file, { force: true });
		rmSync(scratch, { recursive: true, force: true });
		spawnSync("ipcrm", ["-m", shm]);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();

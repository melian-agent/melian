import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgeAudit, readAudit, readExceptions } from "./check-audit.mjs";

// npm 11.16.0 wrote these on 2026-11-18, for `npm audit --include=dev --json` and `npm audit --omit=dev --json`.
const fixture = (name) => readFileSync(new URL(`fixtures/npm-audit/${name}`, import.meta.url), "utf8");

const advisory = (id, severity, name = "pkg") => ({
	source: 1,
	name,
	dependency: name,
	title: `${name} is vulnerable`,
	url: `https://github.com/advisories/${id}`,
	severity,
	range: "*",
});

const report = (...vias) => ({
	auditReportVersion: 2,
	vulnerabilities: Object.fromEntries(
		vias.map((via) => [via.name, { name: via.name, severity: via.severity, via: [via], effects: [] }]),
	),
});

const found = (...vias) => ({ status: 1, stdout: JSON.stringify(report(...vias)) });
const clean = { status: 0, stdout: JSON.stringify(report()) };
const exception = { id: "GHSA-aaaa-bbbb-cccc", reason: "no fixed release; dev tools only", added: "2026-11-18" };

const read = (...vias) => readAudit(found(...vias));
const judge = ({ advisories, shipped = [], exceptions = [] }) => judgeAudit({ advisories, shipped, exceptions });

describe("readAudit", () => {
	it("reads each advisory in npm's own report with its GHSA ID, and skips the packages that only pass one on", () => {
		const advisories = readAudit({ status: 1, stdout: fixture("full.json") });
		expect(advisories.find((entry) => entry.name === "picomatch")).toEqual({
			id: "GHSA-fc5q-39xc-vjpf",
			url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
			name: "picomatch",
			title: "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
			severity: "high",
		});
		expect(advisories.map((entry) => entry.name)).toEqual([
			"fast-uri",
			"fast-uri",
			"fast-uri",
			"fast-uri",
			"minimatch",
			"picomatch",
			"qs",
			"qs",
			"qs",
			"qs",
		]);
		expect(readAudit({ status: 0, stdout: fixture("shipped.json") })).toEqual([]);
	});

	it("leaves the ID unset for an advisory whose URL is not a GitHub advisory", () => {
		for (const url of [
			"https://example.com/advisories/GHSA-aaaa-bbbb-cccc",
			"https://example.com/?https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
			"https://github.com/advisories/GHSA-aaaa-bbbb-cccc/x",
		])
			expect(read({ ...advisory("GHSA-aaaa-bbbb-cccc", "high"), url })[0].id).toBeUndefined();
	});

	it("fails when npm audit did not start", () => {
		expect(() => readAudit({ ...clean, status: null, error: new Error("spawn npm ENOENT") })).toThrow(
			"npm audit did not run: spawn npm ENOENT",
		);
	});

	it("fails on an exit code other than a clean audit or one that found vulnerabilities", () => {
		expect(() => readAudit({ ...clean, status: 2 })).toThrow("npm audit ended with exit code 2");
		expect(() => readAudit({ ...clean, status: null, signal: "SIGTERM" })).toThrow("npm audit ended with SIGTERM");
	});

	it("fails on output that is not JSON", () => {
		expect(() => readAudit({ status: 1, stdout: "npm error audit endpoint returned an error" })).toThrow(
			"npm audit printed no JSON report",
		);
	});

	it("fails on npm's error report", () => {
		const stdout = JSON.stringify({
			error: { code: "ENOAUDIT", summary: "Your configured registry does not support audit" },
		});
		expect(() => readAudit({ status: 1, stdout })).toThrow(
			"npm audit failed: Your configured registry does not support audit",
		);
		expect(() => readAudit({ status: 1, stdout: JSON.stringify({ error: {} }) })).toThrow(
			"npm audit failed: no reason given",
		);
	});

	it("fails on a report of another version or with no vulnerabilities object", () => {
		expect(() => readAudit({ ...clean, stdout: JSON.stringify({ ...report(), auditReportVersion: 3 }) })).toThrow(
			"unknown shape",
		);
		expect(() => readAudit({ ...clean, stdout: JSON.stringify({ auditReportVersion: 2 }) })).toThrow("unknown shape");
		expect(() =>
			readAudit({ ...clean, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: "x" }) }),
		).toThrow("unknown shape");
		expect(() =>
			readAudit({ ...clean, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: null }) }),
		).toThrow("unknown shape");
		expect(() => readAudit({ ...clean, stdout: "null" })).toThrow("unknown shape");
	});

	it("fails when npm audit exits 1 and reports no vulnerabilities", () => {
		expect(() => readAudit({ ...clean, status: 1 })).toThrow("npm audit exited 1 and reported no vulnerabilities");
		expect(readAudit(clean)).toEqual([]);
	});

	it("fails on a vulnerability with no list of advisories", () => {
		const stdout = JSON.stringify({ auditReportVersion: 2, vulnerabilities: { pkg: { name: "pkg" } } });
		expect(() => readAudit({ status: 1, stdout })).toThrow("npm audit listed pkg with no advisories");
	});

	it("fails on an advisory with no severity", () => {
		const { severity, ...via } = advisory("GHSA-aaaa-bbbb-cccc", "high");
		expect(() => read(via)).toThrow("npm audit listed an advisory for pkg with no severity");
		const stdout = JSON.stringify({ auditReportVersion: 2, vulnerabilities: { pkg: { name: "pkg", via: [null] } } });
		expect(() => readAudit({ status: 1, stdout })).toThrow("npm audit listed an advisory for pkg with no severity");
	});
});

describe("readExceptions", () => {
	it("reads the committed exceptions", () => {
		const committed = JSON.parse(readFileSync(new URL("../.audit-exceptions.json", import.meta.url), "utf8"));
		expect(readExceptions(committed)).toEqual(committed);
		expect(committed.map((entry) => entry.id)).toEqual(["GHSA-fc5q-39xc-vjpf"]);
	});

	it("fails on a file that is not an array", () => {
		expect(() => readExceptions({ ...exception })).toThrow("must hold an array");
	});

	it("fails on an entry with no GHSA ID", () => {
		expect(() => readExceptions([{ ...exception, id: "picomatch" }])).toThrow("names no GHSA ID");
		expect(() => readExceptions([{ ...exception, id: undefined }])).toThrow("names no GHSA ID");
		expect(() => readExceptions([{ ...exception, id: `x${exception.id}` }])).toThrow("names no GHSA ID");
		expect(() => readExceptions([{ ...exception, id: `${exception.id}x` }])).toThrow("names no GHSA ID");
		expect(() => readExceptions([null])).toThrow("names no GHSA ID");
	});

	it("fails on an entry with no reason", () => {
		expect(() => readExceptions([{ ...exception, reason: undefined }])).toThrow("gives no reason");
		expect(() => readExceptions([{ ...exception, reason: "  " }])).toThrow("gives no reason");
	});
});

describe("judgeAudit", () => {
	it("blocks a high advisory with no exception", () => {
		const advisories = read(advisory(exception.id, "high"));
		expect(judge({ advisories })).toEqual({
			blocking: [{ ...advisories[0], shipped: false }],
			excepted: [],
			unused: [],
		});
	});

	it("passes a high advisory its exception names", () => {
		const advisories = read(advisory(exception.id, "high"));
		expect(judge({ advisories, exceptions: [exception] })).toEqual({
			blocking: [],
			excepted: [{ ...advisories[0], exception }],
			unused: [],
		});
	});

	it("blocks a critical advisory with no exception, and passes one its exception names", () => {
		const advisories = read(advisory(exception.id, "critical"));
		expect(judge({ advisories }).blocking).toEqual([{ ...advisories[0], shipped: false }]);
		expect(judge({ advisories, exceptions: [exception] }).blocking).toEqual([]);
	});

	it("passes advisories below high", () => {
		const advisories = read(
			advisory("GHSA-aaaa-aaaa-aaaa", "moderate", "a"),
			advisory("GHSA-bbbb-bbbb-bbbb", "low", "b"),
			advisory("GHSA-cccc-cccc-cccc", "info", "c"),
		);
		expect(judge({ advisories, shipped: advisories })).toEqual({ blocking: [], excepted: [], unused: [] });
	});

	it("blocks an advisory of a severity it does not know", () => {
		const advisories = read(advisory(exception.id, "severe"));
		expect(judge({ advisories }).blocking).toEqual([{ ...advisories[0], shipped: false }]);
	});

	it("blocks an excepted advisory that also reaches a shipped dependency, and reports it once", () => {
		const advisories = read(advisory(exception.id, "high"));
		expect(judge({ advisories, shipped: advisories, exceptions: [exception] })).toEqual({
			blocking: [{ ...advisories[0], shipped: true }],
			excepted: [],
			unused: [],
		});
	});

	it("blocks a moderate advisory in the shipped audit only when it is high there too", () => {
		const advisories = read(advisory(exception.id, "high"));
		const shipped = read(advisory(exception.id, "moderate"));
		expect(judge({ advisories, shipped, exceptions: [exception] }).blocking).toEqual([]);
	});

	it("matches a shipped advisory by its package and URL together", () => {
		const [same, otherPackage] = read(advisory(exception.id, "high", "a"), advisory(exception.id, "high", "b"));
		const [otherAdvisory] = read(advisory("GHSA-dddd-dddd-dddd", "high", "a"));
		expect(
			judge({ advisories: [same, otherPackage, otherAdvisory], shipped: [same], exceptions: [exception] }),
		).toEqual({
			blocking: [
				{ ...same, shipped: true },
				{ ...otherAdvisory, shipped: false },
			],
			excepted: [{ ...otherPackage, exception }],
			unused: [],
		});
	});

	it("matches an exception by its GHSA ID, never by the package", () => {
		const advisories = read(advisory("GHSA-dddd-dddd-dddd", "high", "pkg"));
		const other = { ...exception, id: "GHSA-eeee-eeee-eeee" };
		expect(judge({ advisories, exceptions: [other] })).toEqual({
			blocking: [{ ...advisories[0], shipped: false }],
			excepted: [],
			unused: [other],
		});
	});

	it("blocks an advisory with no ID, whatever the exceptions", () => {
		const via = { ...advisory(exception.id, "high"), url: undefined };
		const advisories = read(via);
		expect(judge({ advisories, exceptions: [exception] }).blocking).toEqual([{ ...advisories[0], shipped: false }]);
	});

	it("reports an exception that matches no advisory at high or above, and passes", () => {
		const advisories = read(advisory(exception.id, "moderate"));
		expect(judge({ advisories, exceptions: [exception] })).toEqual({
			blocking: [],
			excepted: [],
			unused: [exception],
		});
	});

	it("passes the committed exception against npm's real report", () => {
		const committed = readExceptions(
			JSON.parse(readFileSync(new URL("../.audit-exceptions.json", import.meta.url), "utf8")),
		);
		const advisories = readAudit({ status: 1, stdout: fixture("full.json") });
		const shipped = readAudit({ status: 0, stdout: fixture("shipped.json") });
		const { blocking, excepted, unused } = judgeAudit({ advisories, shipped, exceptions: committed });
		expect(blocking).toEqual([]);
		expect(excepted.map((entry) => entry.id)).toEqual(["GHSA-fc5q-39xc-vjpf"]);
		expect(unused).toEqual([]);
		expect(judgeAudit({ advisories, shipped, exceptions: [] }).blocking.map((entry) => entry.id)).toEqual([
			"GHSA-fc5q-39xc-vjpf",
		]);
	});
});

// The fake npm answers only the two audits the script asks for, each from a file the test names.
// It sets exitCode rather than calling exit, which on macOS cuts a pipe write short.
const fakeNpm = `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2).join(" ");
const answer = { "audit --json --include=dev": "FAKE_FULL", "audit --json --omit=dev": "FAKE_SHIPPED" }[args];
if (!answer) {
	console.error("fake npm was asked: " + args);
	process.exit(9);
}
const [status, file] = process.env[answer].split(":");
process.stdout.write(readFileSync(file, "utf8"));
process.exitCode = Number(status);
`;

describe("check-audit.mjs", { timeout: 60_000 }, () => {
	const script = fileURLToPath(new URL("check-audit.mjs", import.meta.url));
	const full = fileURLToPath(new URL("fixtures/npm-audit/full.json", import.meta.url));
	const shipped = fileURLToPath(new URL("fixtures/npm-audit/shipped.json", import.meta.url));
	const committed = JSON.parse(readFileSync(new URL("../.audit-exceptions.json", import.meta.url), "utf8"));
	let root;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "check-audit-"));
		mkdirSync(join(root, "bin"));
		writeFileSync(join(root, "bin", "npm"), fakeNpm, { mode: 0o755 });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const run = ({ exceptions, fullAudit = `1:${full}`, shippedAudit = `0:${shipped}`, entry = script }) => {
		if (exceptions !== undefined) writeFileSync(join(root, ".audit-exceptions.json"), JSON.stringify(exceptions));
		return spawnSync(process.execPath, [entry], {
			cwd: root,
			encoding: "utf8",
			env: {
				PATH: `${join(root, "bin")}:${dirname(process.execPath)}`,
				HOME: root,
				FAKE_FULL: fullAudit,
				FAKE_SHIPPED: shippedAudit,
			},
		});
	};

	it("passes npm's real report under the committed exception, and says it used it", () => {
		const result = run({ exceptions: committed });
		expect(result.stdout).toContain("audit exception used: GHSA-fc5q-39xc-vjpf in picomatch");
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});

	it("blocks the advisory with no exception", () => {
		for (const exceptions of [[], undefined]) {
			const result = run({ exceptions });
			expect(result.stderr.split("\n")[0]).toBe(
				"GHSA-fc5q-39xc-vjpf (high) in picomatch: picomatch vulnerable to ReDoS through single-branch repeated extglobs",
			);
			expect(result.status).toBe(1);
		}
	});

	it("blocks the excepted advisory once a shipped dependency carries it", () => {
		const result = run({ exceptions: committed, shippedAudit: `1:${full}` });
		expect(result.stderr).toContain("GHSA-fc5q-39xc-vjpf (high) in picomatch, a shipped dependency:");
		expect(result.status).toBe(1);
	});

	it("reports an unused exception and passes", () => {
		const unused = { id: "GHSA-aaaa-bbbb-cccc", reason: "fixed since", added: "2026-11-18" };
		const result = run({ exceptions: [...committed, unused] });
		expect(result.stdout).toContain(
			"audit exception unused: GHSA-aaaa-bbbb-cccc matches no advisory at high or above; remove it from .audit-exceptions.json",
		);
		expect(result.status).toBe(0);
	});

	it("fails, saying why, when an audit prints no report", () => {
		const garbage = join(root, "garbage.txt");
		writeFileSync(garbage, "npm error network");
		const result = run({ exceptions: committed, shippedAudit: `1:${garbage}` });
		expect(result.stderr).toBe(
			"The dependency audit did not finish, so the dependencies are unverified: npm audit printed no JSON report\n",
		);
		expect(result.status).toBe(1);
	});

	it("reads a report larger than spawnSync's default buffer of a mebibyte", () => {
		const large = join(root, "large.json");
		writeFileSync(large, readFileSync(full, "utf8").replace("{", `{${" ".repeat(2 * 1024 * 1024)}`));
		const result = run({ exceptions: committed, fullAudit: `1:${large}` });
		expect(result.stdout).toContain("audit exception used: GHSA-fc5q-39xc-vjpf in picomatch");
		expect(result.status).toBe(0);
	});

	it("runs no audit when another module imports it", () => {
		const importer = join(root, "importer.mjs");
		writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(script).href)};\n`);
		const result = run({ exceptions: committed, fullAudit: "1:/nonexistent", entry: importer });
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});

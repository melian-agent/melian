// An advisory with no fixed release would block every pull request until it is fixed upstream. This blocks every
// advisory at high or above, except one the exceptions file names by GHSA ID while dev dependencies alone reach it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const exceptionsFile = ".audit-exceptions.json";
const belowHigh = new Set(["info", "low", "moderate"]);
const ghsa = /^GHSA(?:-[0-9a-z]{4}){3}$/;
const advisoryUrl = /^https:\/\/github\.com\/advisories\/(GHSA(?:-[0-9a-z]{4}){3})$/;

// Takes spawnSync's result for `npm audit --json` and returns every advisory npm reports. A vulnerability
// whose via entry is a string only passes on another package's advisory, which npm lists under that package.
export function readAudit({ status, signal, stdout, error }) {
	if (error) throw new Error(`npm audit did not run: ${error.message}`);
	if (status !== 0 && status !== 1) throw new Error(`npm audit ended with ${signal ?? `exit code ${status}`}`);
	let report;
	try {
		report = JSON.parse(stdout);
	} catch {
		throw new Error("npm audit printed no JSON report");
	}
	if (report?.error) throw new Error(`npm audit failed: ${report.error.summary ?? "no reason given"}`);
	if (report?.auditReportVersion !== 2 || typeof report.vulnerabilities !== "object" || !report.vulnerabilities)
		throw new Error("npm audit printed a report of an unknown shape; this script reads auditReportVersion 2");
	const vulnerabilities = Object.entries(report.vulnerabilities);
	if (status === 1 && vulnerabilities.length === 0)
		throw new Error("npm audit exited 1 and reported no vulnerabilities");
	const advisories = [];
	for (const [name, vulnerability] of vulnerabilities) {
		if (!Array.isArray(vulnerability.via)) throw new Error(`npm audit listed ${name} with no advisories`);
		for (const via of vulnerability.via) {
			if (typeof via === "string") continue;
			if (typeof via?.severity !== "string")
				throw new Error(`npm audit listed an advisory for ${name} with no severity`);
			const id = advisoryUrl.exec(via.url)?.[1];
			advisories.push({ id, url: via.url, name, title: via.title, severity: via.severity });
		}
	}
	return advisories;
}

export function readExceptions(list) {
	if (!Array.isArray(list)) throw new Error(`${exceptionsFile} must hold an array`);
	for (const entry of list) {
		if (!ghsa.test(entry?.id)) throw new Error(`${exceptionsFile}: ${JSON.stringify(entry)} names no GHSA ID`);
		if (typeof entry.reason !== "string" || entry.reason.trim() === "")
			throw new Error(`${exceptionsFile}: ${entry.id} gives no reason`);
	}
	return list;
}

// advisories come from the whole tree, shipped from the tree without dev dependencies. An exception never
// applies to an advisory a shipped dependency carries.
export function judgeAudit({ advisories, shipped, exceptions }) {
	const blocks = (advisory) => !belowHigh.has(advisory.severity);
	const blocking = shipped.filter(blocks).map((advisory) => ({ ...advisory, shipped: true }));
	const excepted = [];
	for (const advisory of advisories.filter(blocks)) {
		if (blocking.some((entry) => entry.name === advisory.name && entry.url === advisory.url)) continue;
		const exception = exceptions.find((entry) => entry.id === advisory.id);
		if (exception) excepted.push({ ...advisory, exception });
		else blocking.push({ ...advisory, shipped: false });
	}
	const unused = exceptions.filter(
		(entry) => !advisories.some((advisory) => blocks(advisory) && advisory.id === entry.id),
	);
	return { blocking, excepted, unused };
}

const audit = (...args) =>
	spawnSync("npm", ["audit", "--json", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	let verdict;
	try {
		const exceptions = readExceptions(
			existsSync(exceptionsFile) ? JSON.parse(readFileSync(exceptionsFile, "utf8")) : [],
		);
		const advisories = readAudit(audit("--include=dev"));
		const shipped = readAudit(audit("--omit=dev"));
		verdict = judgeAudit({ advisories, shipped, exceptions });
	} catch (error) {
		console.error(`The dependency audit did not finish, so the dependencies are unverified: ${error.message}`);
		process.exit(1);
	}
	const { blocking, excepted, unused } = verdict;
	for (const { id, name, exception } of excepted)
		console.log(`audit exception used: ${id} in ${name} (${exception.reason})`);
	for (const { id } of unused)
		console.log(
			`audit exception unused: ${id} matches no advisory at high or above; remove it from ${exceptionsFile}`,
		);
	if (blocking.length > 0) {
		for (const { id, url, name, title, severity, shipped } of blocking)
			console.error(`${id ?? url} (${severity}) in ${name}${shipped ? ", a shipped dependency" : ""}: ${title}`);
		console.error(
			`Upgrade the dependency. Only when no fixed release exists and only dev dependencies reach it, add a reviewed entry to ${exceptionsFile}.`,
		);
		process.exit(1);
	}
}

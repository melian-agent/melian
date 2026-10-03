// npm ci installs whatever the lockfile names and ignores min-release-age, so a lockfile generated with
// --min-release-age=0 would carry a fresh release past the merge gate. This checks the lockfile itself.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const registry = "https://registry.npmjs.org/";
const dayMs = 24 * 60 * 60 * 1000;
const concurrency = 8;
const timeoutMs = 30_000;

// Returns registry entries to check, and entries that resolve elsewhere: a tarball URL, a git remote, or
// another registry. The gate cannot date those, so it rejects them rather than let them through unchecked.
export function parseLockfile(lock) {
	const entries = [];
	const foreign = [];
	for (const [path, entry] of Object.entries(lock.packages ?? {})) {
		if (path === "" || entry.link || entry.inBundle || !path.includes("node_modules/")) continue;
		const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
		if (entry.resolved?.startsWith(registry)) entries.push({ path, name, version: entry.version });
		else foreign.push({ path, name, version: entry.version, resolved: entry.resolved });
	}
	return { entries, foreign };
}

export function readWindowDays(npmrc) {
	const match = /^\s*min-release-age\s*=\s*(\d+(?:\.\d+)?)\s*$/m.exec(npmrc ?? "");
	return match ? Number(match[1]) : 2;
}

// times maps package name to the registry's time object, version to ISO publish date.
export function findTooYoung({ entries, times, now, windowDays, exceptions }) {
	const tooYoung = [];
	const excepted = [];
	for (const entry of entries) {
		const published = times.get(entry.name)?.[entry.version];
		const ageDays = published === undefined ? undefined : (now - Date.parse(published)) / dayMs;
		if (ageDays !== undefined && ageDays >= windowDays) continue;
		const exception = exceptions.find((e) => e.name === entry.name && e.version === entry.version);
		if (exception) excepted.push({ ...entry, published, exception });
		else tooYoung.push({ ...entry, published });
	}
	return { tooYoung, excepted };
}

async function fetchTimes(names) {
	const times = new Map();
	const failures = [];
	const queue = [...names];
	const worker = async () => {
		for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
			try {
				const response = await fetch(registry + name.replace("/", "%2f"), {
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				times.set(name, (await response.json()).time ?? {});
			} catch (error) {
				failures.push(`${name}: ${error.message}`);
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	return { times, failures };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
	const windowDays = readWindowDays(existsSync(".npmrc") ? readFileSync(".npmrc", "utf8") : undefined);
	const exceptionsFile = ".release-age-exceptions.json";
	const exceptions = existsSync(exceptionsFile) ? JSON.parse(readFileSync(exceptionsFile, "utf8")) : [];
	const { entries, foreign } = parseLockfile(lock);
	const { times, failures } = await fetchTimes(new Set(entries.map((entry) => entry.name)));
	if (failures.length > 0) {
		console.error(`Could not read publish times from the npm registry, so release ages are unverified:`);
		console.error(failures.join("\n"));
		process.exit(1);
	}
	const { tooYoung, excepted } = findTooYoung({ entries, times, now: Date.now(), windowDays, exceptions });
	for (const { name, version, exception } of excepted)
		console.log(`release-age exception used: ${name}@${version} (${exception.reason})`);
	const problems = [
		...foreign.map(
			(e) => `${e.path}: ${e.name}@${e.version} resolves to ${e.resolved ?? "nothing"}, not the npm registry`,
		),
		...tooYoung.map(
			(e) =>
				`${e.path}: ${e.name}@${e.version} published ${e.published ?? "at an unknown time"}, inside the ${windowDays}-day window`,
		),
	];
	if (problems.length > 0) {
		console.error(problems.join("\n"));
		console.error(`Wait for the window to pass, or add a reviewed entry to ${exceptionsFile}.`);
		process.exit(1);
	}
}

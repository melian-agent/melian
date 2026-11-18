// Records the hash of every module each producer's run reaches, so a key can move with the code that decides its
// result. Usage: node scripts/code-hashes.mjs [--write]. Without --write it prints what differs and exits 1 if anything does.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export const recordedFile = "packages/pipeline/src/code-hashes.ts";

// Each producer's entry module. The compiler lists what it reaches.
export const producers = { adjudication: "packages/pipeline/src/adjudication.ts" };

// Asks TypeScript for every file `entry` reaches, as the gate's own compiler resolves them: the native compiler ships no
// program API, so its command line is the authority. Installed packages are left out, since the lockfile versions them.
// The recorded file is left out too: it holds the hashes, so its own hash would depend on itself.
export function reachedModules(entry, repo = root) {
	const scratch = mkdtempSync(join(tmpdir(), "melian-code-hashes-"));
	try {
		const config = join(scratch, "tsconfig.json");
		writeFileSync(
			config,
			JSON.stringify({
				extends: join(repo, "tsconfig.base.json"),
				compilerOptions: {
					noEmit: true,
					customConditions: ["@melian-agent/source"],
					typeRoots: [join(repo, "node_modules/@types")],
				},
				files: [join(repo, entry)],
			}),
		);
		const run = spawnSync(join(repo, "node_modules/.bin/tsc"), ["-p", config, "--listFilesOnly"], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		if (run.status !== 0) {
			const errors = `${run.stdout}${run.stderr}`.split("\n").filter((line) => line.includes("error TS"));
			throw new Error(
				`TypeScript could not list what ${entry} reaches: ${errors.join("; ") || `exit ${run.status}`}`,
			);
		}
		const listed = run.stdout;
		const modules = new Set();
		for (const line of listed.split("\n")) {
			if (line === "" || line.split(/[\\/]/).includes("node_modules")) continue;
			const path = relative(repo, line).split(sep).join("/");
			if (path.startsWith("../") || isAbsolute(path))
				throw new Error(`${entry} reaches ${line}, outside the repository`);
			if (path === recordedFile) continue;
			modules.add(path);
		}
		if (!modules.has(entry))
			throw new Error(`TypeScript did not list ${entry} itself; the listing is not trustworthy`);
		return [...modules].sort();
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export function hashOf(path, repo = root) {
	return createHash("sha256")
		.update(readFileSync(join(repo, path)))
		.digest("hex");
}

// What the recorded file should hold now: each producer's reached modules, sorted, and each module's hash once.
export function computeRecord(repo = root, entries = producers) {
	const producerModules = {};
	const moduleHashes = {};
	for (const name of Object.keys(entries).sort()) {
		producerModules[name] = reachedModules(entries[name], repo);
		for (const path of producerModules[name]) moduleHashes[path] ??= hashOf(path, repo);
	}
	return {
		moduleHashes: Object.fromEntries(Object.entries(moduleHashes).sort(([a], [b]) => (a < b ? -1 : 1))),
		producerModules,
	};
}

// One line per difference, naming the producer and the module, or nothing when the record matches.
export function differences(recorded, computed) {
	const found = [];
	const names = [
		...new Set([...Object.keys(recorded.producerModules), ...Object.keys(computed.producerModules)]),
	].sort();
	for (const name of names) {
		const was = new Set(recorded.producerModules[name] ?? []);
		const now = new Set(computed.producerModules[name] ?? []);
		if (!(name in computed.producerModules)) found.push(`${name}: recorded, but no longer a producer`);
		if (!(name in recorded.producerModules)) found.push(`${name}: a producer with no recorded modules`);
		for (const path of now) if (!was.has(path)) found.push(`${name}: now reaches ${path}, which its list lacks`);
		for (const path of was)
			if (!now.has(path)) found.push(`${name}: no longer reaches ${path}, which its list names`);
		for (const path of now) {
			if (was.has(path) && recorded.moduleHashes[path] !== computed.moduleHashes[path]) {
				found.push(`${name}: ${path} changed since its hash was recorded`);
			}
		}
	}
	for (const path of Object.keys(recorded.moduleHashes)) {
		if (!(path in computed.moduleHashes)) found.push(`${path}: hashed, but no producer reaches it`);
	}
	return found;
}

// A blank line parts every entry, so two pull requests that change different modules touch lines git can merge apart.
export function render({ moduleHashes, producerModules }) {
	const hashes = Object.entries(moduleHashes).map(
		([path, hash]) => `\t${JSON.stringify(path)}: ${JSON.stringify(hash)},\n`,
	);
	const lists = Object.entries(producerModules).map(
		([name, paths]) => `\t${name}: [\n${paths.map((path) => `\t\t${JSON.stringify(path)},\n`).join("\n")}\t],\n`,
	);
	return [
		"// Generated by `npm run code-hashes`, from the modules TypeScript lists for each producer. Never edit it by hand.\n",
		"// A blank line parts every entry, so two pull requests that change different modules merge without a conflict.\n",
		"\n",
		"export const moduleHashes: Readonly<Record<string, string>> = {\n",
		hashes.join("\n"),
		"};\n",
		"\n",
		"export const producerModules: Readonly<Record<string, readonly string[]>> = {\n",
		lists.join("\n"),
		"};\n",
	].join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const computed = computeRecord();
	if (process.argv.includes("--write")) {
		writeFileSync(join(root, recordedFile), render(computed));
		// Biome wraps a line past its width, and the gate's own Biome would otherwise rewrite the file.
		const format = spawnSync(join(root, "node_modules/.bin/biome"), ["format", "--write", recordedFile], {
			cwd: root,
			stdio: "inherit",
		});
		if (format.status !== 0) process.exit(format.status ?? 1);
	} else {
		const { moduleHashes, producerModules } = await import(join(root, recordedFile));
		const found = differences({ moduleHashes, producerModules }, computed);
		for (const line of found) console.log(line);
		if (found.length > 0) {
			console.log("Run `npm run code-hashes` to record them.");
			process.exit(1);
		}
	}
}

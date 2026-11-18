import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moduleHashes, producerModules } from "../packages/pipeline/src/code-hashes.ts";
import { computeRecord, differences, reachedModules, render } from "./code-hashes.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("the recorded code hashes", () => {
	it("match what each producer reaches now", { timeout: 60_000 }, () => {
		const found = differences({ moduleHashes, producerModules }, computeRecord());
		expect(found, `run \`npm run code-hashes\` to record:\n${found.join("\n")}`).toEqual([]);
	});
});

describe("the check over a scratch repository", () => {
	let repo;
	const write = (path, text) => {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	};
	const producers = { lens: "src/entry.ts" };

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "melian-code-hashes-test-"));
		copyFileSync(join(root, "tsconfig.base.json"), join(repo, "tsconfig.base.json"));
		symlinkSync(join(root, "node_modules"), join(repo, "node_modules"));
		write("src/entry.ts", 'import { a } from "./a.ts";\nexport const entry = a;\n');
		write("src/a.ts", "export const a = 1;\n");
		write("src/b.ts", "export const b = 2;\n");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(repo, { recursive: true, force: true });
	});
	const failure = (run) => {
		try {
			run();
		} catch (error) {
			return error.message;
		}
		throw new Error("expected a failure");
	};

	it("lists the modules TypeScript reaches, and no others, by name", { timeout: 60_000 }, () => {
		write("src/entry.ts", 'import { z } from "./z.ts";\nimport { a } from "./a.ts";\nexport const entry = z + a;\n');
		write("src/z.ts", "export const z = 1;\n");
		expect(computeRecord(repo, producers).producerModules).toEqual({
			lens: ["src/a.ts", "src/entry.ts", "src/z.ts"],
		});
	});

	it("orders producers and hashed modules by name, whatever order it reaches them in", { timeout: 60_000 }, () => {
		write("src/entry.ts", 'import { z } from "./z.ts";\nimport { a } from "./a.ts";\nexport const entry = z + a;\n');
		write("src/z.ts", "export const z = 1;\n");
		const record = computeRecord(repo, { beta: "src/entry.ts", alpha: "src/z.ts" });
		expect(Object.keys(record.producerModules)).toEqual(["alpha", "beta"]);
		expect(Object.keys(record.moduleHashes)).toEqual(["src/a.ts", "src/entry.ts", "src/z.ts"]);
	});

	it("refuses an entry TypeScript cannot list, quoting only its errors", { timeout: 60_000 }, () => {
		expect(failure(() => reachedModules("src/missing.ts", repo))).toBe(
			`TypeScript could not list what src/missing.ts reaches: error TS6053: File '${join(repo, "src/missing.ts")}' not found.`,
		);
	});

	it("refuses a module outside the repository", { timeout: 60_000 }, () => {
		const outside = mkdtempSync(join(tmpdir(), "melian-code-hashes-outside-"));
		try {
			writeFileSync(join(outside, "o.ts"), "export const o = 1;\n");
			write("src/entry.ts", `import { o } from ${JSON.stringify(join(outside, "o.ts"))};\nexport const entry = o;\n`);
			expect(failure(() => reachedModules("src/entry.ts", repo))).toBe(
				`src/entry.ts reaches ${join(outside, "o.ts")}, outside the repository`,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses a listing that leaves out the entry itself", { timeout: 60_000 }, () => {
		write("packages/pipeline/src/code-hashes.ts", "export const moduleHashes = {};\n");
		expect(failure(() => reachedModules("packages/pipeline/src/code-hashes.ts", repo))).toBe(
			"TypeScript did not list packages/pipeline/src/code-hashes.ts itself; the listing is not trustworthy",
		);
	});

	it("leaves no scratch directory behind", { timeout: 60_000 }, () => {
		const temporary = mkdtempSync(join(tmpdir(), "melian-code-hashes-tmpdir-"));
		try {
			vi.stubEnv("TMPDIR", temporary);
			expect(reachedModules("src/entry.ts", repo)).toEqual(["src/a.ts", "src/entry.ts"]);
			expect(readdirSync(temporary)).toEqual([]);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});

	it("names the producer and the module whose text changed without its line", { timeout: 60_000 }, () => {
		const recorded = computeRecord(repo, producers);
		write("src/a.ts", "export const a = 3;\n");
		expect(differences(recorded, computeRecord(repo, producers))).toEqual([
			"lens: src/a.ts changed since its hash was recorded",
		]);
	});

	it("names a module the producer now reaches that its list lacks", { timeout: 60_000 }, () => {
		const recorded = computeRecord(repo, producers);
		write("src/entry.ts", 'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nexport const entry = a + b;\n');
		expect(differences(recorded, computeRecord(repo, producers))).toEqual([
			"lens: now reaches src/b.ts, which its list lacks",
			"lens: src/entry.ts changed since its hash was recorded",
		]);
	});

	it("names a module the producer no longer reaches that its list names", { timeout: 60_000 }, () => {
		const recorded = computeRecord(repo, producers);
		write("src/entry.ts", "export const entry = 1;\n");
		expect(differences(recorded, computeRecord(repo, producers))).toEqual([
			"lens: no longer reaches src/a.ts, which its list names",
			"lens: src/entry.ts changed since its hash was recorded",
			"src/a.ts: hashed, but no producer reaches it",
		]);
	});
});

describe("the command", () => {
	let repo;
	const write = (path, text) => {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	};
	// A copy of the script in a scratch repository, whose root it takes from its own place, so it never writes this one.
	const run = (...args) =>
		spawnSync(process.execPath, [join(repo, "scripts/code-hashes.mjs"), ...args], { cwd: repo, encoding: "utf8" });

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "melian-code-hashes-command-"));
		copyFileSync(join(root, "tsconfig.base.json"), join(repo, "tsconfig.base.json"));
		symlinkSync(join(root, "node_modules"), join(repo, "node_modules"));
		write("scripts/code-hashes.mjs", readFileSync(join(root, "scripts/code-hashes.mjs"), "utf8"));
		write("packages/pipeline/src/adjudication.ts", 'import { a } from "./a.ts";\nexport const n = a;\n');
		write("packages/pipeline/src/a.ts", "export const a = 1;\n");
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it("writes a record that it then reads as matching", { timeout: 60_000 }, () => {
		expect(run("--write").status).toBe(0);
		expect(existsSync(join(repo, "packages/pipeline/src/code-hashes.ts"))).toBe(true);
		expect(run()).toMatchObject({ status: 0, stdout: "" });
	});

	it("checks nothing when another module imports it", { timeout: 60_000 }, () => {
		expect(run("--write").status).toBe(0);
		write("packages/pipeline/src/a.ts", "export const a = 2;\n");
		const script = pathToFileURL(join(repo, "scripts/code-hashes.mjs")).href;
		const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(script)});`], {
			cwd: repo,
			encoding: "utf8",
		});
		expect(imported).toMatchObject({ status: 0, stdout: "" });
	});

	it("prints each difference and the command, and fails, once a module changes", { timeout: 60_000 }, () => {
		expect(run("--write").status).toBe(0);
		write("packages/pipeline/src/a.ts", "export const a = 2;\n");
		expect(run()).toMatchObject({
			status: 1,
			stdout:
				"adjudication: packages/pipeline/src/a.ts changed since its hash was recorded\nRun `npm run code-hashes` to record them.\n",
		});
	});
});

describe("the command's formatting", () => {
	let repo;
	// A fake Biome that records where and how it ran, and exits with BIOME_EXIT.
	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "melian-code-hashes-format-"));
		copyFileSync(join(root, "tsconfig.base.json"), join(repo, "tsconfig.base.json"));
		mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
		for (const name of readdirSync(join(root, "node_modules")))
			if (name !== ".bin") symlinkSync(join(root, "node_modules", name), join(repo, "node_modules", name));
		symlinkSync(join(root, "node_modules/.bin/tsc"), join(repo, "node_modules/.bin/tsc"));
		writeFileSync(
			join(repo, "node_modules/.bin/biome"),
			'#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$0.args"\nexit "${BIOME_EXIT:-0}"\n',
		);
		chmodSync(join(repo, "node_modules/.bin/biome"), 0o755);
		mkdirSync(join(repo, "scripts"));
		writeFileSync(join(repo, "scripts/code-hashes.mjs"), readFileSync(join(root, "scripts/code-hashes.mjs"), "utf8"));
		mkdirSync(join(repo, "packages/pipeline/src"), { recursive: true });
		writeFileSync(join(repo, "packages/pipeline/src/adjudication.ts"), "export const n = 1;\n");
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));
	const write = (exit) =>
		spawnSync(process.execPath, [join(repo, "scripts/code-hashes.mjs"), "--write"], {
			cwd: tmpdir(),
			encoding: "utf8",
			env: { ...process.env, BIOME_EXIT: String(exit) },
		});

	it("formats the record it wrote, from the repository's root", { timeout: 60_000 }, () => {
		expect(write(0).status).toBe(0);
		expect(readFileSync(join(repo, "node_modules/.bin/biome.args"), "utf8")).toBe(
			`${repo}\nformat\n--write\npackages/pipeline/src/code-hashes.ts\n`,
		);
	});

	it("fails with Biome's own status when Biome fails", { timeout: 60_000 }, () => {
		expect(write(3).status).toBe(3);
	});
});

describe("differences", () => {
	const record = { moduleHashes: { "a.ts": "1", "b.ts": "2" }, producerModules: { lens: ["a.ts", "b.ts"] } };

	it("finds nothing in a matching record", () => {
		expect(differences(record, structuredClone(record))).toEqual([]);
	});

	it("names a producer that has gone, and one that is new", () => {
		const computed = { moduleHashes: record.moduleHashes, producerModules: { other: ["a.ts", "b.ts"] } };
		expect(differences(record, computed)).toEqual([
			"lens: recorded, but no longer a producer",
			"lens: no longer reaches a.ts, which its list names",
			"lens: no longer reaches b.ts, which its list names",
			"other: a producer with no recorded modules",
			"other: now reaches a.ts, which its list lacks",
			"other: now reaches b.ts, which its list lacks",
		]);
	});

	it("orders its lines by producer name", () => {
		const recorded = { moduleHashes: { "a.ts": "1" }, producerModules: { zed: ["a.ts"] } };
		const computed = { moduleHashes: { "a.ts": "1" }, producerModules: { alpha: ["a.ts"] } };
		expect(differences(recorded, computed)).toEqual([
			"alpha: a producer with no recorded modules",
			"alpha: now reaches a.ts, which its list lacks",
			"zed: recorded, but no longer a producer",
			"zed: no longer reaches a.ts, which its list names",
		]);
	});
});

describe("the recorded layout", () => {
	let scratch;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "melian-code-hashes-merge-"));
	});
	afterEach(() => rmSync(scratch, { recursive: true, force: true }));

	const merge = (base, ours, theirs) => {
		for (const [name, record] of Object.entries({ base, ours, theirs }))
			writeFileSync(join(scratch, name), render(record));
		const run = spawnSync(
			"git",
			["merge-file", "-p", join(scratch, "ours"), join(scratch, "base"), join(scratch, "theirs")],
			{
				encoding: "utf8",
			},
		);
		return { conflicts: run.status, text: run.stdout };
	};
	const record = (hashes) => ({ moduleHashes: hashes, producerModules: { lens: Object.keys(hashes) } });

	it("lets two pull requests that change neighbouring modules merge without a conflict", () => {
		const base = record({ "a.ts": "1", "b.ts": "2", "c.ts": "3" });
		const ours = record({ "a.ts": "1", "b.ts": "20", "c.ts": "3" });
		const theirs = record({ "a.ts": "1", "b.ts": "2", "c.ts": "30" });
		const merged = merge(base, ours, theirs);
		expect(merged.conflicts).toBe(0);
		expect(merged.text).toBe(render(record({ "a.ts": "1", "b.ts": "20", "c.ts": "30" })));
	});

	it("conflicts when two pull requests add different modules in the same gap, which git cannot order", () => {
		const base = record({ "a.ts": "1", "d.ts": "4" });
		const ours = record({ "a.ts": "1", "b.ts": "2", "d.ts": "4" });
		const theirs = record({ "a.ts": "1", "c.ts": "3", "d.ts": "4" });
		expect(merge(base, ours, theirs).conflicts).toBeGreaterThan(0);
	});
});

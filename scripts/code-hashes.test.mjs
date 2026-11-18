import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moduleHashes, producerModules } from "../packages/pipeline/src/code-hashes.ts";
import { computeRecord, differences, render } from "./code-hashes.mjs";

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
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it("lists the modules TypeScript reaches, and no others", { timeout: 60_000 }, () => {
		expect(computeRecord(repo, producers).producerModules).toEqual({ lens: ["src/a.ts", "src/entry.ts"] });
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

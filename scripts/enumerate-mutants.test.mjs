import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Instrumenter } from "@stryker-mutator/instrumenter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mutationUnmutated } from "../packages/core/src/mutation.ts";
import { enumerateMutants, renderTable } from "./enumerate-mutants.mjs";

const excluded = [
	{ file: "packages/core/src/git.ts", reason: mutationUnmutated.signals.why },
	{ file: "src/a,b.ts", reason: mutationUnmutated.comma.why },
	{ file: "tool.config.mjs", reason: mutationUnmutated.configuration.why },
	{ file: "tool.config.ts", reason: mutationUnmutated.configuration.why },
];

describe("mutant enumeration", { timeout: 60_000 }, () => {
	const script = fileURLToPath(new URL("./enumerate-mutants.mjs", import.meta.url));
	const logger = { debug() {}, info() {}, warn() {}, trace() {}, error() {}, isDebugEnabled: () => false };
	let root;
	function git(...args) {
		return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	}
	function write(path, text) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "melian-enumerate-")));
		git("init", "-b", "main");
		git("config", "user.email", "fixture@example.test");
		git("config", "user.name", "Fixture");
		write("stryker.config.json", readFileSync(new URL("../stryker.config.json", import.meta.url), "utf8"));
		write(
			"src/value.ts",
			"export const unchanged = (x: number) => x > 0;\nexport const changed = (x: number) => x > 1;\nexport const after = (x: number) => x < 10;\n",
		);
		git("add", ".");
		git("commit", "-m", "base");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		write(
			"src/value.ts",
			"export const unchanged = (x: number) => x > 0;\nexport const changed = (x: number) => x >= 1;\nexport const after = (x: number) => x < 10;\n",
		);
		for (const path of [
			"src/value.test.ts",
			"tests/a.ts",
			"fixtures/b.ts",
			"src/a.d.ts",
			"tool.config.ts",
			"tool.config.mjs",
			"src/a.test.mjs",
			"src/a.ts.txt",
			"src/a,b.ts",
			"packages/core/src/git.ts",
		])
			write(path, "export const excluded = (x) => x > 1;\n");
		write(
			"src/script.mjs",
			"throw new Error('enumerated source must not be imported');\nexport const value = (x) => x ?? [];\n",
		);
		git("add", ".");
		git("commit", "-m", "head");
		write("babel.config.cjs", "throw new Error('head Babel config must never run');\n");
		write("src/.babelrc.cjs", "throw new Error('head Babel config must never run');\n");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("matches the instrumenter exactly on changed production lines, including JavaScript", async () => {
		const files = [
			{
				name: "src/script.mjs",
				content: readFileSync(join(root, "src/script.mjs"), "utf8"),
				mutate: [{ start: { line: 0, column: 0 }, end: { line: 1, column: Number.MAX_SAFE_INTEGER } }],
			},
			{
				name: "src/value.ts",
				content: readFileSync(join(root, "src/value.ts"), "utf8"),
				mutate: [{ start: { line: 1, column: 0 }, end: { line: 1, column: Number.MAX_SAFE_INTEGER } }],
			},
		];
		const { mutants } = await new Instrumenter(logger).instrument(files, {
			excludedMutations: ["StringLiteral"],
			ignorers: [],
			plugins: null,
		});
		const expected = mutants.map(({ fileName, location, mutatorName, replacement, status, statusReason }) => ({
			file: fileName,
			line: location.start.line + 1,
			column: location.start.column,
			endLine: location.end.line + 1,
			endColumn: location.end.column,
			mutatorName,
			replacement,
			status,
			statusReason,
		}));
		expect(expected.length).toBeGreaterThan(5);
		expect(await enumerateMutants({ cwd: root, limit: 1000 })).toEqual({
			mutants: expected,
			total: expected.length,
			omitted: 0,
			unmutated: excluded,
		});
		// Read committed head text, even when the working tree differs.
		write("src/value.ts", "invalid head text!");
		expect(await enumerateMutants({ cwd: root, range: "origin/main...HEAD", limit: 1000 })).toEqual({
			mutants: expected,
			total: expected.length,
			omitted: 0,
			unmutated: excluded,
		});
	});

	it("reports a changed TypeScript symlink as unmutated, using its committed head kind", async () => {
		write("target.txt", "export const target = (x: number) => x > 0;\n");
		symlinkSync("../target.txt", join(root, "src/link.ts"));
		git("add", "target.txt", "src/link.ts");
		git("commit", "-m", "symlink");
		const result = await enumerateMutants({ cwd: root });
		expect(result.unmutated).toEqual([
			...excluded.slice(0, 2),
			{ file: "src/link.ts", reason: "the head entry is symlink; only regular files are mutated" },
			...excluded.slice(2),
		]);
		expect(result.mutants.filter((mutant) => mutant.file === "src/link.ts")).toEqual([]);
		rmSync(join(root, "src/link.ts"));
		write("src/link.ts", "export const worktree = false;\n");
		expect(await enumerateMutants({ cwd: root })).toEqual(result);
		const child = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout).toContain(
			'UNMUTATED\t"src/link.ts"\t"the head entry is symlink; only regular files are mutated"',
		);
	});

	it("reports a changed TypeScript submodule as unmutated", async () => {
		git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},src/submodule.ts`);
		git("commit", "-m", "submodule");
		expect((await enumerateMutants({ cwd: root })).unmutated).toEqual([
			...excluded.slice(0, 2),
			{ file: "src/submodule.ts", reason: "the head entry is submodule; only regular files are mutated" },
			...excluded.slice(2),
		]);
	});

	it("reports a binary production file and one whose name is not UTF-8 as unmutated", async () => {
		write(".gitattributes", "src/a.ts -diff\n");
		write("src/a.ts", "export const a = (x: number) => x > 0;\n");
		git("add", ".gitattributes", "src/a.ts");
		git("commit", "-m", "attributes");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		write("src/a.ts", "export const a = (x: number) => x >= 0;\n");
		git("add", "src/a.ts");
		const blob = git("rev-parse", "HEAD:src/a.ts");
		const name = Buffer.concat([Buffer.from("src/caf"), Buffer.from([0xe9]), Buffer.from(".ts")]);
		execFileSync("git", ["update-index", "--index-info"], {
			cwd: root,
			input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), name, Buffer.from("\n")]),
		});
		git("commit", "-m", "binary");
		expect(await enumerateMutants({ cwd: root })).toEqual({
			mutants: [],
			total: 0,
			omitted: 0,
			unmutated: [
				{ file: "src/a.ts", reason: mutationUnmutated.binary.why },
				{ file: "src/caf%E9.ts", reason: mutationUnmutated.binary.why },
			],
		});
	});

	it("enumerates an executable regular file", async () => {
		write("src/executable.ts", "export const executable = true;\n");
		chmodSync(join(root, "src/executable.ts"), 0o755);
		git("add", ".");
		git("commit", "-m", "executable");
		const result = await enumerateMutants({ cwd: root });
		expect(result.mutants.filter((mutant) => mutant.file === "src/executable.ts")).toEqual([
			{
				file: "src/executable.ts",
				line: 1,
				column: 26,
				endLine: 1,
				endColumn: 30,
				mutatorName: "BooleanLiteral",
				replacement: "false",
			},
		]);
	});

	it("prints a reproducible sampling selection from a complete classified inventory", () => {
		const mutant = {
			file: "src/a.ts",
			line: 1,
			column: 0,
			endLine: 1,
			endColumn: 1,
			mutatorName: "ConditionalExpression",
			replacement: "true",
			claim: "killed",
			evidence: "value.test.ts > guard",
			survivorClasses: ["compound-condition"],
		};
		write("claims.json", JSON.stringify({ mutants: [mutant], total: 1, omitted: 0, unmutated: [] }));
		for (const args of [
			["--sample", "claims.json"],
			["--sample", "claims.json", "--json", "--limit", "0"],
		]) {
			const child = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
			expect(child.status, child.stderr).toBe(0);
			const selected = JSON.parse(child.stdout);
			expect(selected).toEqual({
				selected: [{ ...mutant, sampleHash: "b4909d8c461235c8a78ce0dfbb445781394b1abfaf0b19858345fc019a01dbe8" }],
				total: 1,
				unmutated: [],
			});
		}
	});

	it("sampling rejects a range, an empty filename and unreadable or incomplete claims", () => {
		for (const [args, text] of [
			[["HEAD..HEAD", "--sample", "claims.json"], "use either a range or --sample FILE"],
			[["--sample="], "ENOENT"],
			[["--sample", "missing.json"], "ENOENT"],
		]) {
			const child = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
			expect(child.status, child.stderr).toBe(1);
			expect(child.stderr).toContain(text);
		}
		for (const content of ['{"mutants":[],"total":1,"omitted":1}', "{"]) {
			write("claims.json", content);
			const child = spawnSync(process.execPath, [script, "--sample", "claims.json"], {
				cwd: root,
				encoding: "utf8",
			});
			expect(child.status, child.stderr).toBe(1);
			expect(child.stderr.length).toBeGreaterThan(0);
		}
	});

	it("reads excluded mutations as data and reports generated ignored mutants", async () => {
		for (const config of [{}, { mutator: {} }, { mutator: { excludedMutations: ["StringLiteral"] } }]) {
			write("stryker.config.json", JSON.stringify(config));
			git("add", "stryker.config.json");
			git("commit", "--allow-empty", "-m", "config");
			const result = await enumerateMutants({ cwd: root });
			const strings = result.mutants.filter((mutant) => mutant.mutatorName === "StringLiteral");
			expect(strings).toHaveLength(1);
			expect(strings[0].status).toBe(config.mutator?.excludedMutations ? "Ignored" : undefined);
		}
	});

	it("cleans scratch after successful instrumentation and a parser error", async () => {
		for (const invalid of [false, true]) {
			if (invalid) {
				write("src/invalid.ts", "export const = ;");
				git("add", "src/invalid.ts");
				git("commit", "-m", "invalid");
			}
			const before = new Set(readdirSync(tmpdir()));
			if (invalid) await expect(enumerateMutants({ cwd: root })).rejects.toThrow();
			else await enumerateMutants({ cwd: root });
			expect(
				readdirSync(tmpdir()).filter(
					(name) => name.startsWith(`melian-enumerate-${process.pid}-`) && !before.has(name),
				),
			).toEqual([]);
		}
	});

	it("honours the exact limit, zero, and one past it", async () => {
		const full = await enumerateMutants({ cwd: root });
		for (const limit of [0, full.total - 1, full.total, full.total + 1]) {
			expect(await enumerateMutants({ cwd: root, limit })).toEqual({
				mutants: full.mutants.slice(0, limit),
				total: full.total,
				omitted: Math.max(0, full.total - limit),
				unmutated: excluded,
			});
		}
	});

	it("bounds default output at 200 and returns no mutants for an unchanged range", async () => {
		write("src/many.ts", Array.from({ length: 205 }, (_, index) => `export const value${index} = true;`).join("\n"));
		git("add", "src/many.ts");
		git("commit", "-m", "many");
		const full = await enumerateMutants({ cwd: root, limit: 1000 });
		expect(full.total).toBeGreaterThan(200);
		expect(await enumerateMutants({ cwd: root })).toEqual({
			mutants: full.mutants.slice(0, 200),
			total: full.total,
			omitted: full.total - 200,
			unmutated: excluded,
		});
		expect(await enumerateMutants({ cwd: root, range: "HEAD..HEAD" })).toEqual({
			mutants: [],
			total: 0,
			omitted: 0,
			unmutated: [],
		});
	});

	it("prints valid JSON and an escaped text table without importing the enumerated source or running ps", () => {
		for (const args of [
			["--json", "--limit", "1"],
			["origin/main...HEAD", "--limit=0"],
			["HEAD..HEAD", "--json"],
		]) {
			const child = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
			expect(child.status, child.stderr).toBe(0);
			expect(child.stderr).toBe("");
			if (args.includes("--json")) {
				const result = JSON.parse(child.stdout);
				if (args[0] === "HEAD..HEAD") expect(result).toEqual({ mutants: [], total: 0, omitted: 0, unmutated: [] });
				else {
					expect(result.mutants).toHaveLength(1);
					expect(result.omitted).toBe(result.total - 1);
					expect(result.unmutated).toEqual(excluded);
				}
			} else {
				expect(child.stdout).toMatch(
					/^FILE\s+LINE\s+COLUMN\s+END_LINE\s+END_COLUMN\s+MUTATOR\s+REPLACEMENT\s+POLICY\n(?:UNMUTATED\t.*\n){4}\n0 of \d+ mutants; \d+ omitted\n$/,
				);
				expect(child.stdout.split("\n").slice(1, 5)).toEqual(
					excluded.map(({ file, reason }) => `UNMUTATED\t${JSON.stringify(file)}\t${JSON.stringify(reason)}`),
				);
			}
		}
		expect(
			renderTable({
				mutants: [
					{
						file: "a\nb.ts",
						line: 2,
						column: 3,
						endLine: 4,
						endColumn: 1,
						mutatorName: "BlockStatement",
						replacement: "{\n}",
					},
				],
				total: 1,
				omitted: 0,
			}),
		).toBe(
			'FILE\tLINE\tCOLUMN\tEND_LINE\tEND_COLUMN\tMUTATOR\tREPLACEMENT\tPOLICY\n"a\\nb.ts"\t2\t3\t4\t1\tBlockStatement\t"{\\n}"\t{}\n\n1 of 1 mutants; 0 omitted',
		);
	});

	it("prints Stryker's ignored status and reason in the table", () => {
		expect(
			renderTable({
				mutants: [
					{
						file: "a.ts",
						line: 1,
						column: 0,
						endLine: 1,
						endColumn: 2,
						mutatorName: "StringLiteral",
						replacement: '""',
						status: "Ignored",
						statusReason: "configured",
					},
				],
				total: 1,
				omitted: 0,
			}),
		).toBe(
			'FILE\tLINE\tCOLUMN\tEND_LINE\tEND_COLUMN\tMUTATOR\tREPLACEMENT\tPOLICY\n"a.ts"\t1\t0\t1\t2\tStringLiteral\t"\\"\\""\t{"status":"Ignored","statusReason":"configured"}\n\n1 of 1 mutants; 0 omitted',
		);
	});

	it.each(["-1", "1.5", "NaN", "Infinity", "9007199254740992"])("rejects invalid limit %s", async (limit) => {
		await expect(enumerateMutants({ cwd: root, limit: Number(limit) })).rejects.toThrow("limit");
		const child = spawnSync(process.execPath, [script, "--limit", limit], { cwd: root, encoding: "utf8" });
		expect(child.status).toBe(1);
		expect(child.stderr).toContain("limit");
	});

	it("does not run the CLI when imported, including without an entry filename", () => {
		const source = `import ${JSON.stringify(pathToFileURL(script).href)}; console.log("imported");`;
		write("imported.mjs", source);
		for (const args of [[join(root, "imported.mjs")], ["--input-type=module", "--eval", source]]) {
			const child = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
			expect(child.status, child.stderr).toBe(0);
			expect(child.stderr).toBe("");
			expect(child.stdout).toBe("imported\n");
		}
	});

	it("rejects extra arguments and invalid refs, and explains defaults in help", () => {
		for (const args of [["--unknown"], ["HEAD", "HEAD"], ["--limit"], ["--sample"], ["missing...HEAD"]]) {
			const child = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
			expect(child.status).toBe(1);
			expect(child.stderr.length).toBeGreaterThan(0);
			if (args[0] === "HEAD") expect(child.stderr).toContain("expected one git range");
		}
		const help = spawnSync(process.execPath, [script, "--help"], { cwd: root, encoding: "utf8" });
		expect(help.status).toBe(0);
		expect(help.stdout).toBe(
			"Usage: node scripts/enumerate-mutants.mjs [range] [--json] [--limit N] [--sample FILE]\nDefaults: range origin/main...HEAD; limit 200 (output rows).\nLines are 1-based; columns are 0-based. Replacements are JSON-escaped in the table.\nRuns the checkout's own code, like its tests: trusted heads only; never a fork's head.\nReads committed source and stryker.config.json; runs no tests or process listing.\nUses static.mutation's path exclusions, also accepts JavaScript, and applies no line budget.\nIncludes generated ignored mutants; static status needs the host's static.mutation run.\n--sample FILE prints JSON probes from a complete classified inventory; --limit applies only to enumeration.\nAdd claim (killed/new-test/equivalent), evidence, and survivorClasses to every mutant.\nSampling covers each class, mutator and file, then a hash-ordered fifth of remaining kills per file, rounded up.\n",
		);
	});
});

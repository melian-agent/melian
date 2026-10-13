import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationVitest } from "../src/mutation-vitest.ts";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
let root: string;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("Vitest chooses mutation tests", { timeout: 60_000 }, () => {
	it.each([
		"spec",
		"custom include",
		"coverage include",
		"indirect test",
		"project include",
		"CommonJS require",
		"mergeConfig",
		"function config",
		"setup",
		"global setup",
		"project setup",
		"mixed setup",
	])("runs the killing test with %s", (shape) => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "melian-vitest-selection-")));
		for (const path of ["src", "checks"]) mkdirSync(join(root, path));
		symlinkSync(join(checkout, "node_modules"), join(root, "node_modules"), "dir");
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		writeFileSync(
			join(root, "src/grade.ts"),
			'export function grade(x: number) { return x >= 50 ? "pass" : "fail"; }',
		);
		const name =
			shape === "custom include" ||
			shape === "coverage include" ||
			shape === "indirect test" ||
			shape === "project include"
				? "checks/grade.check.ts"
				: shape === "CommonJS require"
					? "checks/grade.spec.cjs"
					: "checks/grade.spec.ts";
		const setup = ["setup", "global setup", "project setup", "mixed setup"].includes(shape);
		const source =
			shape === "CommonJS require"
				? 'const { grade } = require("../src/grade.ts");'
				: setup
					? ""
					: 'import { grade } from "../src/grade.ts";';
		const assertion = shape === "global setup" ? "process.env.GRADE" : setup ? "globalThis.grade" : "grade(50)";
		writeFileSync(
			join(root, name),
			`${shape === "CommonJS require" ? "" : 'import { expect, it } from "vitest";'} ${source} it("kills the boundary mutant", () => expect(${assertion}).toBe("pass"));`,
		);
		writeFileSync(join(root, "checks/unrelated.spec.ts"), 'import { it } from "vitest"; it("unrelated", () => {});');
		writeFileSync(join(root, "setup.ts"), 'import { grade } from "./src/grade.ts"; globalThis.grade = grade(50);');
		writeFileSync(
			join(root, "global.ts"),
			'import { grade } from "./src/grade.ts"; export default function setup() { process.env.GRADE = grade(50); }',
		);
		let test = shape === "spec" ? "{}" : '{ include: ["checks/*.spec.ts"] }';
		if (shape === "CommonJS require") test = '{ globals: true, include: ["checks/*.spec.cjs", "checks/*.spec.ts"] }';
		if (name.endsWith(".check.ts")) test = '{ include: ["checks/*.check.ts"], coverage: { include: ["src/*.ts"] } }';
		if (shape === "setup" || shape === "mixed setup")
			test = '{ include: ["checks/*.spec.ts"], setupFiles: ["setup.ts"] }';
		if (shape === "global setup") test = '{ include: ["checks/*.spec.ts"], globalSetup: ["global.ts"] }';
		if (shape === "project include")
			test = '{ projects: [{ test: { name: "custom", include: ["checks/*.check.ts"] } }] }';
		if (shape === "project setup")
			test = '{ projects: [{ test: { name: "setup", include: ["checks/*.spec.ts"], setupFiles: ["setup.ts"] } }] }';
		let config = `export default defineConfig({ test: ${test} });`;
		if (shape === "indirect test") config = `const test = ${test}; export default defineConfig({ test });`;
		if (shape === "mergeConfig")
			config = `export default mergeConfig(defineConfig({ test: ${test} }), defineConfig({ test: { maxWorkers: 1 } }));`;
		if (shape === "function config") config = `export default defineConfig(() => ({ test: ${test} }));`;
		writeFileSync(
			join(root, "vitest.config.ts"),
			`import { defineConfig, mergeConfig } from "vitest/config"; ${config}`,
		);
		const changed = ["src/grade.ts"];
		if (shape === "mixed setup") {
			writeFileSync(join(root, "src/direct.ts"), "export const direct = 1;");
			writeFileSync(
				join(root, "checks/direct.spec.ts"),
				'import { it, expect } from "vitest"; import { direct } from "../src/direct.ts"; it("direct", () => expect(direct).toBe(1));',
			);
			changed.unshift("src/direct.ts");
		}
		const output = join(root, "selection.json");
		execFileSync(
			process.execPath,
			[
				"--conditions=@melian-agent/source",
				fileURLToPath(new URL("fixtures/mutation-vitest.ts", import.meta.url)),
				root,
				JSON.stringify(changed),
				output,
			],
			{ env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, timeout: 45_000, stdio: "pipe" },
		);
		const result = JSON.parse(readFileSync(output, "utf8")) as { runs: string[][]; notes: string[] };
		expect(result.runs).toHaveLength(1);
		expect(result.runs[0]).toContain(join(root, name));
		if (setup || shape === "CommonJS require") {
			expect(result.runs[0]).toContain(join(root, "checks/unrelated.spec.ts"));
			expect(result.notes[0]).toContain("whole suite");
		}
		writeFileSync(
			join(root, "src/grade.ts"),
			'export function grade(x: number) { return x > 50 ? "pass" : "fail"; }',
		);
		const mutant = spawnSync(
			process.execPath,
			[
				"--conditions=@melian-agent/source",
				fileURLToPath(new URL("fixtures/mutation-vitest.ts", import.meta.url)),
				root,
				JSON.stringify(changed),
				output,
			],
			{ env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, encoding: "utf8", timeout: 45_000 },
		);
		expect(mutant.status).toBe(1);
		expect(mutant.stderr).toMatch(/expected.*fail.*pass/);
	});
});

function listing(related: (files?: string[]) => readonly string[]) {
	const config: { related?: string[] } = {};
	return {
		config,
		getRelevantTestSpecifications: vi.fn(async () => related(config.related).map((moduleId) => ({ moduleId }))),
		close: vi.fn(async () => {}),
	};
}

it("unions each source's Vitest answer, closes the listing and runs only those tests", async () => {
	const vitest = listing((files) =>
		files === undefined
			? ["a.spec.ts", "b.spec.ts", "other.spec.ts"]
			: files[0]!.endsWith("a.ts")
				? ["a.spec.ts"]
				: ["b.spec.ts"],
	);
	const selection = await MutationVitest.open(async () => vitest, ["src/a.ts", "src/b.ts"]);
	const run = vi.fn(async () => ({ code: 0, report: '{"files":{}}' }));
	await selection.execute(run);
	expect(run.mock.calls).toEqual([[["a.spec.ts", "b.spec.ts"]]]);
	expect(vitest.close).toHaveBeenCalledOnce();
	expect(vitest.getRelevantTestSpecifications).toHaveBeenCalledTimes(3);
	expect(selection.notes).toEqual(["Mutation tests use 2 related test file(s) selected by Vitest."]);
});

it.each(["empty", "query error", "unreadable", "startup error", "close error", "all candidates"])(
	"executes the whole suite after %s",
	async (kind) => {
		const vitest = listing((files) =>
			files === undefined
				? ["a.spec.ts", "other.spec.ts"]
				: kind === "all candidates"
					? ["a.spec.ts", "other.spec.ts"]
					: [],
		);
		if (kind === "query error") vitest.getRelevantTestSpecifications.mockRejectedValue(new Error("query failed"));
		if (kind === "unreadable") vitest.getRelevantTestSpecifications.mockResolvedValue(undefined as never);
		if (kind === "close error") vitest.close.mockRejectedValue(new Error("close failed"));
		const selection = await MutationVitest.open(async () => {
			if (kind === "startup error") throw new Error("startup failed");
			return vitest;
		}, ["src/a.ts"]);
		const run = vi.fn(async () => ({ code: 0, report: '{"files":{}}' }));
		await selection.execute(run);
		expect(run.mock.calls).toEqual([[undefined]]);
		expect(selection.notes[0]).toContain("whole suite");
		if (kind !== "startup error") expect(vitest.close).toHaveBeenCalledOnce();
	},
);

it.each(["NoCoverage", "exit error", "thrown error", "missing report", "corrupt report", "wrong shape"])(
	"repeats a related run with the whole suite after %s",
	async (kind) => {
		const selection = await MutationVitest.open(
			async () => listing((files) => (files ? ["a.spec.ts"] : ["a.spec.ts", "other.spec.ts"])),
			["src/a.ts"],
		);
		const run = vi.fn(async (tests?: readonly string[], fresh?: true) => {
			if (fresh) {
				expect(tests).toBeUndefined();
				return { code: 0, report: '{"files":{}}' };
			}
			if (kind === "thrown error") throw new Error("related attempt threw");
			return {
				code: kind === "exit error" ? 1 : 0,
				report:
					kind === "missing report"
						? undefined
						: kind === "corrupt report"
							? "{broken"
							: kind === "wrong shape"
								? "{}"
								: kind === "exit error"
									? '{"files":{"a":{"mutants":[{"status":"Killed"}]}}}'
									: '{"files":{"a":{"mutants":[{"status":"NoCoverage"}]}}}',
			};
		});
		await expect(selection.execute(run)).resolves.toEqual({ code: 0, report: '{"files":{}}' });
		expect(run.mock.calls).toEqual([[["a.spec.ts"]], [undefined, true]]);
		expect(selection.notes[1]).toContain("whole suite");
	},
);

it("accepts Stryker's whole-suite NoCoverage and related kills without a repeat", async () => {
	const uncovered = '{"files":{"a":{"mutants":[{"status":"NoCoverage"}]}}}';
	const whole = MutationVitest.whole("no related test");
	const all = vi.fn(async () => ({ code: 0, report: uncovered }));
	await expect(whole.execute(all)).resolves.toEqual({ code: 0, report: uncovered });
	expect(all).toHaveBeenCalledOnce();
	const selected = await MutationVitest.open(
		async () => listing((files) => (files ? ["a.spec.ts"] : ["a.spec.ts", "other.spec.ts"])),
		["src/a.ts"],
	);
	const killed = '{"files":{"a":{"mutants":[{"status":"Killed"}]}}}';
	const related = vi.fn(async () => ({ code: 0, report: killed }));
	await expect(selected.execute(related)).resolves.toEqual({ code: 0, report: killed });
	expect(related).toHaveBeenCalledOnce();
});

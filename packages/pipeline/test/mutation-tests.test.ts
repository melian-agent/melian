import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CallGroundTruth, defaultConfig } from "@melian-agent/core";
import { backgroundContext, createNodeExecutionEnv } from "@melian-agent/pipeline";
import { afterEach, expect, it, vi } from "vitest";
import { MutationTests } from "../src/mutation-tests.ts";
import { Run } from "../src/static.ts";

function program(graph: Record<string, string[]>, setup: string[] = []) {
	return {
		read: vi.fn((options: { importsOnly: boolean; maxFiles: number; deadline: number }) => {
			expect(options.importsOnly).toBe(true);
			return {
				files: Object.entries(graph).map(([path, imports]) => ({
					path,
					imports: imports.map((target) => ({
						target,
						line: 1,
						specifier: target,
						kind: "import" as const,
						typeOnly: false,
					})),
					pairs: [],
					external: 0,
					unresolved: 0,
				})),
			} satisfies Pick<CallGroundTruth, "files">;
		}),
		setupFiles: () => setup,
	};
}
const graph = {
	"src/a.ts": [],
	"src/middle.ts": ["src/a.ts"],
	"test/a.test.ts": ["src/a.ts"],
	"test/transitive.test.mjs": ["src/middle.ts"],
	"test/b.test.ts": [],
	"test/c.test.ts": [],
	"test/d.test.mjs": [],
};

it("selects exactly two of five tests through direct and transitive imports, leaving setup to Vitest", () => {
	const selection = MutationTests.select(program(graph, ["test/setup.ts"]), ["src/a.ts"]).toJSON();
	expect(selection).toMatchObject({
		tests: ["test/a.test.ts", "test/transitive.test.mjs"],
		include: ["test/a.test.ts", "test/transitive.test.mjs"],
	});
});

it("runs no tests when no test import closure reaches a changed file, even with setup", () => {
	const selection = MutationTests.select(program(graph, ["test/setup.ts"]), ["test/c.test.ts"]).toJSON();
	// A changed production source with no importer, rather than a test itself.
	const empty = MutationTests.select(program({ ...graph, "src/unreached.ts": [] }, ["test/setup.ts"]), [
		"src/unreached.ts",
	]).toJSON();
	expect(selection).toMatchObject({ tests: ["test/c.test.ts"] });
	expect(empty).toMatchObject({ tests: [], include: [] });
});

it("runs a related test through the Stryker Vitest configuration without collecting its setup module", {
	timeout: 60_000,
}, () => {
	const root = mkdtempSync(join(tmpdir(), "melian-mutation-setup-"));
	const checkout = fileURLToPath(new URL("../../../", import.meta.url));
	try {
		mkdirSync(join(root, "test"));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "scripts"));
		symlinkSync(join(checkout, "node_modules"), join(root, "node_modules"), "dir");
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		writeFileSync(join(root, "src/a.ts"), "export const a = 1;");
		writeFileSync(join(root, "test/setup.ts"), "globalThis.setupRan = true;");
		writeFileSync(
			join(root, "test/a.test.ts"),
			'import { expect, it } from "vitest"; import { a } from "../src/a.ts"; it("loads setup", () => { expect(a).toBe(1); expect(globalThis.setupRan).toBe(true); });',
		);
		writeFileSync(
			join(root, "vitest.config.ts"),
			'import { defineConfig } from "vitest/config"; export default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"] } });',
		);
		for (const path of ["vitest.stryker.config.ts", "scripts/stryker-test-names.mjs"])
			writeFileSync(join(root, path), readFileSync(join(checkout, path)));
		const selection = MutationTests.select(
			program({ "src/a.ts": [], "test/a.test.ts": ["src/a.ts"] }, ["test/setup.ts"]),
			["src/a.ts"],
		).toJSON();
		writeFileSync(join(root, "include.json"), JSON.stringify("include" in selection ? selection.include : []));
		const output = execFileSync(
			process.execPath,
			[
				join(checkout, "node_modules/vitest/vitest.mjs"),
				"--run",
				"--config",
				"vitest.stryker.config.ts",
				"--maxWorkers",
				"1",
			],
			{
				cwd: root,
				encoding: "utf8",
				stdio: "pipe",
				timeout: 30_000,
				env: { PATH: process.env.PATH, TMPDIR: root, MELIAN_MUTATION_TEST_INCLUDE: join(root, "include.json") },
			},
		);
		expect(output).toContain("1 passed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps the whole suite when a changed source is absent from the compiler", () => {
	expect(MutationTests.select(program(graph), ["src/missing.ts"]).toJSON()).toEqual({
		note: expect.stringContaining("whole suite"),
	});
});

it("handles import cycles without losing a transitive test", () => {
	const cyclic = { ...graph, "src/a.ts": ["src/middle.ts"] };
	expect(
		MutationTests.select(program(cyclic), ["src/a.ts"], { files: 100, milliseconds: 100 }).toJSON(),
	).toMatchObject({ tests: ["test/a.test.ts", "test/transitive.test.mjs"] });
});

it("selects at the file bound and falls back to all one past it", () => {
	expect(MutationTests.select(program(graph), ["src/a.ts"], { files: 7, milliseconds: 1000 }).toJSON()).toHaveProperty(
		"tests",
	);
	expect(MutationTests.select(program(graph), ["src/a.ts"], { files: 6, milliseconds: 1000 }).toJSON()).toEqual({
		note: expect.stringContaining("whole suite"),
	});
});

it("selects before the time bound and falls back at it", () => {
	for (const elapsed of [999, 1000]) {
		let clock = 0;
		const now = () => clock;
		const fake = program(graph);
		fake.setupFiles = () => {
			clock = elapsed;
			return [];
		};
		const selection = MutationTests.select(fake, ["src/a.ts"], { files: 7, milliseconds: 1000 }, now).toJSON();
		expect("tests" in selection).toBe(elapsed === 999);
	}
});

it("keeps the whole suite when the compiler or setup reader fails", () => {
	const fake = program(graph);
	fake.read.mockImplementation(() => {
		throw new Error("compiler unavailable");
	});
	expect(MutationTests.select(fake, ["src/a.ts"]).toJSON()).toEqual({
		note: expect.stringContaining("compiler unavailable"),
	});
	const computed = {
		...program(graph),
		setupFiles: () => {
			throw new Error("computed setup");
		},
	};
	expect(MutationTests.select(computed, ["src/a.ts"]).toJSON()).toEqual({
		note: expect.stringContaining("computed setup"),
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

it("bounds the compiler child and accepts only its requested selection", async () => {
	const run = new Run(
		{
			env: createNodeExecutionEnv("/"),
			repoRoot: "/",
			commit: "a".repeat(40),
			tool: "mutation",
			settings: defaultConfig.static.mutation,
		},
		backgroundContext,
	);
	vi.spyOn(run, "exists").mockResolvedValue(true);
	const shell = vi.spyOn(run, "shell").mockResolvedValue({ code: 0, output: "" });
	const output = vi.spyOn(run, "readOutput").mockImplementation(async (path) => {
		expect(path).toBe("/scratch/related-tests.json");
		return JSON.stringify({ tests: ["a.test.ts"], include: ["a.test.ts"], note: "selected" });
	});
	expect((await MutationTests.open(run, "/head", "/scratch", ["a.ts"])).toJSON()).toMatchObject({
		tests: ["a.test.ts"],
	});
	expect(shell).toHaveBeenCalledWith(
		expect.stringContaining("--conditions=@melian-agent/source --max-old-space-size=512"),
		30,
	);
	expect(shell.mock.calls[0]![0]).toContain("/head");
	expect(shell.mock.calls[0]![0]).toContain('["a.ts"]');
	expect(output).toHaveBeenCalledOnce();
});

it.each(["exit", "missing", "corrupt", "timeout"])("keeps the whole suite after compiler child %s", async (failure) => {
	const run = new Run(
		{
			env: createNodeExecutionEnv("/"),
			repoRoot: "/",
			commit: "a".repeat(40),
			tool: "mutation",
			settings: defaultConfig.static.mutation,
		},
		backgroundContext,
	);
	vi.spyOn(run, "exists").mockResolvedValue(true);
	const shell = vi.spyOn(run, "shell").mockResolvedValue({ code: failure === "exit" ? 1 : 0, output: "" });
	if (failure === "timeout") shell.mockRejectedValue(new Error("child timed out"));
	vi.spyOn(run, "readOutput").mockResolvedValue(
		failure === "missing"
			? undefined
			: failure === "corrupt"
				? "bad JSON"
				: JSON.stringify({ tests: [], include: [], note: "selected" }),
	);
	expect((await MutationTests.open(run, "/head", "/scratch", ["a.ts"])).toJSON()).toEqual({
		note: expect.stringContaining(
			failure === "exit"
				? "compiler exited 1"
				: failure === "missing"
					? "compiler wrote no selection"
					: "whole suite",
		),
	});
});

it("stops walking when its time ends, before asking for setup paths", () => {
	let clock = 0;
	const fake = program(graph);
	const read = fake.read.getMockImplementation()!;
	fake.read.mockImplementation((options) => {
		const result = read(options);
		clock = 1000;
		return result;
	});
	const setup = vi.fn(() => []);
	fake.setupFiles = setup;
	expect(MutationTests.select(fake, ["src/a.ts"], { files: 7, milliseconds: 1000 }, () => clock).toJSON()).toEqual({
		note: expect.stringContaining("whole suite"),
	});
	expect(setup).not.toHaveBeenCalled();
});

it("uses the whole suite without starting a compiler when the root project is absent", async () => {
	const run = new Run(
		{
			env: createNodeExecutionEnv("/"),
			repoRoot: "/",
			commit: "a".repeat(40),
			tool: "mutation",
			settings: defaultConfig.static.mutation,
		},
		backgroundContext,
	);
	vi.spyOn(run, "exists").mockResolvedValue(false);
	const shell = vi.spyOn(run, "shell");
	expect((await MutationTests.open(run, "/head", "/scratch", ["a.ts"])).toJSON()).toEqual({
		note: expect.stringContaining("no root tsconfig.json"),
	});
	expect(shell).not.toHaveBeenCalled();
});

it.each([0, 1, 2, 3])(
	"rejects missing compiler-child argument %s before writing a project",
	{ timeout: 60_000 },
	(missing) => {
		const root = mkdtempSync(join(tmpdir(), "melian-mutation-child-"));
		const output = join(root, "selection.json");
		const project = join(root, "project.json");
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["**/*.ts"] }));
		const args = [root, output, project, JSON.stringify(["src/a.ts"])];
		args[missing] = "";
		let stderr = "";
		try {
			try {
				execFileSync(
					process.execPath,
					[
						"--conditions=@melian-agent/source",
						"--max-old-space-size=512",
						fileURLToPath(new URL("../src/mutation-tests.ts", import.meta.url)),
						...args,
					],
					{ cwd: root, encoding: "utf8", stdio: "pipe", timeout: 30_000 },
				);
			} catch (error) {
				stderr = String((error as { stderr: unknown }).stderr);
			}
			expect(stderr).toContain("Error: Expected root, output, project and changed paths");
			expect(existsSync(project)).toBe(false);
			expect(existsSync(output)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it("rejects a compiler-child root without a project before writing scratch output", { timeout: 60_000 }, () => {
	const root = mkdtempSync(join(tmpdir(), "melian-mutation-child-"));
	const output = join(root, "selection.json");
	const project = join(root, "project.json");
	let stderr = "";
	try {
		try {
			execFileSync(
				process.execPath,
				[
					"--conditions=@melian-agent/source",
					fileURLToPath(new URL("../src/mutation-tests.ts", import.meta.url)),
					root,
					output,
					project,
					JSON.stringify(["src/a.ts"]),
				],
				{ cwd: root, encoding: "utf8", stdio: "pipe", timeout: 30_000 },
			);
		} catch (error) {
			stderr = String((error as { stderr: unknown }).stderr);
		}
		expect(stderr).toContain("Error: No root tsconfig.json");
		expect(existsSync(project)).toBe(false);
		expect(existsSync(output)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

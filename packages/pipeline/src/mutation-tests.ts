import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallGroundTruth } from "@melian-agent/core";
import { CompilerGraph } from "./compiler-graph.ts";
import type { Run } from "./static.ts";

/** A restricted dry run, or the whole suite when the compiler cannot safely select it. */
export type MutationTestSelection = { include: string[]; tests: string[]; note: string } | { note: string };

interface ImportProgram {
	read(options: { importsOnly: boolean; maxFiles: number; deadline: number }): Pick<CallGroundTruth, "files">;
	setupFiles(): string[];
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export class MutationTests {
	readonly #selection: MutationTestSelection;
	private constructor(selection: MutationTestSelection) {
		this.#selection = selection;
	}
	toJSON(): MutationTestSelection {
		return structuredClone(this.#selection);
	}
	static select(
		program: ImportProgram,
		changed: readonly string[],
		limits = { files: 10_000, milliseconds: 30_000 },
		now = Date.now,
	): MutationTests {
		const deadline = now() + limits.milliseconds;
		try {
			const { files } = program.read({ importsOnly: true, maxFiles: limits.files, deadline });
			if (files.length > limits.files) throw new Error("Import graph reached its file bound");
			const reverse = new Map<string, Set<string>>();
			for (const file of files) {
				for (const edge of file.imports) {
					const importers = reverse.get(edge.target) ?? new Set<string>();
					importers.add(file.path);
					reverse.set(edge.target, importers);
				}
			}
			const known = new Set(files.map((file) => file.path));
			if (changed.some((path) => !known.has(path)))
				throw new Error("Changed source is absent from the compiler program");
			const visited = new Set(changed);
			const queue = [...changed];
			for (let index = 0; index < queue.length; index++) {
				if (now() >= deadline) throw new Error("Reverse imports reached their time bound");
				for (const path of reverse.get(queue[index]!) ?? []) {
					if (visited.has(path)) continue;
					visited.add(path);
					queue.push(path);
				}
			}
			const tests = [...visited].filter((path) => /\.test\.(ts|mjs)$/.test(path)).sort();
			program.setupFiles();
			if (now() >= deadline) throw new Error("Setup selection reached its time bound");
			return new MutationTests({
				tests,
				include: tests,
				note: `Mutation dry run selected ${tests.length} related test file(s); Vitest loads setup through test.setupFiles.`,
			});
		} catch (error) {
			return new MutationTests({
				note: `Mutation dry run uses the whole suite: ${error instanceof Error ? error.message : String(error)}.`,
			});
		}
	}

	static async open(run: Run, root: string, scratch: string, changed: readonly string[]): Promise<MutationTests> {
		if (!(await run.exists(posix.join(root, "tsconfig.json"))))
			return new MutationTests({ note: "Mutation dry run uses the whole suite: no root tsconfig.json." });
		const output = posix.join(scratch, "related-tests.json");
		const project = posix.join(scratch, "related.tsconfig.json");
		const helper = fileURLToPath(import.meta.url);
		try {
			const result = await run.shell(
				`${quote(process.execPath)} --conditions=@melian-agent/source --max-old-space-size=512 ${quote(helper)} ${quote(root)} ${quote(output)} ${quote(project)} ${quote(JSON.stringify(changed))}`,
				30,
			);
			if (result.code !== 0) throw new Error(`compiler exited ${result.code}`);
			const text = await run.readOutput(output);
			if (text === undefined) throw new Error("compiler wrote no selection");
			return new MutationTests(JSON.parse(text) as MutationTestSelection);
		} catch (error) {
			return new MutationTests({
				note: `Mutation dry run uses the whole suite: ${error instanceof Error ? error.message : String(error)}.`,
			});
		}
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [root, output, project, targets] = process.argv.slice(2);
	if (!root || !output || !project || !targets) throw new Error("Expected root, output, project and changed paths");
	if (!existsSync(posix.join(root, "tsconfig.json"))) throw new Error("No root tsconfig.json");
	writeFileSync(
		project,
		JSON.stringify({
			extends: posix.join(root, "tsconfig.json"),
			compilerOptions: { allowJs: true, noEmit: true, customConditions: ["@melian-agent/source"] },
			include: [
				posix.join(root, "**/*.ts"),
				posix.join(root, "**/*.tsx"),
				posix.join(root, "**/*.mts"),
				posix.join(root, "**/*.cts"),
				posix.join(root, "**/*.mjs"),
				posix.join(root, "**/*.js"),
			],
			exclude: [posix.join(root, "**/node_modules/**"), posix.join(root, "**/dist/**")],
		}),
	);
	const program = CompilerGraph.open(root, project);
	try {
		const config = JSON.parse(readFileSync(posix.join(root, "stryker.config.json"), "utf8")) as {
			vitest?: { configFile?: string };
		};
		writeFileSync(
			output,
			JSON.stringify(
				MutationTests.select(
					{
						read: (options) => program.read(options),
						setupFiles: () => program.setupFiles(config.vitest?.configFile),
					},
					JSON.parse(targets) as string[],
				),
			),
		);
	} finally {
		program.close();
	}
}

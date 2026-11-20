import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = dirname(import.meta.dirname);
const biome = join(root, "node_modules/@biomejs/biome/bin/biome");
const { plugins } = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
const plugin = plugins.find((each) => each.path.endsWith("object-by-path.grit"));

let dir;

// Each file the plugin excludes, with the function and argument of each read it reports there once the exclusion is lifted.
const grandfathered = {
	"packages/core/src/guardrails.ts": [{ function: "blobText", argument: "const object = `#{commit}:#{path}`;" }],
};

// The line of each excused read: its argument's line within its function, which ends at the next closing brace in the
// first column.
function excusedLines(source, reads) {
	const lines = source.split("\n");
	return reads.flatMap((read) => {
		const start = lines.findIndex((line) => new RegExp(`function ${read.function}\\(`).test(line));
		const end = lines.findIndex((line, index) => index > start && line === "}");
		const argument = read.argument.replaceAll("#{", "${");
		const found = lines.flatMap((line, index) =>
			start >= 0 && index > start && index < end && line.trim() === argument ? [index + 1] : [],
		);
		expect(found, `${read.function}: ${argument}`).toHaveLength(1);
		return found;
	});
}

function excluded() {
	return plugin.includes.filter((glob) => glob.startsWith("!")).map((glob) => glob.replace(/^!\*\*\//, ""));
}

function lint(path, source, includes = plugin.includes) {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), source);
	const config = { plugins: [{ path: join(root, plugin.path), includes }], linter: { rules: { preset: "none" } } };
	writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
	const result = spawnSync(process.execPath, [biome, "lint", "--reporter=github", path], {
		cwd: dir,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return [...result.stdout.matchAll(/^::error title=plugin,file=[^,]+,line=(\d+)/gm)].map((match) => Number(match[1]));
}

const file = "packages/core/src/scratch.ts";
const declare = "declare function git(cwd: string, args: string[]): Promise<string>;\n";
const dollar = "$";

// Each case writes a template placeholder as `#{`, so its source is no template inside a string.
function scratch(source) {
	return `${declare}${source.replaceAll("'", '"').replaceAll("#{", `${dollar}{`)}`;
}

describe("the object-by-path Biome plugin", { timeout: 30_000 }, () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "melian-object-by-path-"));
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it.each([
		[
			"a template naming a revision and a path",
			"function f(c: string, p: string) {\n\treturn git('.', ['show', `#{c}:#{p}`]);\n}\n",
		],
		[
			"a template held in a variable",
			"function f(c: string, p: string) {\n\tconst o = `#{c}:#{p}`;\n\treturn git('.', ['cat-file', 'blob', o]);\n}\n",
		],
		["a literal revision and path", "function f() {\n\treturn git('.', ['show', 'HEAD:melian.yaml']);\n}\n"],
		["a path in the index", "function f(p: string) {\n\treturn git('.', ['show', `:#{p}`]);\n}\n"],
		[
			"a bare colon joined to a path",
			"function f(c: string, p: string) {\n\treturn git('.', ['cat-file', 'blob', [c, p].join(':')]);\n}\n",
		],
		["an arrow function's body", "const f = (c: string) =>\n\tgit('.', ['show', `#{c}:melian.yaml`]);\n"],
	])("reports %s read through git", (_, source) => {
		expect(lint(file, scratch(source))).toHaveLength(1);
	});

	it.each([
		[
			"a refspec",
			"function f(r: string, h: string) {\n\tgit('.', ['cat-file', '-e', h]);\n\treturn git('.', ['fetch', 'origin', `+#{r}:#{h}`]);\n}\n",
		],
		["a URL", "function f(o: string) {\n\tgit('.', ['show', 'HEAD']);\n\treturn `https://github.com/#{o}`;\n}\n"],
		["a format option", "function f(h: string) {\n\treturn git('.', ['show', '-s', '--format=%H:%T', h]);\n}\n"],
		[
			"a message with spaces",
			"function f(c: string, p: string) {\n\tgit('.', ['show', c]);\n\treturn `#{c}:#{p} is missing`;\n}\n",
		],
		[
			"a label in a function that runs no show or cat-file",
			"function f(c: string, p: string) {\n\treturn `#{c}:#{p}`;\n}\n",
		],
		["a peeled commit", "function f(h: string) {\n\treturn git('.', ['cat-file', '-e', `#{h}^{commit}`]);\n}\n"],
	])("does not report %s", (_, source) => {
		expect(lint(file, scratch(source))).toEqual([]);
	});

	it("leaves each grandfathered file alone, and checks every other source file", () => {
		const source = `${declare}function f(c: string, p: string) {\n\treturn git(".", ["show", \`\${c}:\${p}\`]);\n}\n`;
		for (const path of excluded()) expect(lint(path, source), path).toEqual([]);
		expect(lint("packages/core/src/source.ts", source)).toEqual([3]);
	});

	it("checks the source of every package", () => {
		const source = `${declare}function f(c: string, p: string) {\n\treturn git(".", ["show", \`\${c}:\${p}\`]);\n}\n`;
		const packages = readdirSync(join(root, "packages")).filter((name) =>
			existsSync(join(root, "packages", name, "src")),
		);
		expect(packages.length).toBeGreaterThan(1);
		for (const name of packages) expect(lint(`packages/${name}/src/scratch.ts`, source), name).toEqual([3]);
	});

	it("finds in each grandfathered file exactly the reads it was excused for, so the file gains none and the list only shrinks", () => {
		expect(excluded().sort()).toEqual(Object.keys(grandfathered).sort());
		for (const path of excluded()) {
			const source = readFileSync(join(root, path), "utf8");
			const lines = lint(path, source, ["**/packages/*/src/**"]);
			expect(lines, path).toEqual(excusedLines(source, grandfathered[path]));
		}
	});
});

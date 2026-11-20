import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = dirname(import.meta.dirname);
const biome = join(root, "node_modules/@biomejs/biome/bin/biome");
const { plugins } = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
const plugin = plugins.find((each) => each.path.endsWith("object-by-path.grit"));

let dir;

function excluded() {
	return plugin.includes.filter((glob) => glob.startsWith("!")).map((glob) => glob.replace(/^!\*\*\//, ""));
}

// Lints `source` at `path` in a scratch repository whose biome.json wires the plugin as the root's does, and returns the
// line of each diagnostic.
function lint(path, source, includes = plugin.includes) {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), source);
	const config = { plugins: [{ path: join(root, plugin.path), includes }], linter: { rules: { preset: "none" } } };
	writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
	const result = spawnSync(process.execPath, [biome, "lint", "--reporter=github", path], { cwd: dir, encoding: "utf8" });
	if (result.error) throw result.error;
	return [...result.stdout.matchAll(/^::error title=plugin,file=[^,]+,line=(\d+)/gm)].map((match) => Number(match[1]));
}

const file = "packages/core/src/scratch.ts";
const declare = "declare function git(cwd: string, args: string[]): Promise<string>;\n";

describe("the object-by-path Biome plugin", { timeout: 30_000 }, () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "melian-object-by-path-"));
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it.each([
		["a template naming a revision and a path", "function f(c: string, p: string) {\n\treturn git('.', ['show', `${c}:${p}`]);\n}\n"],
		["a template held in a variable", "function f(c: string, p: string) {\n\tconst o = `${c}:${p}`;\n\treturn git('.', ['cat-file', 'blob', o]);\n}\n"],
		["a literal revision and path", "function f() {\n\treturn git('.', ['show', 'HEAD:melian.yaml']);\n}\n"],
		["a path in the index", "function f(p: string) {\n\treturn git('.', ['show', `:${p}`]);\n}\n"],
		["a bare colon joined to a path", "function f(c: string, p: string) {\n\treturn git('.', ['cat-file', 'blob', [c, p].join(':')]);\n}\n"],
		["an arrow function's body", "const f = (c: string) =>\n\tgit('.', ['show', `${c}:melian.yaml`]);\n"],
	])("reports %s read through git", (_, source) => {
		expect(lint(file, `${declare}${source.replaceAll("'", '"')}`)).toHaveLength(1);
	});

	it.each([
		["a refspec", "function f(r: string, h: string) {\n\tgit('.', ['cat-file', '-e', h]);\n\treturn git('.', ['fetch', 'origin', `+${r}:${h}`]);\n}\n"],
		["a URL", "function f(o: string) {\n\tgit('.', ['show', 'HEAD']);\n\treturn `https://github.com/${o}`;\n}\n"],
		["a format option", "function f(h: string) {\n\treturn git('.', ['show', '-s', '--format=%H:%T', h]);\n}\n"],
		["a message with spaces", "function f(c: string, p: string) {\n\tgit('.', ['show', c]);\n\treturn `${c}:${p} is missing`;\n}\n"],
		["a label in a function that runs no show or cat-file", "function f(c: string, p: string) {\n\treturn `${c}:${p}`;\n}\n"],
		["a peeled commit", "function f(h: string) {\n\treturn git('.', ['cat-file', '-e', `${h}^{commit}`]);\n}\n"],
	])("does not report %s", (_, source) => {
		expect(lint(file, `${declare}${source.replaceAll("'", '"')}`)).toEqual([]);
	});

	it("leaves each grandfathered file alone, and checks every other source file", () => {
		const source = `${declare}function f(c: string, p: string) {\n\treturn git(".", ["show", \`\${c}:\${p}\`]);\n}\n`;
		for (const path of excluded()) expect(lint(path, source), path).toEqual([]);
		expect(lint("packages/core/src/source.ts", source)).toEqual([3]);
	});

	it("reports each grandfathered file once its exclusion is lifted, so the list holds no file that has stopped offending", () => {
		for (const path of excluded()) {
			const lines = lint(path, readFileSync(join(root, path), "utf8"), ["**/packages/*/src/**"]);
			expect(lines.length, path).toBeGreaterThan(0);
		}
	});
});

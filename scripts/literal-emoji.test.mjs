import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = dirname(import.meta.dirname);
const biome = join(root, "node_modules/@biomejs/biome/bin/biome");
const { plugins } = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
const plugin = plugins.find((each) => each.path.endsWith("literal-emoji.grit"));
// Built from code points, since this file is linted by the plugin it tests.
const red = String.fromCodePoint(0x1f534);
const warning = `${String.fromCodePoint(0x26a0)}\u{fe0f}`;

let dir;

// Lints `source` as one file at `path` with the plugin as biome.json wires it, and returns the line of each diagnostic.
function lint(path, source) {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), source);
	const result = spawnSync(process.execPath, [biome, "lint", "--reporter=github", path], {
		cwd: dir,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return [...result.stdout.matchAll(/^::error title=plugin,file=[^,]+,line=(\d+)/gm)].map((match) => Number(match[1]));
}

describe("the literal-emoji Biome plugin", { timeout: 30_000 }, () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "melian-literal-emoji-"));
		const config = { plugins: [{ ...plugin, path: join(root, plugin.path) }], linter: { rules: { preset: "none" } } };
		writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reports an emoji in a string, a template, a regex, a member name and a type", () => {
		const source = [
			`export const a = "${red} P0";`,
			`export const b = \`\${a} ${warning}\`;`,
			`export const c = /${red}/u;`,
			`export const d = { "${red}": 1 };`,
			`export type E = "${red}";`,
			"",
		];
		expect(lint("packages/core/src/scratch.ts", source.join("\n"))).toEqual([1, 2, 3, 4, 5]);
	});

	it("reports an emoji in a script and a test as well as in source", () => {
		expect(lint("scripts/scratch.mjs", `export const a = "${red}";\n`)).toEqual([1]);
		expect(lint("packages/cli/test/scratch.test.ts", `export const a = "${red}";\n`)).toEqual([1]);
	});

	it("passes an escape, and a text symbol that is not an emoji", () => {
		const source = 'export const a = "\\u{1F534} \\u{26A0}\\u{FE0F}";\nexport const b = "© ™ ⚠";\n';
		expect(lint("packages/core/src/scratch.ts", source)).toEqual([]);
	});

	it.each([
		"packages/cli/bin/scratch.js",
		"scratch.config.ts",
		"packages/core/src/scratch.tsx",
		"packages/core/test/scratch.mjs",
	])("reaches %s under the repository's own biome.json", (path) => {
		const file = join(root, path);
		writeFileSync(file, `export const a = "${red}";\n`);
		try {
			const result = spawnSync(process.execPath, [biome, "lint", "--reporter=github", path], {
				cwd: root,
				encoding: "utf8",
			});
			if (result.error) throw result.error;
			expect(result.stdout).toMatch(/^::error title=plugin,file=[^,]+,line=1/m);
		} finally {
			rmSync(file, { force: true });
		}
	});
});

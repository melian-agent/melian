import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = dirname(import.meta.dirname);
const biome = join(root, "node_modules/@biomejs/biome/bin/biome");
const { plugins } = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
const plugin = plugins.find((each) => each.path.endsWith("free-domain-function.grit"));

let dir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "melian-free-domain-function-"));
	const config = { plugins: [{ ...plugin, path: join(root, plugin.path) }], linter: { rules: { preset: "none" } } };
	writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Lints one file at `path` under the scratch repository with the plugin as biome.json wires it, and returns the line of each diagnostic.
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

describe("the free-domain-function Biome plugin", { timeout: 30_000 }, () => {
	it("reports a free function whose wrapped first parameter is a Finding", () => {
		const source = ["export function triageFinding(", "\tfinding: Finding,", "\treason: string,", "): void {}", ""];
		expect(lint("packages/core/src/scratch.ts", source.join("\n"))).toEqual([1]);
	});

	it("does not report a class method that takes a Finding", () => {
		const source = "export class Triage {\n\taccept(finding: Finding): void {}\n}\n";
		expect(lint("packages/core/src/scratch.ts", source)).toEqual([]);
	});

	it("does not report a function whose first parameter is a string", () => {
		const source = "export function short(revision: string, finding: Finding): void {}\n";
		expect(lint("packages/core/src/scratch.ts", source)).toEqual([]);
	});

	it("leaves a grandfathered file alone", () => {
		const source = "export function triageFinding(finding: Finding): void {}\n";
		expect(lint("packages/core/src/adjudication.ts", source)).toEqual([]);
	});
});

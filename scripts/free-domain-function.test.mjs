import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = dirname(import.meta.dirname);
const biome = join(root, "node_modules/@biomejs/biome/bin/biome");
const { plugins } = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
const plugin = plugins.find((each) => each.path.endsWith("free-domain-function.grit"));

let dir;

// The source files the plugin's includes leave out, as repository-relative paths.
function excluded() {
	return plugin.includes.filter((glob) => glob.startsWith("!")).map((glob) => glob.replace(/^!\*\*\//, ""));
}

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
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "melian-free-domain-function-"));
		const config = { plugins: [{ ...plugin, path: join(root, plugin.path) }], linter: { rules: { preset: "none" } } };
		writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reports a free function whose wrapped first parameter is a Finding", () => {
		const source = ["export function triageFinding(", "\tfinding: Finding,", "\treason: string,", "): void {}", ""];
		expect(lint("packages/core/src/scratch.ts", source.join("\n"))).toEqual([1]);
	});

	it("reports a free function over a readonly array of Verdicts", () => {
		expect(lint("packages/core/src/scratch.ts", "function tally(verdicts: readonly Verdict[]): void {}\n")).toEqual([
			1,
		]);
	});

	it("reports an anonymous default-exported function over a Lens", () => {
		expect(lint("packages/core/src/scratch.ts", "export default function (lens: Lens): void {}\n")).toEqual([1]);
	});

	it("does not report a class method that takes a Finding", () => {
		const source = "export class Triage {\n\taccept(finding: Finding): void {}\n}\n";
		expect(lint("packages/core/src/scratch.ts", source)).toEqual([]);
	});

	it("does not report a function whose first parameter is a string", () => {
		const source = "export function short(revision: string, finding: Finding): void {}\n";
		expect(lint("packages/core/src/scratch.ts", source)).toEqual([]);
	});

	it("leaves each grandfathered file alone, and checks every other source file", () => {
		const source = "export function triageFinding(finding: Finding): void {}\n";
		for (const path of excluded()) expect(lint(path, source), path).toEqual([]);
		expect(lint("packages/core/src/adjudication.ts", source)).toEqual([1]);
	});
});

// The guardrail's pattern, read from the root melian.yaml so the test cannot drift from it.
function guardrailPattern() {
	const yaml = readFileSync(join(root, "melian.yaml"), "utf8");
	const match = /^ {6}free-domain-function:\n {8}pattern: '((?:[^']|'')*)'$/m.exec(yaml);
	if (match === null) throw new Error("melian.yaml has no free-domain-function pattern");
	return new RegExp(match[1].replaceAll("''", "'"), "m");
}

describe("the free-domain-function exclusion list", () => {
	it("names exactly the source files the guardrail's pattern matches", () => {
		const pattern = guardrailPattern();
		const offenders = readdirSync(join(root, "packages"))
			.flatMap((name) => {
				const src = join("packages", name, "src");
				const files = readdirSync(join(root, src), { recursive: true }).filter((file) => file.endsWith(".ts"));
				return files.map((file) => join(src, file));
			})
			.filter((file) => pattern.test(readFileSync(join(root, file), "utf8")));
		expect(excluded().sort()).toEqual(offenders.sort());
	});
});

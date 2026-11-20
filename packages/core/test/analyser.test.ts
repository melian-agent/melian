import { describe, expect, it } from "vitest";
import { analyserOf, switchOffs as found } from "../src/analyser.ts";
import { CheckError } from "../src/errors.ts";
import { analyserConfigNames, isAnalyserConfig, isPolicyFile } from "../src/paths.ts";
import { maxProgram } from "../src/pattern.ts";

const switchOffs = (...args: Parameters<typeof found>) => found(...args).map(({ sentence }) => sentence);

it.each([
	["web/BIOME.JSONC", "Biome"],
	["web/TsConfig.app.Json", "tsc"],
	["web/Package.Json", "the packages Biome and tsc load"],
	["web/Package-Lock.Json", "the packages Biome and tsc load"],
	["web/.ESLINTRC.json", "ESLint"],
	["web/ESLint.Config.js", "ESLint"],
	["web/Stryker.Config.json", "Stryker"],
	["web/Vitest.Config.ts", "the Vitest run Stryker drives"],
	["ENOLA.YAML", "Enola"],
	["MCP-ARCH.YAML", "Enola"],
	["ENOLA-INTENT.YAML", "Enola"],
	["Enola/Constraints/layers.yaml", "Enola"],
	[".Enola/Suppressions.Yaml", "Enola"],
	["Enola/Constraints/Lay\nx.yaml", "Enola"],
	["Enola/Recipes/Lay\nered.yaml", "Enola"],
])("recognises the analyser policy path %s in any case", (path, analyser) => {
	expect(isAnalyserConfig(path)).toBe(true);
	expect(isPolicyFile(path)).toBe(true);
	expect(analyserOf(path)).toBe(analyser);
});

it("recognises mixed-case .melian contents without claiming lookalike directories or Enola baselines", () => {
	expect(isPolicyFile("web/.Melian/standards/usage.md")).toBe(true);
	for (const path of [
		"web/Melian/standards/usage.md",
		"web/.Melian-other/notes.md",
		".Enola/Baseline",
		"web/ENOLA.YAML",
	]) {
		expect(isPolicyFile(path), path).toBe(false);
		expect(isAnalyserConfig(path), path).toBe(false);
		expect(analyserOf(path), path).toBeUndefined();
	}
});

it("names every path Enola reads policy from among the analyser configuration names", () => {
	expect(analyserConfigNames.filter((name) => analyserOf(name.replace("**", "a.yaml")) === "Enola")).toEqual([
		"enola.yaml",
		"mcp-arch.yaml",
		"enola-intent.yaml",
		".enola/suppressions.yaml",
		"enola/constraints/**",
		"enola/recipes/**",
	]);
});

it("names Enola policy inputs without claiming other analyser files", () => {
	for (const path of ["enola.yaml", "mcp-arch.yaml", "enola/constraints/layers.yaml", ".enola/suppressions.yaml"])
		expect(analyserOf(path)).toBe("Enola");
	expect(analyserOf("biome.json")).toBe("Biome");
	expect(analyserOf("stryker.config.json")).toBe("Stryker");
	expect(analyserOf("packages/a/stryker.config.mjs")).toBe("Stryker");
	expect(analyserOf("src/a.ts")).toBeUndefined();
	expect(analyserOf("not-stryker.config.json")).toBeUndefined();
});

it("names the Vitest files a Stryker run loads, by their whole basename", () => {
	const drives = "the Vitest run Stryker drives";
	for (const path of [
		"vitest.config.ts",
		"vitest.config.mts",
		"vitest.stryker.config.ts",
		"packages/a/vitest.config.js",
		"scripts/stryker-test-names.mjs",
		"stryker-test-names.cjs",
		"vitest.setup.ts",
		"packages/a/vitest.setup.mts",
		"vitest.setupFiles.ts",
		"vitest.stryker.setup.ts",
		"stryker.setup.mjs",
	])
		expect(analyserOf(path), path).toBe(drives);
	for (const path of [
		"myvitest.config.ts",
		"not-stryker-test-names.mjs",
		"vitestXconfig.ts",
		"vitest.strykerXconfig.ts",
		"vitest.stryker.configuration",
		"myvitest.setup.ts",
		"setup.ts",
		"test/setup.ts",
		"mystryker.setup.ts",
		"vitest.stryker.ts",
		"stryker-test-namesX.mjs",
		"strykerXtest-names.mjs",
		"stryker-test-names",
	])
		expect(analyserOf(path), path).toBeUndefined();
});

describe("Biome exclusions", () => {
	const biome = (ignore: string[]) => JSON.stringify({ files: { ignore } });
	const oversized = "a".repeat(maxProgram - 6);
	const refusal = {
		code: "unreadable",
		check: "guardrails",
		message: expect.stringContaining("biome.json holds a glob Melian refuses"),
	};

	it("refuses a later exclusion even when the first matches every changed path", () => {
		expect(() => switchOffs("biome.json", biome([]), biome(["**", oversized]), ["src/a.ts"])).toThrowError(
			CheckError,
		);
		expect(() => switchOffs("biome.json", biome([]), biome(["**", oversized]), ["src/a.ts"])).toThrowError(
			expect.objectContaining(refusal),
		);
	});

	it("refuses the directory form even when the bare glob matches", () => {
		expect(() => switchOffs("biome.json", biome([]), biome([oversized]), [oversized])).toThrowError(
			expect.objectContaining(refusal),
		);
	});

	it("accepts the directory form at the compiler limit", () => {
		const atLimit = "a".repeat(maxProgram - 7);
		expect(switchOffs("biome.json", biome([]), biome([atLimit]), [atLimit])).toEqual([
			`It makes Biome ignore ${atLimit}, which this change touches.`,
		]);
	});

	it("compiles exclusions even when no changed path belongs to that configuration", () => {
		expect(() => switchOffs("web/biome.json", biome([]), biome([oversized]), ["src/a.ts"])).toThrowError(CheckError);
	});

	it("refuses the base's exclusion even when the head excludes nothing", () => {
		expect(() => switchOffs("biome.json", biome([oversized]), biome([]), ["src/a.ts"])).toThrowError(CheckError);
	});

	it("normalises directory exclusions and compares them with the base", () => {
		expect(
			switchOffs("web/biome.json", biome(["./src/kept///"]), biome(["./src///"]), [
				"web/src/a.ts",
				"web/src/kept/b.ts",
				"other.ts",
			]),
		).toEqual(["It makes Biome ignore src/a.ts, which this change touches."]);
	});
});

describe("npm scripts", () => {
	const manifest = (scripts: unknown) => JSON.stringify({ scripts });
	const base = manifest({ check: "vitest --run", lint: "biome lint" });

	it.each([
		["a rewritten script", manifest({ check: "true", lint: "biome lint" }), ['It changes the npm script "check".']],
		["a removed script", manifest({ check: "vitest --run" }), ['It removes the npm script "lint".']],
		[
			"two changed and none removed",
			manifest({ check: "true", lint: "true" }),
			['It changes the npm scripts "check", "lint".'],
		],
		["a scripts field that is not an object", manifest(["vitest"]), ['It removes the npm scripts "check", "lint".']],
		["a null scripts field", manifest(null), ['It removes the npm scripts "check", "lint".']],
		["no scripts field", JSON.stringify({ name: "a" }), ['It removes the npm scripts "check", "lint".']],
		[
			"a script that becomes a number",
			manifest({ check: 1, lint: "biome lint" }),
			['It changes the npm script "check".'],
		],
		["only an added script", manifest({ check: "vitest --run", lint: "biome lint", precheck: "true" }), []],
		["a head that does not parse", "{", ["Melian cannot read the npm scripts in the head's package.json."]],
		["a head that is an array", "[]", ["Melian cannot read the npm scripts in the head's package.json."]],
		["a head that is null", "null", ["Melian cannot read the npm scripts in the head's package.json."]],
	])("reports %s", (_, head, expected) => {
		expect(switchOffs("package.json", base, head, [])).toEqual(expected);
	});

	// @npmcli/package-json keeps a `scripts` array, since it is an object, so `npm run 0` runs its first entry.
	it("reads a head scripts array by its indexes, as npm does", () => {
		expect(switchOffs("package.json", manifest({ "0": "vitest --run" }), manifest(["vitest --run"]), [])).toEqual([]);
		expect(switchOffs("package.json", manifest({ "0": "vitest --run" }), manifest(["true"]), [])).toEqual([
			'It changes the npm script "0".',
		]);
	});

	it("says the scripts cannot be read when the head is a link, too large, or not an object", () => {
		const unread = ["Melian cannot read the npm scripts in the head's package.json."];
		expect(switchOffs("package.json", base, "real.json", [])).toEqual(unread);
		expect(switchOffs("package.json", base, "", [])).toEqual(unread);
		expect(switchOffs("package.json", JSON.stringify({}), "real.json", [])).toEqual([]);
		expect(switchOffs("package.json", manifest({}), "real.json", [])).toEqual([]);
	});

	it("names every base script when the head deletes package.json", () => {
		expect(switchOffs("package.json", base, undefined, [])).toEqual([
			"The head deletes package.json.",
			'It removes the npm scripts "check", "lint".',
		]);
		expect(switchOffs("package-lock.json", base, undefined, [])).toEqual(["The head deletes package-lock.json."]);
	});

	it("reads a nested package.json in any case, and no other manifest", () => {
		const head = manifest({ lint: "biome lint" });
		expect(switchOffs("web/Package.Json", base, head, [])).toEqual(['It removes the npm script "check".']);
		expect(switchOffs("package-lock.json", base, head, [])).toEqual([]);
	});

	it("reports nothing when the base had no scripts, or scripts that are not an object", () => {
		expect(switchOffs("package.json", JSON.stringify({}), manifest({ check: "true" }), [])).toEqual([]);
		expect(switchOffs("package.json", manifest("check"), manifest({ check: "true" }), [])).toEqual([]);
		expect(switchOffs("package.json", manifest(null), manifest({}), [])).toEqual([]);
	});

	it("reads a base scripts array by its indexes too", () => {
		expect(switchOffs("package.json", manifest(["vitest --run"]), manifest(["true"]), [])).toEqual([
			'It changes the npm script "0".',
		]);
		expect(switchOffs("package.json", manifest(["vitest --run"]), undefined, [])).toEqual([
			"The head deletes package.json.",
			'It removes the npm script "0".',
		]);
	});

	it("names at most ten scripts and counts the rest", () => {
		const names = (count: number) => Array.from({ length: count }, (_, index) => `s${index}`);
		const scripts = (count: number) => Object.fromEntries(names(count).map((name) => [name, "x"]));
		const quoted = (count: number) =>
			names(count)
				.map((name) => JSON.stringify(name))
				.join(", ");
		expect(switchOffs("package.json", manifest(scripts(10)), manifest({}), [])).toEqual([
			`It removes the npm scripts ${quoted(10)}.`,
		]);
		expect(switchOffs("package.json", manifest(scripts(11)), manifest({}), [])).toEqual([
			`It removes the npm scripts ${quoted(10)}, and 1 more.`,
		]);
	});

	it("counts a script name past 100 characters rather than quoting it", () => {
		const at = "a".repeat(100);
		const past = "b".repeat(101);
		expect(switchOffs("package.json", manifest({ [at]: "x" }), manifest({}), [])).toEqual([
			`It removes the npm script "${at}".`,
		]);
		expect(switchOffs("package.json", manifest({ [past]: "x", lint: "x" }), manifest({}), [])).toEqual([
			'It removes the npm scripts "lint", and 1 more.',
		]);
		expect(switchOffs("package.json", manifest({ [past]: "x" }), manifest({}), [])).toEqual([
			"It removes 1 npm script whose name is too long to quote.",
		]);
	});

	it("quotes a base script's name as JSON, so no newline or quote in it reads as prose", () => {
		const odd = 'a"\nb';
		expect(switchOffs("package.json", manifest({ [odd]: "x" }), manifest({}), [])).toEqual([
			'It removes the npm script "a\\"\\nb".',
		]);
	});

	it("reads package.json as npm does, so a comma before a closing bracket inside a string stays", () => {
		expect(switchOffs("package.json", manifest({ check: "echo ,}" }), manifest({ check: "echo }" }), [])).toEqual([
			'It changes the npm script "check".',
		]);
		expect(switchOffs("package.json", manifest({ "check,]": "x" }), manifest({}), [])).toEqual([
			'It removes the npm script "check,]".',
		]);
	});

	it("strips one leading byte order mark, as npm does", () => {
		expect(switchOffs("package.json", base, `﻿${manifest({ check: "true", lint: "biome lint" })}`, [])).toEqual([
			'It changes the npm script "check".',
		]);
		expect(switchOffs("package.json", base, `﻿﻿${manifest({ check: "true" })}`, [])).toEqual([
			"Melian cannot read the npm scripts in the head's package.json.",
		]);
	});

	it("keeps a byte order mark inside a script, so removing it is a change", () => {
		const mark = String.fromCharCode(0xfeff);
		expect(
			switchOffs("package.json", manifest({ check: `echo ${mark}x` }), manifest({ check: "echo x" }), []),
		).toEqual(['It changes the npm script "check".']);
	});
});

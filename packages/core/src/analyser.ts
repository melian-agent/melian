import { posix } from "node:path";
import { enolaPolicyPattern } from "./enola-paths.ts";
import { compileGlob } from "./pattern.ts";

// Which analyser a configuration file steers, by its name.
export function analyserOf(path: string): string | undefined {
	if (enolaPolicyPattern.test(path)) return "Enola";
	const name = posix.basename(path);
	if (/^biome\.jsonc?$/.test(name)) return "Biome";
	if (/^tsconfig.*\.json$/.test(name)) return "tsc";
	if (name === "package.json" || name === "package-lock.json") return "the packages Biome and tsc load";
	if (/^\.eslintrc|^eslint\.config\./.test(name)) return "ESLint";
	if (/^stryker\.config\./.test(name)) return "Stryker";
	return undefined;
}

/**
 * Parses JSON with comments and trailing commas, as `tsconfig.json` and `biome.jsonc` allow. Returns undefined when
 * the text is not even that.
 */
export function parseJsonc(text: string): unknown {
	let plain = "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (char === '"') {
			const end = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(index));
			if (end === null) return undefined;
			plain += end[0];
			index += end[0].length - 1;
		} else if (text.startsWith("//", index)) {
			const end = text.indexOf("\n", index);
			index = end === -1 ? text.length : end - 1;
		} else if (text.startsWith("/*", index)) {
			const end = text.indexOf("*/", index + 2);
			if (end === -1) return undefined;
			index = end + 1;
		} else {
			plain += char;
		}
	}
	try {
		return JSON.parse(plain.replace(/,(\s*[}\]])/g, "$1"));
	} catch {
		return undefined;
	}
}

type Json = Record<string, unknown>;

function field(value: unknown, ...keys: string[]): unknown {
	let at = value;
	for (const key of keys) {
		if (typeof at !== "object" || at === null || Array.isArray(at)) return undefined;
		at = (at as Json)[key];
	}
	return at;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
}

// The globs a Biome configuration excludes: Biome 1's `ignore` lists and Biome 2's `!` entries in `includes`.
function biomeExclusions(config: unknown): string[] {
	return [
		...strings(field(config, "files", "ignore")),
		...strings(field(config, "linter", "ignore")),
		...[...strings(field(config, "files", "includes")), ...strings(field(config, "linter", "includes"))]
			.filter((glob) => glob.startsWith("!"))
			.map((glob) => glob.replace(/^!+/, "")),
	];
}

function excludes(globs: readonly string[], path: string): boolean {
	return globs.some((glob) => {
		const bare = glob.replace(/^\.\//, "").replace(/\/+$/, "");
		return compileGlob(bare).test(path) || compileGlob(`${bare}/**`).test(path);
	});
}

/**
 * What a head's change to an analyser's configuration switches off, a sentence each: the file deleted, tsc's `noCheck`
 * or `skipLibCheck` turned on, Biome's linter disabled, or changed files Biome newly ignores. Best effort: it reads the
 * file itself, not what it extends.
 */
export function switchOffs(
	path: string,
	base: string | undefined,
	head: string | undefined,
	changed: readonly string[],
): string[] {
	const analyser = analyserOf(path);
	if (head === undefined) return base === undefined ? [] : [`The head deletes ${path}.`];
	const [before, after] = [base === undefined ? undefined : parseJsonc(base), parseJsonc(head)];
	const found: string[] = [];
	if (analyser === "tsc") {
		for (const option of ["noCheck", "skipLibCheck"]) {
			if (field(after, "compilerOptions", option) === true && field(before, "compilerOptions", option) !== true) {
				found.push(`It turns on ${option}.`);
			}
		}
	}
	if (analyser === "Biome") {
		if (field(after, "linter", "enabled") === false && field(before, "linter", "enabled") !== false) {
			found.push("It turns Biome's linter off.");
		}
		const directory = posix.dirname(path);
		const relative = changed
			.filter((each) => directory === "." || each.startsWith(`${directory}/`))
			.map((each) => (directory === "." ? each : each.slice(directory.length + 1)));
		const [was, is] = [biomeExclusions(before), biomeExclusions(after)];
		const ignored = relative.filter((each) => excludes(is, each) && !excludes(was, each));
		if (ignored.length > 0) found.push(`It makes Biome ignore ${ignored.join(", ")}, which this change touches.`);
	}
	return found;
}

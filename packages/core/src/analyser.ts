import { posix } from "node:path";
import { enolaPolicyPattern } from "./enola-paths.ts";
import { CheckError } from "./errors.ts";
import { compileGlob, type LinearPattern, Refused } from "./pattern.ts";

// Which analyser a configuration file steers, by its name.
export function analyserOf(path: string): string | undefined {
	const lower = path.toLowerCase();
	if (enolaPolicyPattern.test(lower)) return "Enola";
	const name = posix.basename(lower);
	if (/^biome\.jsonc?$/.test(name)) return "Biome";
	if (/^tsconfig.*\.json$/.test(name)) return "tsc";
	if (name === "package.json" || name === "package-lock.json") return "the packages Biome and tsc load";
	if (/^\.eslintrc|^eslint\.config\./.test(name)) return "ESLint";
	if (/^stryker\.config\./.test(name)) return "Stryker";
	if (/^vitest\.(?:stryker\.)?config\.|^vitest\.(?:stryker\.)?setup|^stryker\.setup|^stryker-test-names\./.test(name))
		return "the Vitest run Stryker drives";
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

// A glob past the engine's step limit fails the guardrails check, naming the configuration and why; it never reads as
// a glob that excludes nothing.
function compileExclusions(globs: readonly string[], configuration: string): LinearPattern[] {
	return globs.flatMap((glob) => {
		const bare = glob.replace(/^\.\//, "").replace(/\/+$/, "");
		try {
			return [compileGlob(bare), compileGlob(`${bare}/**`)];
		} catch (error) {
			if (!(error instanceof Refused)) throw error;
			throw new CheckError(
				"unreadable",
				"guardrails",
				`${configuration} holds a glob Melian refuses: ${error.reason}`,
				{
					cause: error,
				},
			);
		}
	});
}

/**
 * What a head's change to an analyser's configuration switches off, a sentence each: the file deleted, tsc's `noCheck`
 * or `skipLibCheck` turned on, Biome's linter disabled, changed files Biome newly ignores, or an npm script the base had
 * changed or removed. Best effort: it reads the file itself, not what it extends.
 */
export function switchOffs(
	path: string,
	base: string | undefined,
	head: string | undefined,
	changed: readonly string[],
): string[] {
	const analyser = analyserOf(path);
	const manifest = posix.basename(path.toLowerCase()) === "package.json";
	if (head === undefined) {
		if (base === undefined) return [];
		return [`The head deletes ${path}.`, ...(manifest ? scriptChanges(strictJson(base), {}) : [])];
	}
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
		const was = compileExclusions(biomeExclusions(before), path);
		const is = compileExclusions(biomeExclusions(after), path);
		const ignored = relative.filter(
			(each) => is.some((pattern) => pattern.test(each)) && !was.some((pattern) => pattern.test(each)),
		);
		if (ignored.length > 0) found.push(`It makes Biome ignore ${ignored.join(", ")}, which this change touches.`);
	}
	if (manifest) found.push(...scriptChanges(strictJson(base), strictJson(head)));
	return found;
}

// npm's json-parse-even-better-errors strips one leading byte order mark, then calls JSON.parse. `parseJsonc` would
// also drop a comma before a bracket inside a string.
function strictJson(text: string | undefined): unknown {
	try {
		return text === undefined ? undefined : JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

// Every script counts: npm runs `pre` and `post` scripts and lifecycle scripts no caller names, so no reading of the
// workflows says which ones a gate runs. Names come from the base alone, so no head text reaches the notice.
function scriptChanges(before: unknown, after: unknown): string[] {
	const was = field(before, "scripts");
	if (typeof after !== "object" || after === null || Array.isArray(after)) return [];
	if (typeof was !== "object" || was === null || Array.isArray(was)) return [];
	const is = field(after, "scripts");
	const now = typeof is === "object" && is !== null ? (is as Json) : {};
	const names = Object.keys(was);
	const removed = names.filter((name) => !Object.hasOwn(now, name));
	const changed = names.filter(
		(name) => Object.hasOwn(now, name) && JSON.stringify(now[name]) !== JSON.stringify((was as Json)[name]),
	);
	const sentence = (verb: string, list: string[]) =>
		`It ${verb} the npm script${list.length > 1 ? "s" : ""} ${list.map((name) => JSON.stringify(name)).join(", ")}.`;
	return [
		...(changed.length > 0 ? [sentence("changes", changed)] : []),
		...(removed.length > 0 ? [sentence("removes", removed)] : []),
	];
}

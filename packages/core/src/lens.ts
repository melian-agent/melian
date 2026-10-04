import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { parseDocument } from "yaml";
import { type LensTier, lensTierSchema, type MelianConfig, type Severity, severitySchema } from "./config.ts";
import { LensError } from "./errors.ts";
import { maxEvidenceLines, maxFailureScenarioLength } from "./findings.ts";
import { selectedBy } from "./glob.ts";
import { anchorGlob, directoriesUpToRoot, melianPaths, repoPath } from "./paths.ts";
import { openSource, type RepositorySource, SourceError, type SourceReader } from "./source.ts";
import type { StandardsSection } from "./standards.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });

/** The read-only tools a lens may list in `tools`. Every lens also gets `report_finding`, which it never lists. */
export const lensToolNames = ["read_file", "search", "list_files"] as const;

/** A read-only tool a lens may be offered. */
export type LensToolName = (typeof lensToolNames)[number];

/**
 * The JSON Schema of a {@link LensRule}. An ID is lower-case letters, digits, dots, and hyphens; the `melian/` prefix
 * marks a rule Melian defines for every lens, such as `melian/injection-attempt`.
 */
export const lensRuleSchema = Type.Object(
	{ id: Type.String({ pattern: "^(melian/)?[a-z0-9][a-z0-9.-]*$" }), description: text },
	strict,
);

/** How hard a lens looks at one change, from least to most. */
export const scrutinyLevels = ["quick", "careful", "deep"] as const;

/** A scrutiny level: `quick`, `careful`, or `deep`. */
export type ScrutinyLevel = (typeof scrutinyLevels)[number];

/** The level a lens runs at when nothing chooses another, and the only level of a lens that declares none. */
export const defaultScrutinyLevel = "careful" satisfies ScrutinyLevel;

/** What a lens reads at a level: the hunks only, or the hunks and the whole function around each. */
export const lensReadScopes = ["hunks", "functions"] as const;

/** A lens's reading scope at a level. */
export type LensReads = (typeof lensReadScopes)[number];

const budgetSchema = Type.Object(
	{
		findings: Type.Optional(Type.Integer({ minimum: 1 })),
		tokens: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: "^[0-9]+[kKmM]?$" })])),
		tools: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	strict,
);

const levelSchema = Type.Object(
	{
		tier: Type.Optional(lensTierSchema),
		reads: Type.Optional(Type.Union(lensReadScopes.map((reads) => Type.Literal(reads)))),
		verify: Type.Optional(Type.Boolean()),
		budget: Type.Optional(budgetSchema),
	},
	strict,
);

/**
 * The JSON Schema of a `LENS.md` front matter block. Only `name` is required; unknown fields are rejected. `levels` maps
 * a {@link ScrutinyLevel} to the fields that differ there; each field it leaves out comes from the top level.
 */
export const lensFrontMatterSchema = Type.Object(
	{
		name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
		description: Type.Optional(text),
		tier: Type.Optional(lensTierSchema),
		tools: Type.Optional(Type.Array(Type.Union(lensToolNames.map((tool) => Type.Literal(tool))))),
		severities: Type.Optional(Type.Array(severitySchema, { minItems: 1 })),
		rules: Type.Optional(Type.Array(lensRuleSchema, { minItems: 1 })),
		paths: Type.Optional(Type.Array(text, { minItems: 1 })),
		budget: Type.Optional(budgetSchema),
		levels: Type.Optional(
			Type.Object(Object.fromEntries(scrutinyLevels.map((level) => [level, Type.Optional(levelSchema)])), strict),
		),
		extends: Type.Optional(Type.Union([text, Type.Null()])),
		standards: Type.Optional(Type.Boolean()),
	},
	strict,
);

/** A `LENS.md` front matter block as written. */
export type LensFrontMatter = Static<typeof lensFrontMatterSchema>;

/** A rule a lens reports findings under: its ID, and one line saying what it catches. */
export type LensRule = Static<typeof lensRuleSchema>;

/**
 * What a lens may spend at a level: findings it may report, input and output tokens its conversation may use, and calls
 * it may make to the read-only tools. A budget it leaves out is unbounded.
 */
export interface LensBudget {
	readonly findings: number;
	readonly tokens?: number;
	readonly tools?: number;
}

/** How a lens runs at one {@link ScrutinyLevel}: its model tier, what it reads, whether its findings are verified, and its budget. */
export interface LensLevel {
	readonly tier: LensTier;
	readonly reads: LensReads;
	readonly verify: boolean;
	readonly budget: LensBudget;
}

/** The levels a lens runs at: always `careful`, and `quick` and `deep` where its `LENS.md` declares them. */
export type LensLevels = { readonly careful: LensLevel } & { readonly [Level in "quick" | "deep"]?: LensLevel };

/**
 * A lens with its layering and defaults resolved, ready to run as a conversation.
 *
 * `paths` are repository-relative globs. `scope` is the directory whose `.melian/` or `.agents/` defined the lens, the
 * empty string for the root and for built-in lenses; a lens never applies outside its scope. `levels` holds each level
 * the lens runs at, every field resolved. `version` hashes everything that shapes the lens's behaviour, so a finding
 * can name the lens version that produced it.
 */
export interface Lens {
	readonly name: string;
	readonly description: string;
	readonly tools: readonly LensToolName[];
	readonly severities: readonly Severity[];
	readonly rules: readonly LensRule[];
	readonly paths: readonly string[];
	readonly scope: string;
	readonly levels: LensLevels;
	readonly standards: boolean;
	readonly instructions: string;
	readonly version: string;
	/** The nearest `LENS.md` that defined or extended it. */
	readonly file: string;
	/**
	 * Folders beneath `scope` whose own lens of this name replaces this one there, found by {@link loadLenses} across
	 * the whole source, whether or not a changed path reaches them. Not part of `version`.
	 */
	readonly nearer?: readonly string[];
}

/** The largest `LENS.md` the loader reads, and the findings budget of a lens that sets none. */
export const lensLimits = { fileBytes: 64 * 1024, defaultFindings: 10 } as const;

const lensDirectories = [".agents/lenses", melianPaths.lenses] as const;
const builtinDirectory = fileURLToPath(new URL("../lenses/", import.meta.url));

interface Definition {
	readonly file: string;
	readonly scope: string;
	readonly frontMatter: LensFrontMatter;
	readonly body: string;
}

function dotted(instancePath: string): string {
	return instancePath.split("/").slice(1).join(".");
}

// `lens <name>, level <level>: ` for a field under `levels.<level>`, so the error names both.
function levelPrefix(value: unknown, field: string): { prefix: string; lens?: string; level?: string } {
	const [top, level] = field.split(".");
	if (top !== "levels" || level === undefined) return { prefix: "" };
	const name = (value as { name?: unknown }).name;
	const lens = typeof name === "string" ? name : undefined;
	return { prefix: `lens ${lens ?? "(unnamed)"}, level ${level}: `, ...(lens === undefined ? {} : { lens }), level };
}

function validate(file: string, value: unknown): LensFrontMatter {
	const errors = [...Value.Errors(lensFrontMatterSchema, value)];
	const unknown = errors.find((error) => error.keyword === "additionalProperties");
	if (unknown !== undefined) {
		const [key] = (unknown.params as { additionalProperties: string[] }).additionalProperties;
		const field = [dotted(unknown.instancePath), key].filter(Boolean).join(".");
		const { prefix, ...named } = levelPrefix(value, field);
		if (dotted(unknown.instancePath) === "levels") {
			const levels = scrutinyLevels.join(", ");
			const message = `${file}: ${prefix}no such level; a lens's levels are ${levels}`;
			throw new LensError("unknownLevel", file, message, { field, ...named });
		}
		throw new LensError("unknownField", file, `${file}: ${prefix}unknown front matter field "${field}"`, {
			field,
			...named,
		});
	}
	const first = errors[0];
	if (first === undefined) return value as LensFrontMatter;
	const field = dotted(first.instancePath) || undefined;
	const allowed = errors
		.filter((error) => error.instancePath === first.instancePath && error.keyword === "const")
		.map((error) => (error.params as { allowedValue: unknown }).allowedValue);
	const problem = allowed.length > 0 ? `must be one of ${allowed.join(", ")}` : first.message;
	const { prefix, ...named } = levelPrefix(value, field ?? "");
	throw new LensError("invalidValue", file, `${file}: ${prefix}"${field ?? "(front matter)"}" ${problem}`, {
		field,
		...named,
	});
}

/**
 * Parses one `LENS.md`: a YAML front matter block between `---` lines, then the body. `file` names it in errors.
 * Throws {@link LensError} for a missing block, invalid YAML, an unknown field, or a bad value.
 */
export function parseLensFile(file: string, content: string): { frontMatter: LensFrontMatter; body: string } {
	const normalised = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
	const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalised);
	if (match === null) {
		throw new LensError("missingFrontMatter", file, `${file}: LENS.md must start with a --- front matter block`);
	}
	const document = parseDocument(match[1]!);
	const problem = document.errors[0] ?? document.warnings[0];
	if (problem !== undefined) {
		throw new LensError("invalidYaml", file, `${file}: ${problem.message}`, { cause: problem });
	}
	const value: unknown = document.toJS() ?? {};
	if (typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")) {
		throw new LensError("invalidValue", file, `${file}: "__proto__" is reserved`, { field: "__proto__" });
	}
	return { frontMatter: validate(file, value), body: normalised.slice(match[0].length).trim() };
}

function tokens(value: number | string | undefined): number | undefined {
	if (typeof value !== "string") return value;
	const scale: Record<string, number> = { k: 1_000, m: 1_000_000 };
	const unit = value.slice(-1).toLowerCase();
	return unit in scale ? Number(value.slice(0, -1)) * scale[unit]! : Number(value);
}

// Paths are relative to the directory holding the lens's `.melian/` or `.agents/`, like a melian.yaml's.
// Normalised like a melian.yaml's lens paths, so `./src/**` is `src/**`, and refused if `..` leaves the repository.
function anchor(file: string, scope: string, path: string): string {
	const anchored = anchorGlob(scope, path);
	if (anchored !== undefined) return anchored;
	throw new LensError("invalidValue", file, `${file}: "paths" has ${path}, which leaves the repository`, {
		field: "paths",
	});
}

function required<T>(file: string, field: string, value: T | undefined): T {
	if (value !== undefined) return value;
	throw new LensError(
		"missingField",
		file,
		`${file}: "${field}" is required unless the lens extends one that sets it`,
		{
			field,
		},
	);
}

function versioned(lens: Omit<Lens, "version">): Lens {
	const { file: _, nearer: __, ...behaviour } = lens;
	const version = createHash("sha256").update(JSON.stringify(behaviour)).digest("hex").slice(0, 12);
	return { ...lens, version };
}

type DeclaredBudget = { readonly findings?: number; readonly tokens?: number; readonly tools?: number };
type DeclaredLevel = {
	readonly tier?: LensTier;
	readonly reads?: LensReads;
	readonly verify?: boolean;
	readonly budget: DeclaredBudget;
};

// What a lens's files set, layered through `extends` but not yet defaulted, so a level a nearer file leaves alone
// still takes the top-level tier or budget that file sets.
interface Declared {
	readonly tier?: LensTier;
	readonly budget: DeclaredBudget;
	readonly levels: { readonly [Level in ScrutinyLevel]?: DeclaredLevel };
}

function declaredBudget(budget: LensFrontMatter["budget"], base: DeclaredBudget | undefined): DeclaredBudget {
	return {
		findings: budget?.findings ?? base?.findings,
		tokens: tokens(budget?.tokens) ?? base?.tokens,
		tools: budget?.tools ?? base?.tools,
	};
}

function declare(own: LensFrontMatter, base: Declared | undefined): Declared {
	const levels: { [Level in ScrutinyLevel]?: DeclaredLevel } = {};
	for (const level of scrutinyLevels) {
		const mine = own.levels?.[level];
		const theirs = base?.levels[level];
		if (mine === undefined && theirs === undefined) continue;
		levels[level] = {
			tier: mine?.tier ?? theirs?.tier,
			reads: mine?.reads ?? theirs?.reads,
			verify: mine?.verify ?? theirs?.verify,
			budget: declaredBudget(mine?.budget, theirs?.budget),
		};
	}
	return { tier: own.tier ?? base?.tier, budget: declaredBudget(own.budget, base?.budget), levels };
}

// Each field a level leaves out comes from the top level, then from Melian's default. `careful` always exists, and is
// resolved first, so a lens with no tier anywhere is refused for its top-level `tier`.
function resolveLevels(file: string, name: string, declared: Declared): LensLevels {
	const resolved = (level: ScrutinyLevel, own: DeclaredLevel | undefined): LensLevel => {
		const tier = own?.tier ?? declared.tier;
		if (tier === undefined && level === defaultScrutinyLevel) required(file, "tier", tier);
		if (tier === undefined) {
			throw new LensError(
				"missingField",
				file,
				`${file}: lens ${name}, level ${level}: "tier" is required, on the level or at the top level`,
				{ field: `levels.${level}.tier`, lens: name, level },
			);
		}
		const tokens = own?.budget.tokens ?? declared.budget.tokens;
		const tools = own?.budget.tools ?? declared.budget.tools;
		return {
			tier,
			reads: own?.reads ?? "hunks",
			verify: own?.verify ?? level !== "quick",
			budget: {
				findings: own?.budget.findings ?? declared.budget.findings ?? lensLimits.defaultFindings,
				...(tokens === undefined ? {} : { tokens }),
				...(tools === undefined ? {} : { tools }),
			},
		};
	};
	const careful = resolved(defaultScrutinyLevel, declared.levels.careful);
	const { quick, deep } = declared.levels;
	return {
		...(quick === undefined ? {} : { quick: resolved("quick", quick) }),
		careful,
		...(deep === undefined ? {} : { deep: resolved("deep", deep) }),
	};
}

// `extends` takes the named lens, as layered so far, and overrides the fields this file sets. Its body is appended.
function resolve(definition: Definition, base: Layered | undefined): Layered {
	const { file, scope, frontMatter: own, body } = definition;
	const description = required(file, "description", own.description ?? base?.lens.description);
	const rules = required(file, "rules", own.rules ?? base?.lens.rules);
	const duplicate = rules.find((rule, index) => rules.findIndex((other) => other.id === rule.id) !== index);
	if (duplicate !== undefined) {
		throw new LensError("invalidValue", file, `${file}: rule "${duplicate.id}" is listed twice`, { field: "rules" });
	}
	const declared = declare(own, base?.declared);
	const lens = versioned({
		name: own.name,
		description,
		tools: own.tools ?? base?.lens.tools ?? lensToolNames,
		severities: own.severities ?? base?.lens.severities ?? ["P0", "P1", "P2", "P3", "nit"],
		rules,
		paths: own.paths?.map((path) => anchor(file, scope, path)) ?? base?.lens.paths ?? [anchor(file, scope, "**")],
		scope,
		levels: resolveLevels(file, own.name, declared),
		standards: own.standards ?? base?.lens.standards ?? true,
		instructions: [base?.lens.instructions, body].filter((part) => part !== undefined && part !== "").join("\n\n"),
		file,
	});
	return { lens, declared };
}

interface Layered {
	readonly lens: Lens;
	readonly declared: Declared;
}

function fromSource(file: string) {
	return (error: unknown): never => {
		if (!(error instanceof SourceError)) throw error;
		throw new LensError(error.code, file, error.message, { cause: error });
	};
}

async function builtinDefinitions(): Promise<Definition[]> {
	const names = (await readdir(builtinDirectory, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	return Promise.all(
		names.map(async (name) => {
			const file = `builtin:${name}`;
			const content = await readFile(join(builtinDirectory, name, "LENS.md"), "utf8");
			return { file, scope: "", ...parseLensFile(file, content) };
		}),
	);
}

// `.agents/lenses` first, so that the canonical `.melian/lenses` wins a name both define in one directory.
async function repositoryDefinitions(reader: SourceReader, scope: string): Promise<Definition[]> {
	const definitions: Definition[] = [];
	for (const location of lensDirectories) {
		const directory = posix.join(scope, location);
		const entries = (await reader.list(directory).catch(fromSource(directory))) ?? [];
		for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const file = posix.join(directory, entry.name, "LENS.md");
			if (entry.kind === "symlink") {
				const where = reader.label(posix.dirname(file));
				throw new LensError("symlink", file, `${where} is a symlink, which Melian does not follow`);
			}
			if (entry.kind !== "directory") continue;
			const content = await reader.readText(file, lensLimits.fileBytes).catch(fromSource(file));
			if (content === undefined) continue;
			const parsed = parseLensFile(file, content);
			if (posix.basename(posix.dirname(file)) !== parsed.frontMatter.name) {
				throw new LensError(
					"invalidValue",
					file,
					`${file}: name "${parsed.frontMatter.name}" must match its directory`,
					{
						field: "name",
					},
				);
			}
			definitions.push({ file, scope, ...parsed });
		}
	}
	return definitions;
}

// `<scope>/.melian/lenses/<name>/...` or `<scope>/.agents/lenses/<name>/...`, and the lens entry itself if it is a symlink.
const lensEntry = /^(?:(.*)\/)?\.(?:melian|agents)\/lenses\/([^/]+)(?:\/|$)/s;

// Every directory holding repository lenses, with the names it defines, from one listing of the source.
async function lensScopes(reader: SourceReader): Promise<Map<string, Set<string>>> {
	const scopes = new Map<string, Set<string>>();
	for (const path of await reader.findPaths(lensEntry).catch(fromSource("."))) {
		const [, scope = "", name] = lensEntry.exec(path)!;
		scopes.set(scope, (scopes.get(scope) ?? new Set()).add(name!));
	}
	return scopes;
}

function layer(definitions: readonly Definition[]): Lens[] {
	const lenses = new Map<string, Layered>();
	for (const definition of definitions) {
		const { extends: extended, name } = definition.frontMatter;
		const base = extended == null ? undefined : lenses.get(extended);
		if (extended != null && base === undefined) {
			throw new LensError(
				"unknownLens",
				definition.file,
				`${definition.file}: extends "${extended}", which no farther lens defines`,
				{
					field: "extends",
				},
			);
		}
		lenses.set(name, resolve(definition, base));
	}
	return [...lenses.values()].map(({ lens }) => lens);
}

/**
 * Loads the lenses that apply to each of `paths`, files or directories inside the repository at `repoRoot`, and
 * returns their union by name and version, sorted by name.
 *
 * Built-in lenses come first. Over them layer the `.melian/lenses/<name>/LENS.md` and `.agents/lenses/<name>/LENS.md`
 * of every directory from the root down to each path, nearest last, so the nearest definition of a name wins; within
 * one directory `.melian/` wins over `.agents/`. A definition with `extends` overrides the fields it sets on the named
 * lens as layered so far and appends its body; one without replaces any farther lens of its name. Repository lenses are
 * read from `source`, as configuration is, so a pull request's head cannot rewrite the lenses that review it.
 *
 * Throws {@link LensError} naming the file for a symlink, a file over {@link lensLimits}, an unreadable file, bad
 * front matter, a missing required field, or an `extends` naming no lens; and {@link OutsideRepositoryError} when a
 * path is outside `repoRoot`.
 */
export async function loadLenses(
	repoRoot: string,
	source: RepositorySource,
	paths: readonly string[],
): Promise<Lens[]> {
	const reader = await openSource(repoRoot, source).catch(fromSource(repoRoot));
	const builtins = await builtinDefinitions();
	const defined = await lensScopes(reader);
	const byScope = new Map<string, Promise<Definition[]>>();
	const definitionsIn = (scope: string) => {
		if (!byScope.has(scope)) byScope.set(scope, repositoryDefinitions(reader, scope));
		return byScope.get(scope)!;
	};
	// Paths that share their chain of lens scopes share their lenses, so each chain is layered once.
	const chains = new Map<string, string[]>();
	for (const path of paths) {
		const target = repoPath(repoRoot, path);
		// A file is never a scope, so treating every path as a directory adds nothing for a file and saves a lookup.
		const scopes = directoriesUpToRoot(target, true)
			.reverse()
			.filter((scope) => defined.has(scope));
		chains.set(scopes.join("\0"), scopes);
	}
	// Where a nearer folder defines a lens's name, that folder is not the lens's to review, even if no path reaches it.
	const withNearer = (lens: Lens): Lens => {
		const nearer = [...defined.entries()]
			.filter(([scope, names]) => names.has(lens.name) && scope !== lens.scope && beneath(lens.scope, scope))
			.map(([scope]) => scope)
			.sort();
		return nearer.length === 0 ? lens : { ...lens, nearer };
	};
	const union = new Map<string, Lens>();
	for (const scopes of chains.values()) {
		const repository = (await Promise.all(scopes.map(definitionsIn))).flat();
		for (const lens of layer([...builtins, ...repository]))
			union.set(`${lens.name}\0${lens.version}`, withNearer(lens));
	}
	if (paths.length === 0)
		for (const lens of layer(builtins)) union.set(`${lens.name}\0${lens.version}`, withNearer(lens));
	return [...union.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Where a lens may look: beneath its `scope`, selected by its `paths`, and outside every `nearer` scope, where a nearer
 * definition of the same name replaces it.
 */
export interface LensCoverage {
	readonly scope: string;
	readonly paths: readonly string[];
	readonly nearer: readonly string[];
}

/** A lens chosen to run, where it may look, and the changed files it reviews. */
export interface LensSelection {
	readonly lens: Lens;
	readonly coverage: LensCoverage;
	readonly files: readonly string[];
}

function beneath(scope: string, path: string): boolean {
	return scope === "" || path.startsWith(`${scope}/`);
}

/** Whether `path`, repository-relative, lies where a lens with `coverage` may look. */
export function lensCovers(coverage: LensCoverage, path: string): boolean {
	return (
		beneath(coverage.scope, path) &&
		!coverage.nearer.some((scope) => beneath(scope, path)) &&
		selectedBy(coverage.paths, path)
	);
}

// Every level of `lens` on `tier`.
function retiered(levels: LensLevels, tier: LensTier): LensLevels {
	return Object.fromEntries(
		Object.entries(levels).map(([level, settings]) => [level, { ...settings, tier }]),
	) as unknown as LensLevels;
}

/**
 * Picks the lenses to run on a changeset and the changed files each reviews: a lens runs when `config` leaves it
 * enabled and it covers at least one of `paths`. A lens covers a path beneath its scope that its `paths` select,
 * unless a nearer folder defines a lens of the same name, which replaces it there. Configuration's `tier` replaces the
 * tier of every level of the lens, and its `paths` replace the lens's, so a `melian.yaml` can retier a lens, narrow it,
 * or switch it off without touching its `LENS.md`.
 */
export function selectLenses(lenses: readonly Lens[], config: MelianConfig, paths: readonly string[]): LensSelection[] {
	return lenses.flatMap((lens) => {
		const settings = Object.hasOwn(config.lenses, lens.name) ? config.lenses[lens.name] : undefined;
		if (settings?.enabled === false) return [];
		const tuned =
			settings === undefined
				? lens
				: versioned({
						...lens,
						levels: settings.tier === undefined ? lens.levels : retiered(lens.levels, settings.tier),
						paths: settings.paths ?? lens.paths,
					});
		const nearer = lenses
			.filter((other) => other.name === lens.name && other.scope !== lens.scope && beneath(lens.scope, other.scope))
			.map((other) => other.scope)
			.concat(lens.nearer ?? []);
		const coverage = { scope: tuned.scope, paths: tuned.paths, nearer: [...new Set(nearer)] };
		const files = paths.filter((path) => lensCovers(coverage, path));
		return files.length > 0 ? [{ lens: tuned, coverage, files }] : [];
	});
}

const reportingRules = `## Failure scenario and evidence

Every \`report_finding\` call needs both. A call without them is refused.

- \`failureScenario\`: the concrete input, state, or sequence of calls that makes the code fail, and the wrong outcome it produces, in at most ${maxFailureScenarioLength} characters. Name values and results: "\`parsePort("")\` returns \`NaN\`, and \`listen(NaN)\` binds a random port", not "may fail for some inputs". If you cannot name one from the code you read, do not report the finding.
- \`evidence\`: one or more locations, \`{ file, line, endLine, role }\`, holding the code the claim rests on. \`role\` is \`cause\` for the code that brings the failure about, and \`context\` for code the claim reads but does not blame, such as a caller or the guard that is missing. Add \`revision: "base"\` for lines this change deleted, numbered as in the base commit; a location is at head otherwise. Melian reads the code at each location itself, so never quote it. A location spans at most ${maxEvidenceLines} lines. To find the base line numbers of deleted code, read the file with \`read_file\` and \`revision: "base"\`.
- The result of \`report_finding\` quotes the first line of each evidence location as Melian read it. If one is not the code you meant, call \`report_finding\` again for the same file, line, and rule with the right locations; it replaces your earlier report.
- A finding outside the change counts as caused by it only when one of its \`cause\` locations overlaps lines the change added, modified, or deleted, or any line of another file it renamed without editing, named by its old path with \`revision: "base"\` or by its new path. That counts only for a finding in a file the change edited or left alone: when the change only moved the finding's own file, no rename makes the finding caused by the change, not even a sibling moved with it. Otherwise it is recorded as pre-existing, and never blocks.`;

function counted(count: number, noun: string): string {
	return `${count.toLocaleString("en-AU")} ${noun}${count === 1 ? "" : "s"}`;
}

const readingScopes: Readonly<Record<LensReads, string>> = {
	hunks: "Reading scope: the hunks. Review the lines this change added, modified, or deleted; read the code around them only to confirm a defect in them.",
	functions:
		"Reading scope: the hunks and the functions around them. For each hunk, read the whole function, method, or top-level block that holds it at the head revision with `read_file`, and review all of it: a defect on a line the change left alone, inside a function it edited, is the change's to answer for. Cite the changed line that makes it so as a `cause` location.",
};

function renderBudget({ findings, tokens, tools }: LensBudget): string {
	const limits = [
		counted(findings, "finding"),
		...(tools === undefined ? [] : [`${counted(tools, "call")} to the read-only tools`]),
		...(tokens === undefined ? [] : [`${counted(tokens, "token")} of input and output`]),
	];
	const last = limits.pop()!;
	const listed = limits.length === 0 ? last : `${limits.join(", ")}${limits.length > 1 ? "," : ""} and ${last}`;
	const ending =
		tokens === undefined && tools === undefined
			? ""
			: " When the tool calls or tokens run out, the review ends with what you have reported, so report each finding as soon as you have confirmed it.";
	return `Budget: at most ${listed}.${ending}`;
}

// The lens's policy as the model must follow it, so it never guesses a rule ID the hook would refuse.
function renderPolicy(lens: Lens, level: LensLevel): string {
	return [
		"## Rules, severities, and budget",
		"Report every finding under one of these rule IDs, written exactly as here. A defect no rule fits is not yours to report.",
		lens.rules.map((rule) => `- \`${rule.id}\`: ${rule.description}`).join("\n"),
		`Severities you may report: ${lens.severities.join(", ")}.`,
		renderBudget(level.budget),
		readingScopes[level.reads],
		reportingRules,
	].join("\n\n");
}

/**
 * The settings `lens` runs with at `level`. Throws {@link LensError} `unknownLevel` for a level the lens does not
 * declare; every lens has `careful`.
 */
export function lensLevel(lens: Lens, level: ScrutinyLevel): LensLevel {
	const settings = lens.levels[level];
	if (settings !== undefined) return settings;
	const declared = scrutinyLevels.filter((each) => lens.levels[each] !== undefined).join(", ");
	throw new LensError("unknownLevel", lens.file, `lens ${lens.name} has no level ${level}; it has ${declared}`, {
		lens: lens.name,
		level,
	});
}

/**
 * The instructions a lens's conversation runs with at `level`, `careful` unless named: its body; then its rules, each
 * ID with its description, the severities it may report, the level's budget and reading scope, and what a finding's
 * failure scenario and evidence must be; then, unless the lens opted out, the repository's standards, each under its
 * path. Throws {@link LensError} `unknownLevel` for a level the lens does not declare.
 */
export function renderLensInstructions(
	lens: Lens,
	standards: readonly StandardsSection[],
	level: ScrutinyLevel = defaultScrutinyLevel,
): string {
	const instructions = [lens.instructions, renderPolicy(lens, lensLevel(lens, level))].join("\n\n");
	if (!lens.standards || standards.length === 0) return instructions;
	const sections = standards.map((section) => `### ${section.path}\n\n${section.content.trim()}`);
	return [
		instructions,
		"## Repository standards",
		"The repository's own conventions. A change that breaks one is a finding; cite the file.",
		...sections,
	].join("\n\n");
}

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { parseDocument } from "yaml";
import { type LensTier, lensTierSchema, type MelianConfig, type Severity, severitySchema } from "./config.ts";
import { LensError } from "./errors.ts";
import { selectedBy } from "./glob.ts";
import { directoriesUpToRoot, melianPaths, repoPath } from "./paths.ts";
import { openSource, type RepositorySource, SourceError, type SourceReader } from "./source.ts";
import type { StandardsSection } from "./standards.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });

/** The read-only tools a lens may list in `tools`. Every lens also gets `report_finding`, which it never lists. */
export const lensToolNames = ["read_file", "search", "list_files"] as const;

/** A read-only tool a lens may be offered. */
export type LensToolName = (typeof lensToolNames)[number];

/** The JSON Schema of a {@link LensRule}. */
export const lensRuleSchema = Type.Object(
	{ id: Type.String({ pattern: "^[a-z0-9][a-z0-9.-]*$" }), description: text },
	strict,
);

/** The JSON Schema of a `LENS.md` front matter block. Only `name` is required; unknown fields are rejected. */
export const lensFrontMatterSchema = Type.Object(
	{
		name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
		description: Type.Optional(text),
		tier: Type.Optional(lensTierSchema),
		tools: Type.Optional(Type.Array(Type.Union(lensToolNames.map((tool) => Type.Literal(tool))))),
		severities: Type.Optional(Type.Array(severitySchema, { minItems: 1 })),
		rules: Type.Optional(Type.Array(lensRuleSchema, { minItems: 1 })),
		paths: Type.Optional(Type.Array(text, { minItems: 1 })),
		budget: Type.Optional(
			Type.Object(
				{
					findings: Type.Optional(Type.Integer({ minimum: 1 })),
					tokens: Type.Optional(
						Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: "^[0-9]+[kKmM]?$" })]),
					),
				},
				strict,
			),
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
 * A lens with its layering and defaults resolved, ready to run as a conversation.
 *
 * `paths` are repository-relative globs. `scope` is the directory whose `.melian/` or `.agents/` defined the lens, the
 * empty string for the root and for built-in lenses; a lens never applies outside its scope. `version` hashes
 * everything that shapes the lens's behaviour, so a finding can name the lens version that produced it.
 */
export interface Lens {
	readonly name: string;
	readonly description: string;
	readonly tier: LensTier;
	readonly tools: readonly LensToolName[];
	readonly severities: readonly Severity[];
	readonly rules: readonly LensRule[];
	readonly paths: readonly string[];
	readonly scope: string;
	/** `tokens` is recorded but not yet enforced. */
	readonly budget: { readonly findings: number; readonly tokens?: number };
	readonly standards: boolean;
	readonly instructions: string;
	readonly version: string;
	/** The nearest `LENS.md` that defined or extended it. */
	readonly file: string;
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

function validate(file: string, value: unknown): LensFrontMatter {
	const errors = [...Value.Errors(lensFrontMatterSchema, value)];
	const unknown = errors.find((error) => error.keyword === "additionalProperties");
	if (unknown !== undefined) {
		const [key] = (unknown.params as { additionalProperties: string[] }).additionalProperties;
		const field = [dotted(unknown.instancePath), key].filter(Boolean).join(".");
		throw new LensError("unknownField", file, `${file}: unknown front matter field "${field}"`, { field });
	}
	const first = errors[0];
	if (first === undefined) return value as LensFrontMatter;
	const field = dotted(first.instancePath) || undefined;
	const allowed = errors
		.filter((error) => error.instancePath === first.instancePath && error.keyword === "const")
		.map((error) => (error.params as { allowedValue: unknown }).allowedValue);
	const problem = allowed.length > 0 ? `must be one of ${allowed.join(", ")}` : first.message;
	throw new LensError("invalidValue", file, `${file}: "${field ?? "(front matter)"}" ${problem}`, { field });
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
function anchor(scope: string, path: string): string {
	const negated = path.startsWith("!");
	const pattern = (negated ? path.slice(1) : path).replace(/^\/+/, "");
	return `${negated ? "!" : ""}${scope === "" ? pattern : posix.join(scope, pattern)}`;
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
	const { file: _, ...behaviour } = lens;
	const version = createHash("sha256").update(JSON.stringify(behaviour)).digest("hex").slice(0, 12);
	return { ...lens, version };
}

// `extends` takes the named lens, as layered so far, and overrides the fields this file sets. Its body is appended.
function resolve(definition: Definition, base: Lens | undefined): Lens {
	const { file, scope, frontMatter: own, body } = definition;
	const budgetTokens = tokens(own.budget?.tokens) ?? base?.budget.tokens;
	const description = required(file, "description", own.description ?? base?.description);
	const tier = required(file, "tier", own.tier ?? base?.tier);
	const rules = required(file, "rules", own.rules ?? base?.rules);
	const duplicate = rules.find((rule, index) => rules.findIndex((other) => other.id === rule.id) !== index);
	if (duplicate !== undefined) {
		throw new LensError("invalidValue", file, `${file}: rule "${duplicate.id}" is listed twice`, { field: "rules" });
	}
	return versioned({
		name: own.name,
		description,
		tier,
		tools: own.tools ?? base?.tools ?? lensToolNames,
		severities: own.severities ?? base?.severities ?? ["P0", "P1", "P2", "P3", "nit"],
		rules,
		paths: own.paths?.map((path) => anchor(scope, path)) ?? base?.paths ?? [anchor(scope, "**")],
		scope,
		budget: {
			findings: own.budget?.findings ?? base?.budget.findings ?? lensLimits.defaultFindings,
			...(budgetTokens === undefined ? {} : { tokens: budgetTokens }),
		},
		standards: own.standards ?? base?.standards ?? true,
		instructions: [base?.instructions, body].filter((part) => part !== undefined && part !== "").join("\n\n"),
		file,
	});
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

function layer(definitions: readonly Definition[]): Lens[] {
	const lenses = new Map<string, Lens>();
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
	return [...lenses.values()];
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
	const byScope = new Map<string, Promise<Definition[]>>();
	const definitionsIn = (scope: string) => {
		if (!byScope.has(scope)) byScope.set(scope, repositoryDefinitions(reader, scope));
		return byScope.get(scope)!;
	};
	const union = new Map<string, Lens>();
	for (const path of paths) {
		const target = repoPath(repoRoot, path);
		const isDirectory = (await reader.exists(target).catch(fromSource(target))) === "directory";
		const scopes = directoriesUpToRoot(target, isDirectory).reverse();
		const repository = (await Promise.all(scopes.map(definitionsIn))).flat();
		for (const lens of layer([...builtins, ...repository])) union.set(`${lens.name}\0${lens.version}`, lens);
	}
	if (paths.length === 0) for (const lens of layer(builtins)) union.set(`${lens.name}\0${lens.version}`, lens);
	return [...union.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Picks the lenses to run on a changeset: those `config` leaves enabled whose scope and `paths` select at least one of
 * `paths`. Configuration overrides a lens's `tier` and replaces its `paths`, so a `melian.yaml` can retier a lens,
 * narrow it, or switch it off without touching its `LENS.md`.
 */
export function selectLenses(lenses: readonly Lens[], config: MelianConfig, paths: readonly string[]): Lens[] {
	return lenses.flatMap((lens) => {
		const settings = Object.hasOwn(config.lenses, lens.name) ? config.lenses[lens.name] : undefined;
		if (settings?.enabled === false) return [];
		const tuned =
			settings === undefined
				? lens
				: versioned({
						...lens,
						tier: settings.tier ?? lens.tier,
						paths: settings.paths ?? lens.paths,
					});
		const inScope = (path: string) => tuned.scope === "" || path.startsWith(`${tuned.scope}/`);
		return paths.some((path) => inScope(path) && selectedBy(tuned.paths, path)) ? [tuned] : [];
	});
}

/**
 * The instructions a lens's conversation runs with: its body, then, unless the lens opted out, the repository's
 * standards, each under its path.
 */
export function renderLensInstructions(lens: Lens, standards: readonly StandardsSection[]): string {
	if (!lens.standards || standards.length === 0) return lens.instructions;
	const sections = standards.map((section) => `### ${section.path}\n\n${section.content.trim()}`);
	return [
		lens.instructions,
		"## Repository standards",
		"The repository's own conventions. A change that breaks one is a finding; cite the file.",
		...sections,
	].join("\n\n");
}

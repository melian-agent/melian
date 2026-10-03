import { posix } from "node:path";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { parseDocument } from "yaml";
import { ConfigError, type ConfigErrorCode } from "./errors.ts";
import { directoriesUpToRoot, melianPaths, repoPath } from "./paths.ts";
import { openSource, type RepositorySource, SourceError, type SourceReader } from "./source.ts";

const strict = { additionalProperties: false } as const;

const name = Type.String({ minLength: 1 });
/** The JSON Schema of a {@link Resolution}. */
export const resolutionSchema = Type.Union([
	Type.Literal("block"),
	Type.Literal("acknowledge"),
	Type.Literal("advisory"),
	Type.Literal("silent"),
]);
/** The JSON Schema of a {@link Severity}. */
export const severitySchema = Type.Union([
	Type.Literal("P0"),
	Type.Literal("P1"),
	Type.Literal("P2"),
	Type.Literal("P3"),
	Type.Literal("nit"),
]);
/** The JSON Schema of a {@link LensTier}. */
export const lensTierSchema = Type.Union([Type.Literal("light"), Type.Literal("medium"), Type.Literal("heavy")]);
const modelRoute = Type.Object({ model: name, fallbacks: Type.Optional(Type.Array(name)) }, strict);
// Each end is optional in one file so that a nearer file can restate one; the merged band must have both.
const band = Type.Object(
	{
		drop: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		accept: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	},
	strict,
);

/** The JSON Schema of one `melian.yaml`. Every key is optional, and unknown keys are rejected. */
export const melianYamlSchema = Type.Object(
	{
		tiers: Type.Optional(Type.Record(Type.String(), Type.Array(name))),
		stages: Type.Optional(Type.Record(Type.String(), name)),
		resolution: Type.Optional(
			Type.Object(
				{
					P0: Type.Optional(resolutionSchema),
					P1: Type.Optional(resolutionSchema),
					P2: Type.Optional(resolutionSchema),
					P3: Type.Optional(resolutionSchema),
					nit: Type.Optional(resolutionSchema),
				},
				strict,
			),
		),
		lenses: Type.Optional(
			Type.Record(
				Type.String(),
				Type.Object(
					{
						enabled: Type.Optional(Type.Boolean()),
						tier: Type.Optional(lensTierSchema),
						paths: Type.Optional(Type.Array(name)),
					},
					strict,
				),
			),
		),
		models: Type.Optional(
			Type.Object(
				{
					light: Type.Optional(modelRoute),
					medium: Type.Optional(modelRoute),
					heavy: Type.Optional(modelRoute),
					decision: Type.Optional(modelRoute),
				},
				strict,
			),
		),
		knowledge: Type.Optional(Type.Object({ writeBack: Type.Optional(Type.Boolean()) }, strict)),
		decisions: Type.Optional(
			Type.Object(
				{ provider: Type.Optional(name), thresholds: Type.Optional(Type.Record(Type.String(), band)) },
				strict,
			),
		),
	},
	strict,
);

/** One `melian.yaml` as written. */
export type MelianYaml = Static<typeof melianYamlSchema>;

/** What a finding at a given severity requires before merge. */
export type Resolution = Static<typeof resolutionSchema>;

/** A severity in the default rubric. */
export type Severity = Static<typeof severitySchema>;

/** A model tier a lens can name. Model routing also has a `decision` tier for decision models. */
export type LensTier = Static<typeof lensTierSchema>;

/** A model and the models to try, in order, when it fails. */
export type ModelRoute = Static<typeof modelRoute>;

/** Per-lens settings. `paths` are repository-relative globs once loaded. */
export interface LensSettings {
	readonly enabled?: boolean;
	readonly tier?: LensTier;
	readonly paths?: readonly string[];
}

/**
 * A decision threshold: below `drop` drops, above `accept` accepts, between escalates to an LLM pass. One `melian.yaml`
 * may set either end; the merged band has both.
 */
export interface Band {
	readonly drop: number;
	readonly accept: number;
}

/** The effective configuration for one path: built-in defaults with every applicable `melian.yaml` merged on top. */
export interface MelianConfig {
	readonly tiers: Readonly<Record<string, readonly string[]>>;
	readonly stages: Readonly<Record<string, string>>;
	readonly resolution: Readonly<Record<Severity, Resolution>>;
	readonly lenses: Readonly<Record<string, LensSettings>>;
	readonly models: Readonly<Partial<Record<LensTier | "decision", ModelRoute>>>;
	readonly knowledge: { readonly writeBack: boolean };
	readonly decisions: { readonly provider?: string; readonly thresholds: Readonly<Record<string, Band>> };
}

/** The built-in defaults every `melian.yaml` layers onto. */
export const defaultConfig: MelianConfig = {
	tiers: {
		fast: ["guardrails", "static", "decisions.fast"],
		standard: ["fast", "lens.correctness"],
		full: ["standard", "lens.security", "lens.contracts", "lens.conventions"],
	},
	stages: { "pre-commit": "fast", "pre-push": "standard", "pull-request": "full", comment: "standard" },
	resolution: { P0: "block", P1: "block", P2: "acknowledge", P3: "advisory", nit: "silent" },
	lenses: {},
	models: {},
	knowledge: { writeBack: false },
	decisions: { thresholds: {} },
};

/**
 * The effective configuration for a path, and the files that contributed to it, nearest first, as repository-relative
 * paths.
 */
export interface LoadedConfig {
	readonly config: MelianConfig;
	readonly sources: readonly string[];
}

/** The largest `melian.yaml` the loader reads. A larger file is a `tooLarge` error, never truncated. */
export const maxConfigBytes = 64 * 1024;

type Plain = Record<string, unknown>;

// A file as `ConfigError.file` names it, and as a message names it: git's `<commit>:<path>` for a revision.
interface Site {
	readonly file: string;
	readonly where: string;
}

function configError(
	code: ConfigErrorCode,
	site: Site,
	detail: string,
	options: { key?: string; cause?: unknown } = {},
): ConfigError {
	return new ConfigError(code, site.file, `${site.where}: ${detail}`, options);
}

function isPlain(value: unknown): value is Plain {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Objects merge key by key; anything else, arrays included, is replaced by the nearer value. Merged objects have no
// prototype, so a lens named `constructor` or `toString` is looked up like any other.
function merge(under: Plain, over: Plain): Plain {
	const merged: Plain = Object.assign(Object.create(null), under);
	for (const [key, value] of Object.entries(over)) {
		const below = merged[key];
		merged[key] = isPlain(below) && isPlain(value) ? merge(below, value) : isPlain(value) ? merge({}, value) : value;
	}
	return merged;
}

// `__proto__` as a key would replace a merged object's prototype wherever a later step copies it.
function rejectReservedKeys(site: Site, value: unknown, path: string[] = []): void {
	if (!isPlain(value)) return;
	for (const [key, child] of Object.entries(value)) {
		const at = [...path, key];
		if (key === "__proto__") {
			throw configError("reservedKey", site, `"${at.join(".")}" uses a reserved key`, { key: at.join(".") });
		}
		rejectReservedKeys(site, child, at);
	}
}

function dotted(instancePath: string): string {
	return instancePath.split("/").slice(1).join(".");
}

function validate(site: Site, value: unknown, schema: TSchema): void {
	const errors = [...Value.Errors(schema, value)];
	const unknown = errors.find((error) => error.keyword === "additionalProperties");
	if (unknown !== undefined) {
		const [key] = (unknown.params as { additionalProperties: string[] }).additionalProperties;
		const path = [dotted(unknown.instancePath), key].filter(Boolean).join(".");
		throw configError("unknownKey", site, `unknown key "${path}"`, { key: path });
	}
	const first = errors[0];
	if (first === undefined) return;
	const path = dotted(first.instancePath);
	const allowed = errors
		.filter((error) => error.instancePath === first.instancePath && error.keyword === "const")
		.map((error) => (error.params as { allowedValue: unknown }).allowedValue);
	const problem = allowed.length > 0 ? `must be one of ${allowed.join(", ")}` : first.message;
	throw configError("invalidValue", site, `"${path || "(top level)"}" ${problem}`, { key: path || undefined });
}

// A source's message already names the file.
function fromSource(file: string) {
	return (error: unknown): never => {
		if (!(error instanceof SourceError)) throw error;
		throw new ConfigError(error.code, file, error.message, { cause: error });
	};
}

async function readLayer(source: SourceReader, site: Site): Promise<MelianYaml | undefined> {
	const text = await source.readText(site.file, maxConfigBytes).catch(fromSource(site.file));
	if (text === undefined) return undefined;
	const document = parseDocument(text);
	const problem = document.errors[0] ?? document.warnings[0];
	if (problem !== undefined) throw configError("invalidYaml", site, problem.message, { cause: problem });
	const value: unknown = document.toJS() ?? {};
	rejectReservedKeys(site, value);
	validate(site, value, melianYamlSchema);
	return anchorLensPaths(posix.dirname(site.file), value as MelianYaml);
}

// A lens's paths are written relative to their melian.yaml; merging would lose which file that was.
function anchorLensPaths(directory: string, layer: MelianYaml): MelianYaml {
	if (layer.lenses === undefined) return layer;
	const anchor = (path: string) => {
		const negated = path.startsWith("!");
		const pattern = (negated ? path.slice(1) : path).replace(/^\/+/, "");
		return `${negated ? "!" : ""}${directory === "." ? pattern : posix.join(directory, pattern)}`;
	};
	const lenses = Object.fromEntries(
		Object.entries(layer.lenses).map(([lens, settings]) => [
			lens,
			settings.paths === undefined ? settings : { ...settings, paths: settings.paths.map(anchor) },
		]),
	);
	return { ...layer, lenses };
}

function checkBands(config: MelianConfig, layers: readonly { site: Site; layer: MelianYaml }[]): void {
	for (const [question, { drop, accept }] of Object.entries(config.decisions.thresholds)) {
		const site = layers.find(({ layer }) => layer.decisions?.thresholds?.[question] !== undefined)!.site;
		const key = `decisions.thresholds.${question}`;
		for (const [end, value] of [
			["drop", drop],
			["accept", accept],
		] as const) {
			if (value === undefined) {
				throw configError("invalidValue", site, `"${key}" sets no ${end}, and no farther file does`, {
					key: `${key}.${end}`,
				});
			}
		}
		if (drop <= accept) continue;
		throw configError(
			"invalidValue",
			site,
			`"${key}" drops above ${drop} but accepts above ${accept}; drop must not exceed accept`,
			{ key },
		);
	}
}

/**
 * Loads the effective configuration for `path`, a file or directory inside the repository at `repoRoot`, reading every
 * `melian.yaml` from `source`: a commit, or the working tree. The host picks the source; for a pull request it passes
 * the base commit, so that the head's changes to policy are reviewed as code and apply once merged.
 *
 * Every `melian.yaml` from the path's directory up to the root applies. The nearest file wins per key: objects merge
 * key by key, and arrays and scalars replace. Lens `paths` are relative to the file that declares them. Throws
 * {@link ConfigError} naming the file for a symlink, a file over {@link maxConfigBytes}, an unreadable file, invalid
 * YAML, an unknown or reserved key, or a bad value; naming the root when it is missing or not a repository; and
 * {@link OutsideRepositoryError} when `path` is outside `repoRoot`.
 */
export async function loadConfig(repoRoot: string, source: RepositorySource, path: string): Promise<LoadedConfig> {
	const target = repoPath(repoRoot, path);
	const reader = await openSource(repoRoot, source).catch(fromSource(repoRoot));
	const kind = await reader.exists(target).catch(fromSource(target));
	const layers: { site: Site; layer: MelianYaml }[] = [];
	for (const directory of directoriesUpToRoot(target, kind === "directory")) {
		const file = posix.join(directory, melianPaths.config);
		const site = { file, where: reader.label(file) };
		const layer = await readLayer(reader, site);
		if (layer !== undefined) layers.push({ site, layer });
	}
	const defaults = merge({}, structuredClone(defaultConfig) as unknown as Plain);
	const config = layers.reduceRight((merged, { layer }) => merge(merged, layer), defaults) as unknown as MelianConfig;
	checkBands(config, layers);
	return { config, sources: layers.map(({ site }) => site.file) };
}

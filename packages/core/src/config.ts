import { readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { parseDocument } from "yaml";
import { ConfigError } from "./errors.ts";
import { directoriesUpToRoot, melianPaths, repoRelative } from "./paths.ts";

const strict = { additionalProperties: false } as const;

const name = Type.String({ minLength: 1 });
const resolutionValue = Type.Union([
	Type.Literal("block"),
	Type.Literal("acknowledge"),
	Type.Literal("advisory"),
	Type.Literal("silent"),
]);
const lensTier = Type.Union([Type.Literal("light"), Type.Literal("medium"), Type.Literal("heavy")]);
const modelRoute = Type.Object({ model: name, fallbacks: Type.Optional(Type.Array(name)) }, strict);
const band = Type.Object(
	{ drop: Type.Number({ minimum: 0, maximum: 1 }), accept: Type.Number({ minimum: 0, maximum: 1 }) },
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
					P0: Type.Optional(resolutionValue),
					P1: Type.Optional(resolutionValue),
					P2: Type.Optional(resolutionValue),
					P3: Type.Optional(resolutionValue),
					nit: Type.Optional(resolutionValue),
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
						tier: Type.Optional(lensTier),
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
export type Resolution = Static<typeof resolutionValue>;

/** A severity in the default rubric. */
export type Severity = "P0" | "P1" | "P2" | "P3" | "nit";

/** A model tier a lens can name. Model routing also has a `decision` tier for decision models. */
export type LensTier = Static<typeof lensTier>;

/** A model and the models to try, in order, when it fails. */
export type ModelRoute = Static<typeof modelRoute>;

/** Per-lens settings. `paths` are repository-relative globs once loaded. */
export interface LensSettings {
	readonly enabled?: boolean;
	readonly tier?: LensTier;
	readonly paths?: readonly string[];
}

/** A decision threshold: below `drop` drops, above `accept` accepts, between escalates to an LLM pass. */
export type Band = Static<typeof band>;

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

/** The effective configuration for a path, and the files that contributed to it, nearest first. */
export interface LoadedConfig {
	readonly config: MelianConfig;
	readonly sources: readonly string[];
}

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Objects merge key by key; anything else, arrays included, is replaced by the nearer value.
function merge(under: Plain, over: Plain): Plain {
	const merged: Plain = { ...under };
	for (const [key, value] of Object.entries(over)) {
		const below = merged[key];
		merged[key] = isPlain(below) && isPlain(value) ? merge(below, value) : value;
	}
	return merged;
}

function dotted(instancePath: string): string {
	return instancePath.split("/").slice(1).join(".");
}

function validate(file: string, value: unknown, schema: TSchema): void {
	const errors = [...Value.Errors(schema, value)];
	const unknown = errors.find((error) => error.keyword === "additionalProperties");
	if (unknown !== undefined) {
		const [key] = (unknown.params as { additionalProperties: string[] }).additionalProperties;
		const path = [dotted(unknown.instancePath), key].filter(Boolean).join(".");
		throw new ConfigError("unknownKey", file, `${file}: unknown key "${path}"`, { key: path });
	}
	const first = errors[0];
	if (first === undefined) return;
	const path = dotted(first.instancePath);
	const allowed = errors
		.filter((error) => error.instancePath === first.instancePath && error.keyword === "const")
		.map((error) => (error.params as { allowedValue: unknown }).allowedValue);
	const problem = allowed.length > 0 ? `must be one of ${allowed.join(", ")}` : first.message;
	throw new ConfigError("invalidValue", file, `${file}: "${path || "(top level)"}" ${problem}`, {
		key: path || undefined,
	});
}

async function readLayer(repoRoot: string, file: string): Promise<MelianYaml | undefined> {
	const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
		throw new ConfigError("unreadable", file, `${file}: ${error.message}`, { cause: error });
	});
	if (text === undefined) return undefined;
	const document = parseDocument(text);
	const problem = document.errors[0] ?? document.warnings[0];
	if (problem !== undefined) {
		throw new ConfigError("invalidYaml", file, `${file}: ${problem.message}`, { cause: problem });
	}
	const value: unknown = document.toJS() ?? {};
	validate(file, value, melianYamlSchema);
	return anchorLensPaths(repoRelative(repoRoot, dirname(file)), value as MelianYaml);
}

// A lens's paths are written relative to their melian.yaml; merging would lose which file that was.
function anchorLensPaths(directory: string, layer: MelianYaml): MelianYaml {
	if (layer.lenses === undefined || directory === "") return layer;
	const lenses = Object.fromEntries(
		Object.entries(layer.lenses).map(([lens, settings]) => [
			lens,
			settings.paths === undefined
				? settings
				: { ...settings, paths: settings.paths.map((path) => posix.join(directory, path.replace(/^\/+/, ""))) },
		]),
	);
	return { ...layer, lenses };
}

function checkBands(config: MelianConfig, layers: readonly { file: string; layer: MelianYaml }[]): void {
	for (const [question, { drop, accept }] of Object.entries(config.decisions.thresholds)) {
		if (drop <= accept) continue;
		const file = layers.find(({ layer }) => layer.decisions?.thresholds?.[question] !== undefined)!.file;
		const key = `decisions.thresholds.${question}`;
		throw new ConfigError(
			"invalidValue",
			file,
			`${file}: "${key}" drops above ${drop} but accepts above ${accept}; drop must not exceed accept`,
			{ key },
		);
	}
}

/**
 * Loads the effective configuration for `path`, a file or directory inside the repository at `repoRoot`.
 *
 * Every `melian.yaml` from the path's directory up to the root applies. The nearest file wins per key: objects merge
 * key by key, and arrays and scalars replace. Lens `paths` are relative to the file that declares them. Throws
 * {@link ConfigError} naming the file for an unreadable file, invalid YAML, an unknown key, or a bad value, and
 * {@link OutsideRepositoryError} when `path` is outside `repoRoot`.
 */
export async function loadConfig(repoRoot: string, path: string): Promise<LoadedConfig> {
	const layers: { file: string; layer: MelianYaml }[] = [];
	for (const directory of await directoriesUpToRoot(repoRoot, path)) {
		const file = join(directory, melianPaths.config);
		const layer = await readLayer(repoRoot, file);
		if (layer !== undefined) layers.push({ file, layer });
	}
	const defaults = structuredClone(defaultConfig) as unknown as Plain;
	const config = layers.reduceRight((merged, { layer }) => merge(merged, layer), defaults) as unknown as MelianConfig;
	checkBands(config, layers);
	return { config, sources: layers.map(({ file }) => file) };
}

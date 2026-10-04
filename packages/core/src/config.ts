import { posix } from "node:path";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { parseDocument } from "yaml";
import { ConfigError, type ConfigErrorCode } from "./errors.ts";
import { anchorGlob, directoriesUpToRoot, melianPaths, repoPath } from "./paths.ts";
import { compileGlob, compilePattern, Refused } from "./pattern.ts";
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

const globs = Type.Array(name, { minItems: 1 });
const staticTool = {
	enabled: Type.Optional(Type.Boolean()),
	timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
	severity: Type.Optional(Type.Record(Type.String(), severitySchema)),
};
// Every field of a rule is optional in one file, so a nearer file can restate one; the merged rule must have them all.
const guardrail = <Rule extends Record<string, TSchema>>(rule: Rule) =>
	Type.Object(
		{
			enabled: Type.Optional(Type.Boolean()),
			severity: Type.Optional(severitySchema),
			rules: Type.Optional(Type.Record(Type.String(), Type.Object(rule, strict))),
		},
		strict,
	);

// A list says the rules are one defect the key owns; `distinct: true` says they are different defects never to merge.
const ruleAliasSchema = Type.Union([
	Type.Array(name),
	Type.Object({ rules: Type.Array(name), distinct: Type.Optional(Type.Boolean()) }, strict),
]);

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
		static: Type.Optional(
			Type.Object(
				{
					biome: Type.Optional(Type.Object(staticTool, strict)),
					tsc: Type.Optional(Type.Object({ ...staticTool, project: Type.Optional(name) }, strict)),
				},
				strict,
			),
		),
		guardrails: Type.Optional(
			Type.Object(
				{
					"forbidden-paths": Type.Optional(
						guardrail({ paths: Type.Optional(globs), message: Type.Optional(name) }),
					),
					"required-files": Type.Optional(
						guardrail({
							when: Type.Optional(globs),
							require: Type.Optional(globs),
							message: Type.Optional(name),
						}),
					),
					"forbidden-patterns": Type.Optional(
						guardrail({
							pattern: Type.Optional(name),
							ignoreCase: Type.Optional(Type.Boolean()),
							paths: Type.Optional(globs),
							message: Type.Optional(name),
						}),
					),
					"policy-change-review": Type.Optional(
						Type.Object(
							{
								enabled: Type.Optional(Type.Boolean()),
								severity: Type.Optional(severitySchema),
								analyserSeverity: Type.Optional(severitySchema),
								files: Type.Optional(globs),
							},
							strict,
						),
					),
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
		ruleAliases: Type.Optional(Type.Record(Type.String(), ruleAliasSchema)),
		checks: Type.Optional(Type.Object({ allowSkip: Type.Optional(Type.Array(name)) }, strict)),
	},
	strict,
);

/** One `melian.yaml` as written. */
export type MelianYaml = Static<typeof melianYamlSchema>;

/** What a finding at a given severity requires before merge. */
export type Resolution = Static<typeof resolutionSchema>;

/** A severity. The rubric is fixed in version one; docs/design.md defers repository-defined rubrics. */
export type Severity = Static<typeof severitySchema>;

/** A model tier a lens can name. Model routing also has a `decision` tier for decision models. */
export type LensTier = Static<typeof lensTierSchema>;

/**
 * One `ruleAliases` entry: the rules other checks file the key's defect under, or, with `distinct: true`, rules that
 * name different defects and must never merge with the key's, even on one expression.
 */
export type RuleAlias = readonly string[] | { readonly rules: readonly string[]; readonly distinct?: boolean };

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

/**
 * How Melian runs one static tool. `timeout` is in seconds. `severity` overrides the default severity of a rule, keyed
 * by its Melian rule ID, such as `biome/suspicious/noDebugger`.
 */
export interface StaticToolSettings {
	readonly enabled: boolean;
	readonly timeout: number;
	readonly severity: Readonly<Record<string, Severity>>;
}

/** How Melian runs tsc. `project` is the tsconfig to check, relative to the repository root. */
export interface TscSettings extends StaticToolSettings {
	readonly project: string;
}

/** The static tools Melian runs, read from the repository root's configuration. */
export interface StaticSettings {
	readonly biome: StaticToolSettings;
	readonly tsc: TscSettings;
}

/** A `forbidden-paths` rule: no change may touch a path matching `paths`, repository-relative globs once loaded. */
export interface ForbiddenPathRule {
	readonly paths: readonly string[];
	readonly message: string;
}

/** A `required-files` rule: a change touching a path matching `when` must also touch a path matching each of `require`. */
export interface RequiredFileRule {
	readonly when: readonly string[];
	readonly require: readonly string[];
	readonly message: string;
}

/**
 * A `forbidden-patterns` rule: no line a change adds, in a file matching `paths`, or in any file when `paths` is absent,
 * may match `pattern`, a regular expression run by a linear-time engine.
 */
export interface ForbiddenPatternRule {
	readonly pattern: string;
	/** Match as RegExp's `i` flag does. */
	readonly ignoreCase?: boolean;
	readonly paths?: readonly string[];
	readonly message: string;
}

/** One guardrail: whether it runs, the severity of its findings, and its named rules. */
export interface Guardrail<Rule> {
	readonly enabled: boolean;
	readonly severity: Severity;
	readonly rules: Readonly<Record<string, Rule>>;
}

/** The deterministic policies Melian evaluates. Each reports under the rule ID `guardrail/<name>`. */
export interface GuardrailSettings {
	readonly "forbidden-paths": Guardrail<ForbiddenPathRule>;
	readonly "required-files": Guardrail<RequiredFileRule>;
	readonly "forbidden-patterns": Guardrail<ForbiddenPatternRule>;
	readonly "policy-change-review": PolicyChangeReview;
}

/**
 * Which policy changes ask for a maintainer's review. `severity` applies to `melian.yaml` and the standards files;
 * `analyserSeverity` to a static tool's configuration, which blocks by default. `files` are repository-relative globs
 * once loaded, more analyser configuration added to the built-in names.
 */
export interface PolicyChangeReview {
	readonly enabled: boolean;
	readonly severity: Severity;
	readonly analyserSeverity: Severity;
	readonly files: readonly string[];
}

/** The effective configuration for one path: built-in defaults with every applicable `melian.yaml` merged on top. */
export interface MelianConfig {
	readonly tiers: Readonly<Record<string, readonly string[]>>;
	readonly stages: Readonly<Record<string, string>>;
	readonly resolution: Readonly<Record<Severity, Resolution>>;
	readonly lenses: Readonly<Record<string, LensSettings>>;
	readonly models: Readonly<Partial<Record<LensTier | "decision", ModelRoute>>>;
	readonly static: StaticSettings;
	readonly guardrails: GuardrailSettings;
	readonly knowledge: { readonly writeBack: boolean };
	readonly decisions: { readonly provider?: string; readonly thresholds: Readonly<Record<string, Band>> };
	/**
	 * Rule ID that owns a defect to the rule IDs other checks report it under, so adjudication keeps the owner's finding;
	 * or, with `distinct: true`, to rule IDs that name other defects, so adjudication never merges them with it.
	 */
	readonly ruleAliases: Readonly<Record<string, RuleAlias>>;
	/** `allowSkip` names checks a tier may skip without making the review not reviewed. */
	readonly checks: { readonly allowSkip: readonly string[] };
}

/** The built-in defaults every `melian.yaml` layers onto. */
export const defaultConfig: MelianConfig = {
	tiers: {
		fast: ["guardrails", "static", "decisions.fast"],
		standard: ["fast", "lens.correctness"],
		full: [
			"standard",
			"lens.contracts",
			"lens.trust-boundary",
			"lens.removed-behaviour",
			"lens.tests",
			"lens.conventions",
		],
	},
	stages: { "pre-commit": "fast", "pre-push": "standard", "pull-request": "full", comment: "standard" },
	resolution: { P0: "block", P1: "block", P2: "acknowledge", P3: "advisory", nit: "silent" },
	lenses: {},
	models: {},
	static: {
		biome: { enabled: true, timeout: 300, severity: {} },
		tsc: { enabled: true, timeout: 300, severity: {}, project: "tsconfig.json" },
	},
	guardrails: {
		"forbidden-paths": { enabled: true, severity: "P1", rules: {} },
		"required-files": { enabled: true, severity: "P2", rules: {} },
		"forbidden-patterns": { enabled: true, severity: "P2", rules: {} },
		"policy-change-review": { enabled: true, severity: "P2", analyserSeverity: "P1", files: [] },
	},
	knowledge: { writeBack: false },
	decisions: { thresholds: {} },
	ruleAliases: {},
	checks: { allowSkip: [] },
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

// YAML's objects inherit from Object.prototype, so `rules.constructor` would be found in every file. Records built
// from YAML have no prototype, and a name is looked up only among the keys a file wrote.
function withoutPrototypes(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutPrototypes);
	if (!isPlain(value)) return value;
	const bare: Plain = Object.create(null);
	for (const [key, child] of Object.entries(value)) bare[key] = withoutPrototypes(child);
	return bare;
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
	// toJS throws a bare ReferenceError when aliases expand past its limit, the defence against a billion-laughs file.
	let value: unknown;
	try {
		value = document.toJS() ?? {};
	} catch (cause) {
		throw configError("invalidYaml", site, (cause as Error).message, { cause });
	}
	rejectReservedKeys(site, value);
	value = withoutPrototypes(value);
	validate(site, value, melianYamlSchema);
	checkPatterns(site, value as MelianYaml);
	checkRequire(site, value as MelianYaml);
	return anchorPaths(site, value as MelianYaml);
}

// Each `require` glob must be matched on its own, so an exclusion there would always count as missing.
function checkRequire(site: Site, layer: MelianYaml): void {
	for (const [rule, { require }] of Object.entries(layer.guardrails?.["required-files"]?.rules ?? {})) {
		const negated = require?.find((glob) => glob.startsWith("!"));
		if (negated === undefined) continue;
		const key = `guardrails.required-files.rules.${rule}.require`;
		throw configError(
			"invalidValue",
			site,
			`"${key}" has ${negated}; each require glob must be touched, so it cannot exclude. Narrow the glob instead`,
			{ key },
		);
	}
}

// A pattern is refused when its file is read, so the error names the file rather than failing a review later.
function checkPatterns(site: Site, layer: MelianYaml): void {
	for (const [rule, { pattern, ignoreCase }] of Object.entries(
		layer.guardrails?.["forbidden-patterns"]?.rules ?? {},
	)) {
		if (pattern === undefined) continue;
		const compiled = compilePattern(pattern, { ignoreCase });
		if (compiled.ok) continue;
		const key = `guardrails.forbidden-patterns.rules.${rule}.pattern`;
		throw configError("invalidValue", site, `"${key}" is not a safe pattern: ${compiled.reason}`, { key });
	}
}

// Every glob list a melian.yaml holds, as a key path; `*` stands for any name.
const globLists: readonly (readonly string[])[] = [
	["lenses", "*", "paths"],
	["guardrails", "forbidden-paths", "rules", "*", "paths"],
	["guardrails", "required-files", "rules", "*", "when"],
	["guardrails", "required-files", "rules", "*", "require"],
	["guardrails", "forbidden-patterns", "rules", "*", "paths"],
	["guardrails", "policy-change-review", "files"],
];

// Globs are written relative to their melian.yaml; merging would lose which file that was.
function anchorPaths(site: Site, layer: MelianYaml): MelianYaml {
	const directory = posix.dirname(site.file);
	const anchor = (key: string, path: string) => {
		// The glob engine reads these literally, so `*.{ts,js}` would silently match nothing.
		if (/[{}[\]]/.test(path)) {
			throw configError(
				"invalidValue",
				site,
				`"${key}" has ${path}; globs do not support braces or character classes, so list each glob`,
				{ key },
			);
		}
		// A gitignore habit: `secrets/` reads as the directory, but a glob matches whole paths, so it would match nothing.
		if (path.endsWith("/")) {
			const suggestion = `${path.replace(/\/+$/, "")}/**`;
			throw configError("invalidValue", site, `"${key}" has ${path}, which matches no file; write ${suggestion}`, {
				key,
			});
		}
		const anchored = anchorGlob(directory, path);
		if (anchored === undefined) {
			throw configError("invalidValue", site, `"${key}" has ${path}, which leaves the repository`, { key });
		}
		try {
			compileGlob(anchored.replace(/^!/, ""));
		} catch (error) {
			if (!(error instanceof Refused)) throw error;
			throw configError("invalidValue", site, `"${key}" has ${path}, which is not a safe glob: ${error.reason}`, {
				key,
			});
		}
		return anchored;
	};
	const rewrite = (value: unknown, keys: readonly string[], at: readonly string[]): unknown => {
		if (keys.length === 0) return (value as string[]).map((glob) => anchor(at.join("."), glob));
		if (!isPlain(value)) return value;
		const [key, ...rest] = keys;
		const copy: Plain = Object.assign(Object.create(null), value);
		for (const name of key === "*" ? Object.keys(copy) : [key!]) {
			if (copy[name] !== undefined) copy[name] = rewrite(copy[name], rest, [...at, name]);
		}
		return copy;
	};
	return globLists.reduce<unknown>((value, keys) => rewrite(value, keys, []), layer) as MelianYaml;
}

const requiredRuleKeys = {
	"forbidden-paths": ["paths", "message"],
	"required-files": ["when", "require", "message"],
	"forbidden-patterns": ["pattern", "message"],
} as const;

function checkGuardrailRules(config: MelianConfig, layers: readonly { site: Site; layer: MelianYaml }[]): void {
	for (const [guardrail, keys] of Object.entries(requiredRuleKeys) as [
		keyof typeof requiredRuleKeys,
		readonly string[],
	][]) {
		for (const [rule, settings] of Object.entries(config.guardrails[guardrail].rules)) {
			const missing = keys.find((key) => (settings as Record<string, unknown>)[key] === undefined);
			if (missing === undefined) continue;
			const site = layers.find(({ layer }) => layer.guardrails?.[guardrail]?.rules?.[rule] !== undefined)!.site;
			const key = `guardrails.${guardrail}.rules.${rule}`;
			throw configError("invalidValue", site, `"${key}" sets no ${missing}, and no farther file does`, {
				key: `${key}.${missing}`,
			});
		}
	}
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
 * The effective configuration for each path a check visits, as {@link configLookup} opens it. Layering depends only
 * on the directory holding the path, so each directory is loaded once, as a directory: a head that turns a directory
 * into a file of the same name must not decide which `melian.yaml` files apply to its neighbours.
 */
export interface ConfigLookup {
	(path: string): Promise<MelianConfig>;
	/** The nearest `melian.yaml` that sets a guardrail's rule for `path`: two files may declare rules of one name. */
	ruleFile(path: string, guardrail: keyof typeof requiredRuleKeys, rule: string): Promise<string>;
	/**
	 * The configuration policy-change-review judges a change to `path` under, and resolves its finding under. A
	 * `melian.yaml` is judged under the directory above its own, so none switches off the review of itself. The root's
	 * has no directory above it: its own settings judge it, and they may make that review stricter than the defaults,
	 * never more lenient.
	 */
	policyReview(path: string): Promise<MelianConfig>;
}

const severityOrder: readonly Severity[] = ["P0", "P1", "P2", "P3", "nit"];

function stricter(left: Severity, right: Severity): Severity {
	return severityOrder.indexOf(left) <= severityOrder.indexOf(right) ? left : right;
}

function withReviewFloor(config: MelianConfig): MelianConfig {
	const own = config.guardrails["policy-change-review"];
	const floor = defaultConfig.guardrails["policy-change-review"];
	const review = {
		...own,
		enabled: true,
		severity: stricter(own.severity, floor.severity),
		analyserSeverity: stricter(own.analyserSeverity, floor.analyserSeverity),
	};
	return { ...config, guardrails: { ...config.guardrails, "policy-change-review": review } };
}

/**
 * A {@link ConfigLookup} reading every `melian.yaml` from `source`, as {@link loadConfig} does. It loads nothing until
 * asked, and throws as {@link loadConfig} does.
 */
export function configLookup(repoRoot: string, source: RepositorySource): ConfigLookup {
	const loaded = new Map<string, Promise<Layered>>();
	let reader: Promise<SourceReader> | undefined;
	const layered = (path: string) => {
		const directory = repoPath(repoRoot, posix.dirname(path));
		let config = loaded.get(directory);
		if (config === undefined) {
			reader ??= openSource(repoRoot, source).catch(fromSource(repoRoot));
			config = reader.then((opened) => loadLayers(opened, directoriesUpToRoot(directory, true), source));
			loaded.set(directory, config);
		}
		return config;
	};
	const lookup = (path: string) => layered(path).then(({ config }) => config);
	lookup.ruleFile = async (path: string, guardrail: keyof typeof requiredRuleKeys, rule: string) => {
		const { layers } = await layered(path);
		return layers.find(({ layer }) => layer.guardrails?.[guardrail]?.rules?.[rule] !== undefined)?.site.file ?? "";
	};
	lookup.policyReview = async (path: string) => {
		if (posix.basename(path) !== melianPaths.config) return lookup(path);
		if (path !== melianPaths.config) return lookup(posix.dirname(path));
		return withReviewFloor(await lookup(path));
	};
	return lookup;
}

type Layered = LoadedConfig & { readonly layers: readonly { site: Site; layer: MelianYaml }[] };

/**
 * Loads the effective configuration for `path`, a file or directory inside the repository at `repoRoot`, reading every
 * `melian.yaml` from `source`: a commit, or the working tree. The host picks the source; for a pull request it passes
 * the base commit, so that the head's changes to policy are reviewed as code and apply once merged.
 *
 * Every `melian.yaml` from the path's directory up to the root applies. The nearest file wins per key: objects merge
 * key by key, and arrays and scalars replace. From the working tree only, `melian.local.yaml` beside the root
 * `melian.yaml` applies last, over every other file. Lens `paths` are relative to the file that declares them. Throws
 * {@link ConfigError} naming the file for a symlink, a file over {@link maxConfigBytes}, an unreadable file, invalid
 * YAML, an unknown or reserved key, or a bad value; naming the root when it is missing or not a repository; and
 * {@link OutsideRepositoryError} when `path` is outside `repoRoot`.
 */
export async function loadConfig(repoRoot: string, source: RepositorySource, path: string): Promise<LoadedConfig> {
	const target = repoPath(repoRoot, path);
	const reader = await openSource(repoRoot, source).catch(fromSource(repoRoot));
	const kind = await reader.exists(target).catch(fromSource(target));
	const { config, sources } = await loadLayers(reader, directoriesUpToRoot(target, kind === "directory"), source);
	return { config, sources };
}

// Every `melian.yaml` in `directories`, nearest first, merged over the defaults. From the working tree, the root's
// `melian.local.yaml` comes first of all: it is the maintainer's own, never a revision's, so a head cannot supply it.
async function loadLayers(
	reader: SourceReader,
	directories: readonly string[],
	source: RepositorySource,
): Promise<Layered> {
	const layers: { site: Site; layer: MelianYaml }[] = [];
	const files = directories.map((directory) => posix.join(directory, melianPaths.config));
	for (const file of source.kind === "worktree" ? [melianPaths.localConfig, ...files] : files) {
		const site = { file, where: reader.label(file) };
		const layer = await readLayer(reader, site);
		if (layer !== undefined) layers.push({ site, layer });
	}
	const defaults = merge({}, structuredClone(defaultConfig) as unknown as Plain);
	const config = layers.reduceRight((merged, { layer }) => merge(merged, layer), defaults) as unknown as MelianConfig;
	checkBands(config, layers);
	checkGuardrailRules(config, layers);
	return { config, sources: layers.map(({ site }) => site.file), layers };
}

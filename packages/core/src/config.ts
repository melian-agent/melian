import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { type Document, isMap, isScalar, parseDocument } from "yaml";
import { ConfigError, type ConfigErrorCode } from "./errors.ts";
import { anchorGlob, directoriesUpToRoot, globShapeProblem, melianPaths, repoPath } from "./paths.ts";
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
const scrutinyLevel = Type.Union([Type.Literal("quick"), Type.Literal("careful"), Type.Literal("deep")]);
// A floor of `skip` lets triage switch the lens off; a ceiling never does. Each end is optional in one file.
const levelBand = Type.Object(
	{ floor: Type.Optional(Type.Union([Type.Literal("skip"), scrutinyLevel])), ceiling: Type.Optional(scrutinyLevel) },
	strict,
);
// `accept`, `unavailable`, and `acceptOverridden` are policy: only a committed melian.yaml may set them.
const modelRoute = Type.Object(
	{
		model: Type.Optional(name),
		fallbacks: Type.Optional(Type.Array(name)),
		accept: Type.Optional(Type.Array(name)),
		unavailable: Type.Optional(Type.Union([Type.Literal("derive"), Type.Literal("fail")])),
		acceptOverridden: Type.Optional(Type.Boolean()),
	},
	strict,
);
/** The keys of a model route that only a committed `melian.yaml` may set. */
export const routePolicyKeys = ["accept", "unavailable", "acceptOverridden"] as const;
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
		trust: Type.Optional(Type.Object({ writers: Type.Optional(Type.Boolean()) }, strict)),
		comparison: Type.Optional(
			Type.Object(
				{
					retirement: Type.Optional(
						Type.Object(
							{
								pullRequests: Type.Optional(Type.Integer({ minimum: 1 })),
								recall: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
							},
							strict,
						),
					),
				},
				strict,
			),
		),
		publish: Type.Optional(
			Type.Object(
				{
					walkthrough: Type.Optional(
						Type.Object(
							{
								enabled: Type.Optional(Type.Boolean()),
								collapsed: Type.Optional(Type.Boolean()),
								diagrams: Type.Optional(Type.Boolean()),
							},
							strict,
						),
					),
				},
				strict,
			),
		),
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
						level: Type.Optional(levelBand),
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
					verifier: Type.Optional(modelRoute),
				},
				strict,
			),
		),
		static: Type.Optional(
			Type.Object(
				{
					biome: Type.Optional(Type.Object(staticTool, strict)),
					enola: Type.Optional(Type.Object(staticTool, strict)),
					mutation: Type.Optional(
						Type.Object({ ...staticTool, maxLines: Type.Optional(Type.Integer({ minimum: 1 })) }, strict),
					),
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
							severity: Type.Optional(severitySchema),
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
		triage: Type.Optional(Type.Object({ escalateAt: Type.Optional(severitySchema) }, strict)),
	},
	strict,
);

/** One `melian.yaml` as written. */
export type MelianYaml = Static<typeof melianYamlSchema>;

/** What a finding at a given severity requires before merge. */
export type Resolution = Static<typeof resolutionSchema>;

/** The resolutions from strictest to most lenient. */
export const resolutionOrder: readonly Resolution[] = ["block", "acknowledge", "advisory", "silent"];

/** A severity. The rubric is fixed in version one; docs/design.md defers repository-defined rubrics. */
export type Severity = Static<typeof severitySchema>;

/** A model tier a lens can name. Model routing also has a `decision` tier for decision models. */
export type LensTier = Static<typeof lensTierSchema>;

/** A tier model routing routes: a lens tier, `decision` for decision models, or `verifier` for the verifier. */
export type ModelTier = LensTier | "decision" | "verifier";

/** Every model tier, in the order Melian prints them. */
export const modelTiers: readonly ModelTier[] = ["light", "medium", "heavy", "decision", "verifier"];

/**
 * One `ruleAliases` entry: the rules other checks file the key's defect under, or, with `distinct: true`, rules that
 * name different defects and must never merge with the key's, even on one expression.
 */
export type RuleAlias = readonly string[] | { readonly rules: readonly string[]; readonly distinct?: boolean };

/**
 * A model and the models to try, in order, when it fails; with `accept`, the models that satisfy the tier, and what to
 * do when none of them has credentials, `unavailable`, `derive` by default. `acceptOverridden: false` refuses a check
 * that would run on the tier outside `accept`.
 */
export type ModelRoute = Static<typeof modelRoute>;

/**
 * The levels triage may choose for a lens on one path: at least `floor` and at most `ceiling`, `quick` and `deep` when
 * left out. Only a floor of `skip` lets triage switch the lens off.
 */
export type LevelBandSettings = Static<typeof levelBand>;

/** Per-lens settings. `paths` are repository-relative globs once loaded. */
export interface LensSettings {
	readonly enabled?: boolean;
	readonly tier?: LensTier;
	readonly paths?: readonly string[];
	readonly level?: LevelBandSettings;
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

/**
 * How Melian runs mutation testing. `maxLines` is the most changed source lines one run will mutate; a change with more
 * has its first `maxLines` lines, in path order, mutated, and a note names the files not reached.
 */
export interface MutationSettings extends StaticToolSettings {
	readonly maxLines: number;
}

/** The static tools Melian runs, read from the repository root's configuration. */
export interface StaticSettings {
	readonly biome: StaticToolSettings;
	readonly enola: StaticToolSettings;
	readonly mutation: MutationSettings;
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
	/** Overrides the guardrail's severity for this rule's findings. */
	readonly severity?: Severity;
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
	readonly trust: { readonly writers: boolean };
	readonly comparison: { readonly retirement: { readonly pullRequests: number; readonly recall: number } };
	readonly publish: {
		readonly walkthrough: { readonly enabled: boolean; readonly collapsed: boolean; readonly diagrams: boolean };
	};
	readonly tiers: Readonly<Record<string, readonly string[]>>;
	readonly stages: Readonly<Record<string, string>>;
	readonly resolution: Readonly<Record<Severity, Resolution>>;
	readonly lenses: Readonly<Record<string, LensSettings>>;
	readonly models: Readonly<Partial<Record<ModelTier, ModelRoute>>>;
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
	/** `escalateAt`: a lens at `quick` that reports a finding this severe or worse runs again at the next level. */
	readonly triage: { readonly escalateAt: Severity };
}

/** The built-in defaults every `melian.yaml` layers onto. */
export const defaultConfig: MelianConfig = {
	trust: { writers: true },
	comparison: { retirement: { pullRequests: 10, recall: 0.75 } },
	publish: { walkthrough: { enabled: true, collapsed: true, diagrams: true } },
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
		enola: { enabled: false, timeout: 300, severity: {} },
		mutation: { enabled: false, timeout: 1800, severity: {}, maxLines: 2000 },
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
	triage: { escalateAt: "P1" },
};

/**
 * Each model tier's route as the committed files alone set it, which is what policy wants, and, for each tier a
 * preference file changed, the nearest such file. A route's `accept`, `unavailable`, and `acceptOverridden` always come
 * from the committed files.
 */
export interface RouteLineage {
	readonly committed: MelianConfig["models"];
	readonly overridden: Readonly<Partial<Record<ModelTier, string>>>;
	/** Each lens tier the committed files set, by lens name; a lens they leave alone runs on its own tier. */
	readonly lensTiers: Readonly<Record<string, LensTier>>;
	/** Each lens a preference file moved to another tier, by name, to the nearest such file. */
	readonly retiered: Readonly<Record<string, string>>;
}

/**
 * The effective configuration for a path, the files that contributed to it, nearest first, as repository-relative
 * paths, a user-level preference file by the path it was given, and where its model routes came from.
 */
export interface LoadedConfig {
	readonly config: MelianConfig;
	readonly sources: readonly string[];
	readonly routes: RouteLineage;
}

/** The largest `melian.yaml` the loader reads. A larger file is a `tooLarge` error, never truncated. */
export const maxConfigBytes = 64 * 1024;

type Plain = Record<string, unknown>;

// A file as `ConfigError.file` names it, and as a message names it: git's `<commit>:<path>` for a revision. A preference
// file is a maintainer's own, read only from the working tree or the user's configuration directory.
export interface Site {
	readonly file: string;
	readonly where: string;
	readonly preference?: boolean;
}

export function configError(
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
	return text === undefined ? undefined : parseLayer(text, site, posix.dirname(site.file));
}

// The user-level preference file lives outside the repository, so it is read from disk, and its globs are anchored at
// the repository root, as if it sat beside the root melian.yaml. A symlink is followed: dotfiles are often linked.
async function readUserLayer(path: string): Promise<MelianYaml | undefined> {
	const site = { file: path, where: path, preference: true };
	const text = await readFile(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
		throw configError("unreadable", site, error.message, { cause: error });
	});
	if (text === undefined) return undefined;
	if (text.length > maxConfigBytes) {
		throw configError("tooLarge", site, `${text.length} bytes; the limit is ${maxConfigBytes}`);
	}
	return parseLayer(text.toString("utf8"), site, "");
}

// YAML text as a value with no prototypes, validated against `schema`, as `melian.yaml` and the secrets files are read.
// With `redact`, a syntax error names only its code, line, and column, and keeps no cause: the parser's diagnostic
// quotes the offending line, which in a secrets file may hold a key.
export function parseYaml(text: string, site: Site, schema: TSchema, options: { redact?: boolean } = {}): unknown {
	const document = parseDocument(text, { prettyErrors: options.redact !== true });
	const problem = document.errors[0] ?? document.warnings[0];
	if (problem !== undefined) {
		if (options.redact !== true) throw configError("invalidYaml", site, problem.message, { cause: problem });
		const before = text.slice(0, problem.pos[0]).split("\n");
		const where = ` at line ${before.length}, column ${before.at(-1)!.length + 1}`;
		throw configError("invalidYaml", site, `YAML error ${problem.code}${where}`);
	}
	// toJS throws a bare ReferenceError when aliases expand past its limit, the defence against a billion-laughs file.
	let value: unknown;
	try {
		value = document.toJS() ?? {};
	} catch (cause) {
		if (options.redact === true) throw configError("invalidYaml", site, "YAML aliases expand past the limit");
		throw configError("invalidYaml", site, (cause as Error).message, { cause });
	}
	if (options.redact === true) {
		validateRedacted(site, value, schema, document, text);
		return withoutPrototypes(value);
	}
	rejectReservedKeys(site, value);
	value = withoutPrototypes(value);
	validate(site, value, schema);
	return value;
}

// `line N, column M` of the node at `path` in a YAML document, or of the key that names it when `key` is set: where a
// redacted error points instead of quoting what is there. Falls back to the deepest node the path reaches.
export function position(document: Document, text: string, path: readonly string[], key = false): string {
	let node: unknown = document.contents;
	let offset = (node as { range?: [number] } | null)?.range?.[0] ?? 0;
	for (const [index, segment] of path.entries()) {
		if (!isMap(node)) break;
		const pair = node.items.find((each) => isScalar(each.key) && String(each.key.value) === segment);
		if (pair === undefined) break;
		const target = index === path.length - 1 && key ? pair.key : (pair.value ?? pair.key);
		offset = (target as { range?: [number] } | null)?.range?.[0] ?? offset;
		node = pair.value;
	}
	const before = text.slice(0, offset).split("\n");
	return `line ${before.length}, column ${before.at(-1)!.length + 1}`;
}

// The checks of `rejectReservedKeys` and `validate`, saying only where the problem is: in a secrets file, a key may be
// a credential pasted where a name belongs, or a line missing its colon that made one key of a field and its value.
function validateRedacted(site: Site, value: unknown, schema: TSchema, document: Document, text: string): void {
	const reserved = (child: unknown, path: string[]): string[] | undefined => {
		if (!isPlain(child)) return undefined;
		for (const [key, grandchild] of Object.entries(child)) {
			if (key === "__proto__") return [...path, key];
			const found = reserved(grandchild, [...path, key]);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	const proto = reserved(value, []);
	if (proto !== undefined) {
		throw configError("reservedKey", site, `a reserved key at ${position(document, text, proto, true)}`);
	}
	const errors = [...Value.Errors(schema, withoutPrototypes(value))];
	const segments = (instancePath: string) =>
		instancePath
			.split("/")
			.slice(1)
			.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
	const unknown = errors.find((error) => error.keyword === "additionalProperties");
	if (unknown !== undefined) {
		const [key] = (unknown.params as { additionalProperties: string[] }).additionalProperties;
		const at = position(document, text, [...segments(unknown.instancePath), key!], true);
		throw configError("unknownKey", site, `an unknown key at ${at}`);
	}
	const first = errors[0];
	if (first === undefined) return;
	const what = first.keyword === "required" ? "a missing field" : "an invalid value";
	throw configError("invalidValue", site, `${what} at ${position(document, text, segments(first.instancePath))}`);
}

function parseLayer(text: string, site: Site, directory: string): MelianYaml {
	const value = parseYaml(text, site, melianYamlSchema);
	checkPatterns(site, value as MelianYaml);
	checkLensNames(site, value as MelianYaml);
	checkRequire(site, value as MelianYaml);
	checkRootOnly(site, value as MelianYaml);
	if (site.preference === true) checkPreference(site, value as MelianYaml);
	else if (site.file !== melianPaths.config) checkNested(site, value as MelianYaml);
	return anchorPaths(site, directory, value as MelianYaml);
}

// The review plan reads routes from the root's configuration alone until it plans per path, so a nested file's route
// policy would never apply: a stricter nested policy would fail open. Refusing it says so where it is written.
function checkNested(site: Site, layer: MelianYaml): void {
	for (const key of ["trust", "comparison"] as const) {
		if (layer[key] !== undefined)
			throw configError("invalidValue", site, `"${key}" is policy, which only a committed root melian.yaml sets`, {
				key,
			});
	}

	for (const [tier, route] of Object.entries(layer.models ?? {})) {
		const key = routePolicyKeys.find((each) => route?.[each] !== undefined);
		if (key === undefined) continue;
		throw configError(
			"invalidValue",
			site,
			`"models.${tier}.${key}" is route policy, which only the root melian.yaml sets until Melian plans routes per path`,
			{ key: `models.${tier}.${key}` },
		);
	}
}

// A route's policy keys decide whether a check ran inside policy, so a preference file setting one could wave its own
// override through.
function checkPreference(site: Site, layer: MelianYaml): void {
	for (const key of ["trust", "comparison"] as const) {
		if (layer[key] !== undefined)
			throw configError("invalidValue", site, `"${key}" is policy, which only a committed root melian.yaml sets`, {
				key,
			});
	}

	for (const [tier, route] of Object.entries(layer.models ?? {})) {
		const key = routePolicyKeys.find((each) => route?.[each] !== undefined);
		if (key === undefined) continue;
		throw configError(
			"invalidValue",
			site,
			`"models.${tier}.${key}" is policy, which only a committed melian.yaml sets; a preference file may set model and fallbacks`,
			{ key: `models.${tier}.${key}` },
		);
	}
}

// A review reads `triage` from the root's configuration alone, so a nested file setting it would be silently ignored. A
// preference file layers over the root's, so it may.
function checkRootOnly(site: Site, layer: MelianYaml): void {
	if (layer.triage === undefined || site.preference === true || site.file === melianPaths.config) return;
	throw configError(
		"invalidValue",
		site,
		`"triage" applies to the whole review, so only the root melian.yaml may set it; move it there`,
		{ key: "triage" },
	);
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

// Triage's question ID is the lens name, and the decision tool's schema bounds an ID; the schema's Record does not
// check key length.
const maxLensName = 128;

function checkLensNames(site: Site, layer: MelianYaml): void {
	for (const name of Object.keys(layer.lenses ?? {})) {
		if (name.length <= maxLensName) continue;
		throw configError("invalidValue", site, `"lenses" names a lens of more than ${maxLensName} characters`, {
			key: "lenses",
		});
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
function anchorPaths(site: Site, directory: string, layer: MelianYaml): MelianYaml {
	const anchor = (key: string, path: string) => {
		const shape = globShapeProblem(path);
		if (shape !== undefined) throw configError("invalidValue", site, `"${key}" has ${path}${shape}`, { key });
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

// `model` is optional so a preference file can restate only `fallbacks`, but a merged route with fallbacks and neither a
// model nor an accept would drop them without a word.
function checkFallbacks(models: MelianConfig["models"], layers: readonly { site: Site; layer: MelianYaml }[]): void {
	for (const tier of modelTiers) {
		const route = models[tier];
		if (route?.fallbacks === undefined || route.model !== undefined || (route.accept?.length ?? 0) > 0) continue;
		const site = layers.find(({ layer }) => layer.models?.[tier]?.fallbacks !== undefined)!.site;
		const key = `models.${tier}.model`;
		throw configError(
			"invalidValue",
			site,
			`"models.${tier}.fallbacks" has no model to follow; set "${key}", or accept, which a committed melian.yaml sets`,
			{ key },
		);
	}
}

// A route that refuses every model outside accept, and accepts none, would fail every check on its tier whatever the
// maintainer holds, so it is a mistake in the file rather than a policy.
function checkRefusals(models: MelianConfig["models"], layers: readonly { site: Site; layer: MelianYaml }[]): void {
	for (const tier of modelTiers) {
		const route = models[tier];
		// An empty accept would accept nothing, and the plan would read it as no accept at all, so a route that refuses
		// overrides would refuse none of them.
		if (route?.accept !== undefined && route.accept.length === 0) {
			const site = layers.find(({ layer }) => layer.models?.[tier]?.accept !== undefined)!.site;
			const key = `models.${tier}.accept`;
			throw configError(
				"invalidValue",
				site,
				`"${key}" lists no model; list the models that satisfy the tier, or leave it out to accept the route's own model and fallbacks`,
				{ key },
			);
		}
		if (route?.acceptOverridden !== false || route.model !== undefined || (route.accept?.length ?? 0) > 0) continue;
		const site = layers.find(({ layer }) => layer.models?.[tier]?.acceptOverridden !== undefined)!.site;
		const key = `models.${tier}.acceptOverridden`;
		throw configError(
			"invalidValue",
			site,
			`"${key}" is false, but models.${tier} names no model and no accept, so no model could run; set models.${tier}.model or models.${tier}.accept`,
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

export function stricter(left: Severity, right: Severity): Severity {
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
 * key by key, and arrays and scalars replace. From the working tree only, the preference files apply over every
 * committed file: `melian.local.yaml` beside the root `melian.yaml` last of all, and under it the user-level file the
 * source names in `preferences`. Neither may set a route's policy keys. Lens `paths` are relative to the file that
 * declares them, and to the root for the user-level file. Throws {@link ConfigError} naming the file for a symlink, a
 * file over {@link maxConfigBytes}, an unreadable file, invalid YAML, an unknown or reserved key, or a bad value;
 * naming the root when it is missing or not a repository; and {@link OutsideRepositoryError} when `path` is outside
 * `repoRoot`.
 */
export async function loadConfig(repoRoot: string, source: RepositorySource, path: string): Promise<LoadedConfig> {
	const target = repoPath(repoRoot, path);
	const reader = await openSource(repoRoot, source).catch(fromSource(repoRoot));
	const kind = await reader.exists(target).catch(fromSource(target));
	const { config, sources, routes } = await loadLayers(
		reader,
		directoriesUpToRoot(target, kind === "directory"),
		source,
	);
	return { config, sources, routes };
}

// Every `melian.yaml` in `directories`, nearest first, merged over the defaults. From the working tree, the preference
// files come first of all: the root's `melian.local.yaml`, then the user-level file. They are the maintainer's own,
// never a revision's, so a head cannot supply them.
async function loadLayers(
	reader: SourceReader,
	directories: readonly string[],
	source: RepositorySource,
): Promise<Layered> {
	const layers: { site: Site; layer: MelianYaml }[] = [];
	const files = directories.map((directory) => posix.join(directory, melianPaths.config));
	const worktree = source.kind === "worktree";
	for (const file of worktree ? [melianPaths.localConfig] : []) {
		const site = { file, where: reader.label(file), preference: true };
		const layer = await readLayer(reader, site);
		if (layer !== undefined) layers.push({ site, layer });
	}
	if (worktree && source.preferences !== undefined) {
		const layer = await readUserLayer(source.preferences);
		if (layer !== undefined) layers.push({ site: { file: source.preferences, where: source.preferences }, layer });
	}
	const preferences = layers.length;
	for (const file of files) {
		const site = { file, where: reader.label(file) };
		const layer = await readLayer(reader, site);
		if (layer !== undefined) layers.push({ site, layer });
	}
	const defaults = merge({}, structuredClone(defaultConfig) as unknown as Plain);
	const config = layers.reduceRight((merged, { layer }) => merge(merged, layer), defaults) as unknown as MelianConfig;
	checkBands(config, layers);
	checkGuardrailRules(config, layers);
	const committed = layers
		.slice(preferences)
		.reduceRight(
			(merged, { layer }) => merge(merged, { models: layer.models ?? {}, lenses: layer.lenses ?? {} }),
			merge({}, { models: {}, lenses: {} }),
		);
	checkRefusals(committed.models as MelianConfig["models"], layers.slice(preferences));
	checkFallbacks(config.models, layers);
	const lensTiers: Record<string, LensTier> = {};
	for (const [name, settings] of Object.entries(committed.lenses as MelianConfig["lenses"])) {
		if (settings.tier !== undefined) lensTiers[name] = settings.tier;
	}
	const retiered: Record<string, string> = {};
	for (const { site, layer } of layers.slice(0, preferences).reverse()) {
		for (const [name, settings] of Object.entries(layer.lenses ?? {})) {
			if (settings?.tier !== undefined) retiered[name] = site.file;
		}
	}
	const overridden: Partial<Record<ModelTier, string>> = {};
	for (const tier of modelTiers) {
		const nearest = layers
			.slice(0, preferences)
			.find(
				({ layer }) => layer.models?.[tier]?.model !== undefined || layer.models?.[tier]?.fallbacks !== undefined,
			);
		if (nearest !== undefined) overridden[tier] = nearest.site.file;
	}
	const routes = { committed: committed.models as MelianConfig["models"], overridden, lensTiers, retiered };
	return { config, sources: layers.map(({ site }) => site.file), routes, layers };
}

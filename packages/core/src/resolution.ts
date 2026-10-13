import {
	defaultConfig,
	type FileResolution,
	type Resolution,
	type ResolutionEntry,
	type ResolutionLayer,
	resolutionOrder,
	type Severity,
} from "./config.ts";

/**
 * What resolution reads at one path: the merged severity table with its `preExisting` cap, each file's own layer,
 * nearest first, and each lens's declared default by lens name. Without `layers`, `resolution` stands for one file
 * that wrote all of it, as a caller with one configuration for every path passes it.
 */
export interface ResolutionSource {
	readonly resolution: FileResolution;
	readonly layers?: readonly ResolutionLayer[];
	readonly lensDefaults?: Readonly<Record<string, ResolutionEntry>>;
}

/**
 * One report as the walk reads it: its check, as a tier spells it, its severity, and the keys it is looked up under in
 * the check's `rules`. `rule` is the rule-level key: a finding's rule ID, or `guardrail/<name>/<rule>` for one
 * configured guardrail rule. `group` is `guardrail/<name>`, a check-level entry for every finding of that guardrail.
 * `tableOnly` leaves every `checks` entry out, for a notice no entry may move.
 */
export interface ResolutionClaim {
	readonly check: string;
	readonly rule?: string;
	readonly group?: string;
	readonly severity: Severity;
	readonly tableOnly?: boolean;
}

/** Where a requirement came from: an entry of the file that spoke, a lens's declared default, or the built-in table. */
export type RequirementEntry = "rule" | "check" | "table" | "lens-default" | "built-in";

/** Where a ceiling came from. */
export type CeilingEntry = "rule" | "check" | "lens-default";

/**
 * What decided a claim: the file that spoke, when one did, the entry its requirement came from, and the entry of the
 * ceiling in force, when one was. `key` is the dotted key in that file, or in the lens's front matter.
 */
export interface WalkDecision {
	readonly resolution: Resolution;
	readonly file?: string;
	readonly lens?: string;
	readonly requirement: { readonly entry: RequirementEntry; readonly key?: string; readonly value: Resolution };
	readonly ceiling?: { readonly entry: CeilingEntry; readonly key: string; readonly value: Resolution };
}

const severities: readonly Severity[] = ["P0", "P1", "P2", "P3", "nit"];

// The more lenient of two resolutions.
export function lesser(left: Resolution, right: Resolution): Resolution {
	return resolutionOrder.indexOf(left) >= resolutionOrder.indexOf(right) ? left : right;
}

interface Entry {
	readonly entry: "rule" | "check";
	readonly key: string;
	readonly value: ResolutionEntry;
}

// The entries of one file that are about `claim`, most specific first: its rule, its whole guardrail, its check.
function entriesFor(resolution: FileResolution, { check, rule, group, tableOnly }: ResolutionClaim): Entry[] {
	const own = tableOnly === true ? undefined : resolution.checks?.[check];
	if (own === undefined) return [];
	const key = `resolution.checks.${check}`;
	const named = (name: string | undefined, entry: Entry["entry"]): Entry[] => {
		const value = name === undefined ? undefined : own.rules?.[name];
		return value === undefined ? [] : [{ entry, key: `${key}.rules.${name}`, value }];
	};
	return [...named(rule, "rule"), ...named(group, "check"), { entry: "check", key, value: own }];
}

// A layer read from a file has no prototype, so a check or lens named `constructor` finds nothing. One built in code
// finds Object's own member there, which maps no severity and sets no ceiling, and so says nothing.
/**
 * The walk that resolves a claim at one path: from the nearest file to the root, stopping at the first file that speaks
 * about it. A file speaks through a mapping for the claim's severity, in a rule entry, a check entry, or its own table,
 * or through a ceiling on the rule or check. That file decides the whole result. What it leaves out comes from the
 * built-in table, never from a farther file. When no file speaks, the lens's declared default applies, then the
 * built-in table.
 */
export class ResolutionWalk {
	readonly layers: readonly ResolutionLayer[];
	readonly lensDefaults: Readonly<Record<string, ResolutionEntry>>;

	constructor(layers: readonly ResolutionLayer[], lensDefaults: Readonly<Record<string, ResolutionEntry>> = {}) {
		this.layers = layers;
		this.lensDefaults = lensDefaults;
	}

	/** The walk over what `source` holds. */
	static over(source: ResolutionSource): ResolutionWalk {
		return new ResolutionWalk(source.layers ?? [{ file: "", resolution: source.resolution }], source.lensDefaults);
	}

	/** What `claim` requires, the lesser of its requirement and its ceiling, and which file and entries decided. */
	decide(claim: ResolutionClaim): WalkDecision {
		const { severity, check } = claim;
		const builtIn = { entry: "built-in" as const, value: defaultConfig.resolution[severity] };
		for (const { file, resolution } of this.layers) {
			const entries = entriesFor(resolution, claim);
			const mapped = entries.find(({ value }) => value[severity] !== undefined);
			const capped = entries.find(({ value }) => value.ceiling !== undefined);
			const table = resolution[severity];
			if (mapped === undefined && capped === undefined && table === undefined) continue;
			const requirement =
				mapped !== undefined
					? { entry: mapped.entry, key: `${mapped.key}.${severity}`, value: mapped.value[severity]! }
					: table !== undefined
						? { entry: "table" as const, key: `resolution.${severity}`, value: table }
						: builtIn;
			const ceiling =
				capped === undefined
					? undefined
					: { entry: capped.entry, key: `${capped.key}.ceiling`, value: capped.value.ceiling! };
			return {
				resolution: ceiling === undefined ? requirement.value : lesser(requirement.value, ceiling.value),
				...(file === "" ? {} : { file }),
				requirement,
				...(ceiling === undefined ? {} : { ceiling }),
			};
		}
		const lens = check.startsWith("lens.") ? check.slice("lens.".length) : undefined;
		const declared = lens === undefined ? undefined : this.lensDefaults[lens];
		const mapped = declared?.[severity];
		const requirement =
			mapped === undefined
				? builtIn
				: { entry: "lens-default" as const, key: `resolution.${severity}`, value: mapped };
		const ceiling =
			declared?.ceiling === undefined
				? undefined
				: { entry: "lens-default" as const, key: "resolution.ceiling", value: declared.ceiling };
		// A lens whose default says nothing about this severity has not decided it.
		if (mapped === undefined && ceiling === undefined) return { resolution: builtIn.value, requirement: builtIn };
		return {
			resolution: ceiling === undefined ? requirement.value : lesser(requirement.value, ceiling.value),
			lens,
			requirement,
			...(ceiling === undefined ? {} : { ceiling }),
		};
	}

	/**
	 * What each file on the walk now overrides, one sentence each, for `melian doctor`: every value of a farther file,
	 * and every lens default, that would have applied to some finding had the file not spoken. A value the file restates
	 * in an entry of its own is not listed. A file that speaks only through a ceiling drops the farther table's value
	 * for that check, and is listed for it.
	 */
	overrides(): string[] {
		return this.layers.flatMap((layer, index) => {
			const farther = new ResolutionWalk(this.layers.slice(index + 1), this.lensDefaults);
			const here = new ResolutionWalk(this.layers.slice(index), this.lensDefaults);
			const found = new Map<string, Overridden>();
			for (const probe of this.#probes()) {
				const now = here.decide(probe);
				if (now.file !== layer.file) continue;
				const before = farther.decide(probe);
				const speaks = now.requirement.entry === "built-in" ? now.ceiling!.key : now.requirement.key!;
				const dropped = [
					...(before.requirement.entry === "built-in" || restates(now.requirement, before.requirement)
						? []
						: [{ ...before.requirement, role: "mapping" as const }]),
					...(before.ceiling === undefined || restates(now.ceiling, before.ceiling)
						? []
						: [{ ...before.ceiling, role: "ceiling" as const }]),
				];
				for (const { role, key: written } of dropped) {
					const what =
						before.file === undefined
							? `lens ${before.lens}'s declared ${role}`
							: role === "ceiling"
								? `${before.file}'s ${written}`
								: written === `resolution.${probe.severity}`
									? `${before.file}'s table`
									: `${before.file}'s ${written!.slice(0, written!.lastIndexOf("."))}`;
					const scope = [probe.check, probe.rule ?? probe.group ?? ""] as const;
					const key = JSON.stringify([speaks, what, ...scope]);
					const line = found.get(key) ?? { speaks, what, scope, severities: [] };
					found.set(key, { ...line, severities: [...line.severities, probe.severity] });
				}
			}
			return narrowed([...found.values()]).map((each) => describe(layer.file, each));
		});
	}

	// One claim for every check and rule any layer or lens default names, at every severity, and one for a check and a
	// rule none of them names, so a table's reach over everything else is probed too.
	#probes(): ResolutionClaim[] {
		const rulesOf = new Map<string, Set<string>>([[anyCheck, new Set()]]);
		for (const lens of Object.keys(this.lensDefaults)) rulesOf.set(`lens.${lens}`, new Set());
		for (const { resolution } of this.layers) {
			for (const [check, entry] of Object.entries(resolution.checks ?? {})) {
				const rules = rulesOf.get(check) ?? new Set();
				for (const rule of Object.keys(entry.rules ?? {})) rules.add(rule);
				rulesOf.set(check, rules);
			}
		}
		return [...rulesOf].flatMap(([check, rules]) =>
			[undefined, ...rules].flatMap((name) =>
				severities.map((severity) => ({ check, severity, ...probeKeys(check, name) })),
			),
		);
	}
}

// A check name no file can write, standing for every check the walk's files do not name.
const anyCheck = "*";

// A key under `guardrails.rules` is also probed under the guardrail its first two segments name: for a whole
// guardrail's key that is the key itself.
function probeKeys(check: string, name: string | undefined): Pick<ResolutionClaim, "rule" | "group"> {
	if (name === undefined) return {};
	if (check !== "guardrails") return { rule: name };
	return { rule: name, group: name.split("/").slice(0, 2).join("/") };
}

type Sourced = { readonly entry: string; readonly value: Resolution } | undefined;

// Whether the nearer file says, in an entry of its own, what the farther value said.
function restates(now: Sourced, before: NonNullable<Sourced>): boolean {
	return now !== undefined && now.entry !== "built-in" && now.value === before.value;
}

interface Overridden {
	readonly speaks: string;
	readonly what: string;
	readonly scope: readonly [check: string, rule: string];
	readonly severities: readonly Severity[];
}

// A line about every check covers each named check it also holds for; one about a check covers its rules; and one
// about a whole guardrail covers that guardrail's named rules.
function narrowed(lines: readonly Overridden[]): Overridden[] {
	const within = ([wideCheck, wideRule]: Overridden["scope"], [check, rule]: Overridden["scope"]) =>
		wideCheck === anyCheck ? check !== anyCheck : rule !== "" && (wideRule === "" || rule.startsWith(`${wideRule}/`));
	const covers = (wide: Overridden, narrow: Overridden) =>
		wide.speaks === narrow.speaks && wide.what === narrow.what && within(wide.scope, narrow.scope);
	return lines.filter((line) => !lines.some((other) => covers(other, line)));
}

function describe(file: string, { speaks, what, scope: [check, rule], severities }: Overridden): string {
	const about = check === anyCheck ? "" : ` ${check}${rule === "" ? "" : ` ${rule}`}`;
	return `${file}: ${speaks} overrides ${what} for ${severities.join(", ")}${about} findings`;
}

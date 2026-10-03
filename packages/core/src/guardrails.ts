import type { Revision } from "./changeset.ts";
import { configLookup, type MelianConfig, type Severity } from "./config.ts";
import type { ChangedFile } from "./diff.ts";
import { CheckError } from "./errors.ts";
import {
	createFinding,
	type Finding,
	type FindingExplanation,
	type FindingTrigger,
	normaliseSnippet,
	snippetOccurrence,
} from "./findings.ts";
import { compilePattern, type LinearPattern, matchesGlobs } from "./pattern.ts";
import { openSource, type RepositorySource, SourceError, type SourceReader } from "./source.ts";

/** The guardrails version one ships, each reporting under the rule ID `guardrail/<name>`. */
export type GuardrailName = "forbidden-paths" | "required-files" | "forbidden-patterns" | "policy-change-review";

/** What one check produced: its findings, and anything it could not look at, said in a sentence each. */
export interface CheckReport {
	readonly findings: readonly Finding[];
	readonly notes: readonly string[];
}

/** What {@link evaluateGuardrails} reads. */
export interface GuardrailInput {
	readonly repoRoot: string;
	readonly revision: Revision;
	/** Where `melian.yaml` is read from, as for `loadConfig`: the base commit for a pull request. */
	readonly source: RepositorySource;
}

/** Limits on what forbidden-patterns reads at head. Past either, a line or file is not scanned, and a note says so. */
export const guardrailLimits = { lineLength: 10_000, fileBytes: 4 * 1024 * 1024 } as const;

const check = "guardrails";

interface Hit {
	readonly guardrail: GuardrailName;
	readonly file: string;
	readonly line: number;
	readonly snippet?: string;
	readonly occurrence?: number;
	readonly discriminator?: string;
	readonly trigger?: FindingTrigger;
	readonly config: MelianConfig;
	readonly severity: Severity;
	readonly message: string;
	readonly explanation: FindingExplanation;
}

function finding(hit: Hit): Finding {
	return createFinding({
		rule: `guardrail/${hit.guardrail}`,
		message: hit.message,
		file: hit.file,
		startLine: hit.line,
		snippet: hit.snippet,
		occurrence: hit.occurrence,
		discriminator: hit.discriminator,
		// Guardrails judge the change itself, so whatever they report, the change introduced.
		cause: "introduced",
		trigger: hit.trigger,
		severity: hit.severity,
		resolution: hit.config.resolution[hit.severity],
		explanation: hit.explanation,
		source: { check },
	});
}

function touchedPaths(files: readonly ChangedFile[]): string[] {
	return [
		...new Set(files.flatMap((file) => (file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]))),
	].sort();
}

function sentences(messages: readonly string[]): string {
	return messages.map((message) => (/[.!?]$/.test(message) ? message : `${message}.`)).join(" ");
}

async function forbiddenPaths(
	paths: readonly string[],
	configFor: (path: string) => Promise<MelianConfig>,
): Promise<Hit[]> {
	const hits: Hit[] = [];
	for (const path of paths) {
		const config = await configFor(path);
		const guardrail = config.guardrails["forbidden-paths"];
		if (!guardrail.enabled) continue;
		const matched = Object.entries(guardrail.rules).filter(([, rule]) => matchesGlobs(rule.paths, path));
		if (matched.length === 0) continue;
		const names = matched.map(([name]) => name).join(", ");
		const messages = matched.map(([, rule]) => rule.message);
		hits.push({
			guardrail: "forbidden-paths",
			file: path,
			line: 1,
			discriminator: "path",
			config,
			severity: guardrail.severity,
			message: sentences(messages),
			explanation: {
				what: `This change touches ${path}, which the forbidden-paths rule ${names} forbids.`,
				whyHere: sentences(messages),
				whatToDo: "Undo the change to this path, or change the rule in its own pull request.",
			},
		});
	}
	return hits;
}

async function requiredFiles(
	paths: readonly string[],
	configFor: (path: string) => Promise<MelianConfig>,
): Promise<Hit[]> {
	const hits = new Map<string, Hit>();
	for (const path of paths) {
		const config = await configFor(path);
		const guardrail = config.guardrails["required-files"];
		if (!guardrail.enabled) continue;
		for (const [name, rule] of Object.entries(guardrail.rules)) {
			if (hits.has(name) || !matchesGlobs(rule.when, path)) continue;
			const missing = rule.require.filter((glob) => !paths.some((each) => matchesGlobs([glob], each)));
			if (missing.length === 0) continue;
			hits.set(name, {
				guardrail: "required-files",
				file: path,
				line: 1,
				discriminator: name,
				config,
				severity: guardrail.severity,
				message: sentences([rule.message]),
				explanation: {
					what: `This change touches ${path} but nothing matching ${missing.join(", ")}, which the required-files rule ${name} requires.`,
					whyHere: sentences([rule.message]),
					whatToDo: `Change ${missing.join(" and ")} in this pull request too.`,
				},
			});
		}
	}
	return [...hits.values()];
}

function policyChanges(revision: Revision, configFor: (path: string) => Promise<MelianConfig>): Promise<Hit[]> {
	return Promise.all(
		revision.policyFiles.map(async (path): Promise<Hit | undefined> => {
			const config = await configFor(path);
			const guardrail = config.guardrails["policy-change-review"];
			if (!guardrail.enabled) return undefined;
			return {
				guardrail: "policy-change-review",
				file: path,
				line: 1,
				discriminator: "policy",
				config,
				severity: guardrail.severity,
				message: "Review policy and standards changed in this revision.",
				explanation: {
					what: `This revision changes ${path}, which steers how Melian reviews this repository.`,
					whyHere:
						"Melian reviewed the revision under the policy and standards it changes, so nothing it ran judged the new ones.",
					whatToDo: `Have a maintainer read the change to ${path} before merging.`,
				},
			};
		}),
	).then((hits) => hits.filter((hit) => hit !== undefined));
}

// The added lines of a hunk, with their line numbers at head.
function addedLines(text: string, newStart: number): { line: number; text: string }[] {
	const added: { line: number; text: string }[] = [];
	let line = newStart;
	for (const row of text.split("\n")) {
		if (!row.startsWith("+")) continue;
		added.push({ line, text: row.slice(1) });
		line++;
	}
	return added;
}

async function headText(reader: SourceReader, path: string): Promise<string | undefined> {
	try {
		return await reader.readText(path, guardrailLimits.fileBytes);
	} catch (error) {
		if (!(error instanceof SourceError)) throw error;
		if (error.code === "tooLarge") return undefined;
		throw new CheckError("unreadable", check, error.message, { cause: error });
	}
}

async function forbiddenPatterns(
	input: GuardrailInput,
	configFor: (path: string) => Promise<MelianConfig>,
	notes: string[],
): Promise<Hit[]> {
	const compiled = new Map<string, LinearPattern>();
	const patternFor = (source: string) => {
		let pattern = compiled.get(source);
		if (pattern === undefined) {
			// loadConfig refused every pattern that does not compile when it read the file.
			pattern = (compilePattern(source) as Extract<ReturnType<typeof compilePattern>, { ok: true }>).pattern;
			compiled.set(source, pattern);
		}
		return pattern;
	};
	const hits: Hit[] = [];
	let reader: SourceReader | undefined;
	for (const file of input.revision.files) {
		if (file.status === "deleted" || file.hunks.length === 0) continue;
		if (file.newKind !== "file" && file.newKind !== "executable") continue;
		const config = await configFor(file.path);
		const guardrail = config.guardrails["forbidden-patterns"];
		const rules = Object.entries(guardrail.rules).filter(
			([, rule]) => rule.paths === undefined || matchesGlobs(rule.paths, file.path),
		);
		if (!guardrail.enabled || rules.length === 0) continue;
		if (file.percentEncoded) {
			notes.push(`forbidden-patterns did not scan ${file.path}, whose name is not UTF-8.`);
			continue;
		}
		let skipped = 0;
		const matches = file.hunks.flatMap((hunk) =>
			addedLines(hunk.text, hunk.newStart).flatMap((added) => {
				if (added.text.length > guardrailLimits.lineLength) {
					skipped++;
					return [];
				}
				const matched = rules.filter(([, rule]) => patternFor(rule.pattern).test(added.text));
				return matched.length === 0 ? [] : [{ hunk, added, matched }];
			}),
		);
		if (skipped > 0) {
			notes.push(
				`forbidden-patterns did not scan ${skipped} line(s) of ${file.path} longer than ${guardrailLimits.lineLength} characters.`,
			);
		}
		if (matches.length === 0) continue;
		reader ??= await openSource(input.repoRoot, { kind: "revision", commit: input.revision.head });
		// A file too large to read whole is still reported, identified by line number instead of by its code.
		const text = await headText(reader, file.path);
		for (const { hunk, added, matched } of matches) {
			const byCode = text !== undefined && normaliseSnippet(added.text) !== "";
			const messages = matched.map(([, rule]) => rule.message);
			hits.push({
				guardrail: "forbidden-patterns",
				file: file.path,
				line: added.line,
				snippet: byCode ? added.text : undefined,
				occurrence: byCode ? snippetOccurrence(text, added.text, { startLine: added.line }) : undefined,
				discriminator: byCode ? undefined : `line ${added.line}`,
				trigger: { file: file.path, index: hunk.index, snippet: added.text },
				config,
				severity: guardrail.severity,
				message: sentences(messages),
				explanation: {
					what: `This line matches the forbidden-patterns rule ${matched.map(([name]) => name).join(", ")}.`,
					whyHere: sentences(messages),
					whatToDo: "Rewrite the line so it no longer matches.",
				},
			});
		}
	}
	return hits;
}

/**
 * Evaluates the guardrails on a revision, in the Melian process and without running any of the repository's code.
 * Each path's guardrails come from its own layered `melian.yaml`, read from `source`; forbidden-patterns also reads the
 * changed files at head through git's object store, to place each finding.
 *
 * - `forbidden-paths`: a touched path, on either side of a rename, matches a rule's `paths`.
 * - `required-files`: a touched path matches a rule's `when`, and no touched path matches one of its `require`.
 * - `forbidden-patterns`: an added line matches a rule's pattern, run by a linear-time engine.
 * - `policy-change-review`: the revision changes a policy or standards file, one of `revision.policyFiles`.
 *
 * Every finding is `introduced`. Several rules of one guardrail that fire on one path or line give one finding. Throws
 * `ConfigError` when a `melian.yaml` cannot be loaded, and {@link CheckError} `unreadable` when a file at head cannot be read.
 */
export async function evaluateGuardrails(input: GuardrailInput): Promise<CheckReport> {
	const configFor = configLookup(input.repoRoot, input.source);
	const paths = touchedPaths(input.revision.files);
	const notes: string[] = [];
	const hits = [
		...(await forbiddenPaths(paths, configFor)),
		...(await requiredFiles(paths, configFor)),
		...(await forbiddenPatterns(input, configFor, notes)),
		...(await policyChanges(input.revision, configFor)),
	];
	return { findings: hits.map(finding), notes };
}

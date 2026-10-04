import { analyserOf, switchOffs } from "./analyser.ts";
import type { Revision } from "./changeset.ts";
import {
	type ConfigLookup,
	configLookup,
	type ForbiddenPatternRule,
	type MelianConfig,
	type Severity,
} from "./config.ts";
import type { ChangedFile, Hunk } from "./diff.ts";
import { CheckError } from "./errors.ts";
import {
	createFinding,
	type Finding,
	type FindingExplanation,
	type FindingTrigger,
	normaliseSnippet,
	snippetOccurrence,
} from "./findings.ts";
import { git } from "./git.ts";
import { compileGlob, compilePattern, type LinearPattern, matchesGlobs, Refused } from "./pattern.ts";
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

/**
 * Limits on what forbidden-patterns reads at head: `fileBytes` for a file read whole, and `scanBytes` for the lines it
 * scans in one file. What a limit stops it scanning is reported as a finding, never passed over.
 */
export const guardrailLimits = { fileBytes: 4 * 1024 * 1024, scanBytes: 4 * 1024 * 1024 } as const;

const check = "guardrails";

interface Hit {
	readonly guardrail: GuardrailName;
	readonly file: string;
	readonly line: number;
	readonly snippet?: string;
	readonly occurrence?: number;
	readonly discriminator?: string;
	readonly trigger?: FindingTrigger;
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

// One finding per rule, a rule being its name and the file that declares it: two services may each have a rule of
// one name, and neither may hide the other.
async function requiredFiles(paths: readonly string[], configFor: ConfigLookup): Promise<Hit[]> {
	const hits = new Map<string, Hit>();
	const judged = new Set<string>();
	for (const path of paths) {
		const config = await configFor(path);
		const guardrail = config.guardrails["required-files"];
		if (!guardrail.enabled) continue;
		for (const [name, rule] of Object.entries(guardrail.rules)) {
			if (!matchesGlobs(rule.when, path)) continue;
			const declaredIn = await configFor.ruleFile(path, "required-files", name);
			const key = `${declaredIn}\0${name}`;
			// A rule's require set depends only on the touched paths, so each rule is judged once.
			if (judged.has(key)) continue;
			judged.add(key);
			const missing = rule.require.filter((glob) => !paths.some((each) => matchesGlobs([glob], each)));
			if (missing.length === 0) continue;
			hits.set(key, {
				guardrail: "required-files",
				file: path,
				line: 1,
				discriminator: `${name} in ${declaredIn}`,
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

// The globs of the root manifest's `workspaces`, at base and at head, since the head's run loads the head's. Undefined
// when one cannot be compiled, so every package.json counts rather than one slipping through.
async function workspaceGlobs(repoRoot: string, revision: Revision): Promise<string[] | undefined> {
	const globs: string[] = [];
	for (const commit of [revision.base, revision.head]) {
		const { text } = await blobText(repoRoot, commit, "package.json");
		let manifest: unknown;
		try {
			manifest = text === undefined ? undefined : JSON.parse(text);
		} catch {
			continue;
		}
		const workspaces = (manifest as { workspaces?: unknown } | undefined)?.workspaces;
		const list = Array.isArray(workspaces)
			? workspaces
			: (workspaces as { packages?: unknown } | undefined)?.packages;
		if (!Array.isArray(list)) continue;
		for (const glob of list) {
			if (typeof glob !== "string") continue;
			const negated = glob.startsWith("!");
			globs.push(
				`${negated ? "!" : ""}${glob
					.slice(negated ? 1 : 0)
					.replace(/^\.\//, "")
					.replace(/\/+$/, "")}`,
			);
		}
	}
	try {
		for (const glob of globs) compileGlob(glob.replace(/^!/, ""));
	} catch (error) {
		if (!(error instanceof Refused)) throw error;
		return undefined;
	}
	return globs;
}

// Biome and tsc load the root package.json and each workspace package's; any other is an ordinary file, such as a
// package that ships alongside the code without being part of the build.
function loadsManifest(path: string, workspaces: readonly string[] | undefined): boolean {
	if (path.split("/").at(-1) !== "package.json") return true;
	const directory = path.split("/").slice(0, -1).join("/");
	return directory === "" || workspaces === undefined || matchesGlobs(workspaces, directory);
}

// Every policy file the revision lists, and every touched path its own configuration adds to the list. A change to an
// analyser's configuration blocks by default: the head's copy drives the run that judges the head, so a switched-off
// check would otherwise read as a clean one.
async function policyChanges(input: GuardrailInput, paths: readonly string[], configFor: ConfigLookup): Promise<Hit[]> {
	const { revision, repoRoot } = input;
	const changed = revision.files.map((file) => file.path);
	const workspaces = revision.policyFiles.some((path) => path.split("/").at(-1) === "package.json")
		? await workspaceGlobs(repoRoot, revision)
		: [];
	return Promise.all(
		paths.map(async (path): Promise<Hit | undefined> => {
			const guardrail = (await configFor.policyReview(path)).guardrails["policy-change-review"];
			if (!guardrail.enabled) return undefined;
			const added = matchesGlobs(guardrail.files, path);
			const listed = revision.policyFiles.includes(path) && loadsManifest(path, workspaces);
			if (!listed && !added) return undefined;
			const analyser = analyserOf(path) ?? (added ? "an analyser this repository configures" : undefined);
			if (analyser !== undefined) {
				const [base, head] = await Promise.all([
					blobText(repoRoot, revision.base, path),
					blobText(repoRoot, revision.head, path),
				]);
				// A file too large to read is reported without the detail.
				const text = (blob: { text?: string; why?: string }) =>
					blob.text ?? (blob.why === "absent" ? undefined : "");
				const switched = switchOffs(path, text(base), text(head), changed);
				return {
					guardrail: "policy-change-review",
					file: path,
					line: 1,
					discriminator: "analyser",
					severity: guardrail.analyserSeverity,
					message: `Review the change to ${path}, which configures ${analyser}.`,
					explanation: {
						what: [`This revision changes ${path}, which configures ${analyser}.`, ...switched].join(" "),
						whyHere:
							"The head's configuration drives the static run on the head, so this change decides how the head's own results are judged, and a switched-off check reads as a clean one.",
						whatToDo: `Have a maintainer read the change to ${path}, or land it in its own pull request first.`,
					},
				};
			}
			return {
				guardrail: "policy-change-review",
				file: path,
				line: 1,
				discriminator: "policy",
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

const utf8 = new TextDecoder("utf-8", { fatal: true });

// A blob's text, or why it has none: absent at that commit, past the file limit, or not UTF-8.
async function blobText(repoRoot: string, commit: string, path: string): Promise<{ text?: string; why?: string }> {
	const object = `${commit}:${path}`;
	const size = await git(repoRoot, ["cat-file", "-s", object]);
	if (size.code !== 0) return { why: "absent" };
	if (Number(size.stdout.trim()) > guardrailLimits.fileBytes) {
		return { why: `larger than ${guardrailLimits.fileBytes} bytes` };
	}
	const blob = await git(repoRoot, ["cat-file", "blob", object]);
	if (blob.code !== 0) throw new CheckError("unreadable", check, `${object}: ${blob.stderr.trim()}`);
	try {
		return { text: utf8.decode(blob.stdoutBytes) };
	} catch {
		return { why: "not UTF-8 text" };
	}
}

// The head's lines of a file, read whole, skipping lines the base already had unless `all`. git shows no hunks for a
// file it calls binary, and one NUL byte is enough, so such a file is read this way when it is text; so is a file a
// rename moved into a rule's scope, whose every line is new to that rule.
async function headLines(
	input: GuardrailInput,
	file: ChangedFile,
	notes: string[],
	all = false,
): Promise<{ line: number; text: string }[] | "unscannable"> {
	const { repoRoot, revision } = input;
	const head = await blobText(repoRoot, revision.head, file.path);
	if (head.text === undefined) {
		// Text too large to read could hold anything; bytes that are not text hold no line a pattern is about.
		if (head.why?.startsWith("larger") === true) return "unscannable";
		notes.push(`forbidden-patterns did not scan ${file.path}, which git treats as binary and is ${head.why}.`);
		return [];
	}
	const base =
		file.status === "added" || all ? {} : await blobText(repoRoot, revision.base, file.oldPath ?? file.path);
	const before = new Set(base.text?.split("\n"));
	return head.text
		.split("\n")
		.map((text, index) => ({ line: index + 1, text }))
		.filter(({ text }, index, all) => !before.has(text) && !(index === all.length - 1 && text === ""));
}

async function forbiddenPatterns(
	input: GuardrailInput,
	configFor: (path: string) => Promise<MelianConfig>,
	notes: string[],
): Promise<Hit[]> {
	const compiled = new Map<string, LinearPattern>();
	const patternFor = ({ pattern: source, ignoreCase = false }: ForbiddenPatternRule) => {
		const key = `${ignoreCase ? "i" : "-"}${source}`;
		let pattern = compiled.get(key);
		if (pattern === undefined) {
			// loadConfig refused every pattern that does not compile when it read the file.
			const result = compilePattern(source, { ignoreCase });
			pattern = (result as Extract<typeof result, { ok: true }>).pattern;
			compiled.set(key, pattern);
		}
		return pattern;
	};
	const hits: Hit[] = [];
	let reader: SourceReader | undefined;
	for (const file of input.revision.files) {
		if (file.status === "deleted" || (file.hunks.length === 0 && !file.binary)) continue;
		if (file.newKind !== "file" && file.newKind !== "executable") continue;
		const config = await configFor(file.path);
		const guardrail = config.guardrails["forbidden-patterns"];
		const rules = Object.entries(guardrail.rules).filter(
			([, rule]) => rule.paths === undefined || matchesGlobs(rule.paths, file.path),
		);
		if (!guardrail.enabled || rules.length === 0) continue;
		const unscannable = (line: number, what: string): Hit => ({
			guardrail: "forbidden-patterns",
			file: file.path,
			line,
			discriminator: "unscanned",
			severity: guardrail.severity,
			message: "line could not be scanned.",
			explanation: {
				what: `forbidden-patterns could not scan ${what}, so the rule ${rules.map(([name]) => name).join(", ")} was not checked there.`,
				whyHere: "A line Melian cannot read could hold anything the rule forbids, so it counts against the change.",
				whatToDo: "Split the change into smaller files or lines, or have a maintainer read what was not scanned.",
			},
		});
		if (file.percentEncoded) {
			hits.push(unscannable(1, `${file.path}, whose name is not UTF-8`));
			continue;
		}
		const changed: { line: number; text: string; hunk?: Hunk }[] | "unscannable" = file.binary
			? await headLines(input, file, notes)
			: file.hunks.flatMap((hunk) => addedLines(hunk.text, hunk.newStart).map((each) => ({ ...each, hunk })));
		// A rename that moves a file into a rule's paths brings every line into that rule's scope, not only those it adds.
		const { oldPath } = file;
		const moved =
			oldPath === undefined
				? []
				: rules.filter(([, rule]) => rule.paths !== undefined && !matchesGlobs(rule.paths, oldPath));
		const whole = moved.length > 0 && changed !== "unscannable" ? await headLines(input, file, notes, true) : [];
		if (changed === "unscannable" || whole === "unscannable") {
			hits.push(unscannable(1, `${file.path}, over ${guardrailLimits.fileBytes} bytes`));
			continue;
		}
		const byLine = new Map(changed.map((each) => [each.line, { ...each, rules }]));
		for (const each of whole) if (!byLine.has(each.line)) byLine.set(each.line, { ...each, rules: moved });
		const added = [...byLine.values()].sort((a, b) => a.line - b.line);
		// Every line is scanned whole, however long, until the file's scan budget runs out.
		let scanned = 0;
		const unscanned = added.find((each) => {
			scanned += Buffer.byteLength(each.text);
			return scanned > guardrailLimits.scanBytes;
		});
		const within = unscanned === undefined ? added : added.slice(0, added.indexOf(unscanned));
		if (unscanned !== undefined) {
			const rest = added.length - within.length;
			hits.push(
				unscannable(
					unscanned.line,
					`${rest} added line(s) of ${file.path} past the ${guardrailLimits.scanBytes}-byte scan limit, from this one on`,
				),
			);
		}
		const matches = within.flatMap((each) => {
			// A CRLF file's lines end in "\r", which `$` would otherwise have to match past.
			const line = each.text.endsWith("\r") ? each.text.slice(0, -1) : each.text;
			const matched = each.rules.filter(([, rule]) => patternFor(rule).test(line));
			return matched.length === 0 ? [] : [{ hunk: each.hunk, added: each, matched }];
		});
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
				trigger: hunk === undefined ? undefined : { file: file.path, index: hunk.index, snippet: added.text },
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
 * - `policy-change-review`: the revision changes a policy, standards, or tool configuration file, one of
 *   `revision.policyFiles` or a path the configuration's `files` adds. A `melian.yaml` takes this guardrail from the
 *   configuration of the directory above its own, so it never switches off the review of itself. The root's takes it
 *   from its own configuration, which may make it stricter than the defaults but never more lenient.
 *
 * Every finding is `introduced`. Several rules of one guardrail that fire on one path or line give one finding. Throws
 * `ConfigError` when a `melian.yaml` cannot be loaded, and {@link CheckError} `unreadable` when a file at head cannot be read.
 */
export async function evaluateGuardrails(input: GuardrailInput): Promise<CheckReport> {
	const configFor: ConfigLookup = configLookup(input.repoRoot, input.source);
	const paths = touchedPaths(input.revision.files);
	const notes: string[] = [];
	const hits = [
		...(await forbiddenPaths(paths, configFor)),
		...(await requiredFiles(paths, configFor)),
		...(await forbiddenPatterns(input, configFor, notes)),
		...(await policyChanges(input, paths, configFor)),
	];
	return { findings: hits.map(finding), notes };
}

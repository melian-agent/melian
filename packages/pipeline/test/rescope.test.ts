import { rmSync } from "node:fs";
import { Changeset, type EvidenceLocation, revisionLimits } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeadProgram } from "../src/compiler-graph.ts";
import { EnclosingFunctions } from "../src/enclosing-functions.ts";
import { type ReviewState, reviewFiles } from "../src/lens-tools.ts";
import { type ScopedSighting, ScopeProposal } from "../src/rescope.ts";
import type { ReportVerdictInput } from "../src/verification-instructions.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./fixtures/repo.ts";

type Proposal = NonNullable<ReportVerdictInput["scope"]>;

const parse = (comment: string, guard = "\tif (fields.length < 2) return [];") =>
	lines(
		"export function validate(raw: string): boolean {",
		"\treturn raw.length > 0;",
		"}",
		"",
		"export function parseRecord(raw: string): string[] {",
		comment,
		'\tconst fields = raw.split(",");',
		guard,
		"\tconst name = fields[1].trim();",
		"\treturn [name];",
		"}",
	);
const run = lines(
	'import { parseRecord } from "./parse.ts";',
	"",
	"export function run(raw: string): string[] {",
	"\treturn parseRecord(raw);",
	"}",
);
const main = lines(
	'import { strict } from "./config.ts";',
	'import { run } from "./run.ts";',
	"",
	"export function start(input: string): string[] {",
	"\treturn strict ? [] : run(input);",
	"}",
);
const base = {
	"src/parse.ts": parse("\t// Split on commas."),
	"src/run.ts": run,
	"src/main.ts": main,
	"src/config.ts": "export const strict = false;\n",
	"src/extra.ts": "export const extra = 1;\n",
};
// The change edits one comment inside parseRecord, so a finding over the function is introduced by location.
const commentEdit = { "src/parse.ts": parse("\t// Split the line at each comma.") };

const answer = { answer: false, base: { file: "src/parse.ts", line: 9 } };
const proposal: Proposal = {
	reason: "The base fails the same way.",
	failing: { file: "src/parse.ts", line: 9, baseLine: 9 },
	trigger: { file: "src/main.ts", line: 5 },
	path: [{ file: "src/run.ts", line: 4 }],
	newCaller: answer,
	removedGuard: answer,
	changedTrigger: answer,
	copy: answer,
};
const sighting: ScopedSighting = {
	path: "src/parse.ts",
	startLine: 5,
	endLine: 11,
	cause: "introduced",
	evidence: [
		{
			file: "src/parse.ts",
			startLine: 9,
			role: "cause",
			revision: "head",
			snippet: "\tconst name = fields[1].trim();",
		},
	],
};

let repo: string | undefined;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
	repo = undefined;
});

async function refusals(
	head: Record<string, string>,
	changes: Partial<Proposal> = {},
	seen: Partial<ScopedSighting> = {},
	options: {
		verdict?: "confirmed" | "plausible" | "refuted";
		base?: Record<string, string>;
		prepare?: (repo: string) => void;
	} = {},
): Promise<readonly string[]> {
	repo = baseAndHead({ ...base, ...options.base }, head);
	if (options.prepare !== undefined) {
		options.prepare(repo);
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "more");
	}
	const changeset = await Changeset.resolve(repo, "main...feature");
	const { base: from, head: to, files } = changeset.revision;
	const review: ReviewState = { repoRoot: repo, nonce: "n", base: from, head: to, files: reviewFiles(files) };
	const read = await ScopeProposal.read(
		review,
		changeset.revision,
		{ ...sighting, ...seen },
		{ ...proposal, ...changes },
		options.verdict ?? "confirmed",
	);
	return read.refusals;
}

describe("a proposed re-scope", () => {
	it("holds for a finding over a function whose comment the change edited", async () => {
		expect(await refusals(commentEdit)).toEqual([]);
		expect(await refusals(commentEdit, {}, {}, { verdict: "plausible" })).toEqual([]);
	});

	it("holds with no path between the trigger and the failure", async () => {
		const { path: _, ...direct } = proposal;
		repo = baseAndHead(base, commentEdit);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const { base: from, head: to, files } = changeset.revision;
		const review: ReviewState = { repoRoot: repo, nonce: "n", base: from, head: to, files: reviewFiles(files) };
		expect((await ScopeProposal.read(review, changeset.revision, sighting, direct, "confirmed")).refusals).toEqual(
			[],
		);
	});

	it("is refused on a refuted verdict, and for a finding location already reads pre-existing", async () => {
		expect(await refusals(commentEdit, {}, {}, { verdict: "refuted" })).toEqual([
			"a re-scope rides only on a confirmed or plausible verdict",
		]);
		expect(await refusals(commentEdit, {}, { cause: "pre-existing" })).toEqual([
			"location already reads the finding pre-existing",
		]);
	});
});

describe("rule (a), no evidence on a changed line", () => {
	const on = (startLine: number, extra: Partial<EvidenceLocation> = {}): EvidenceLocation => ({
		file: "src/parse.ts",
		startLine,
		role: "context",
		revision: "head",
		snippet: "x",
		...extra,
	});

	it("refuses evidence of either role on a changed line, at the head or the base", async () => {
		expect(await refusals(commentEdit, {}, { evidence: [on(6)] })).toEqual([
			"(a) the finding's context evidence at src/parse.ts:6 is on a changed line",
		]);
		expect(await refusals(commentEdit, {}, { evidence: [on(9), on(5, { endLine: 6, role: "cause" })] })).toEqual([
			"(a) the finding's cause evidence at src/parse.ts:5-6 is on a changed line",
		]);
		expect(await refusals(commentEdit, {}, { evidence: [on(6, { revision: "base" })] })).toEqual([
			"(a) the finding's context evidence at src/parse.ts:6 is on a changed line",
		]);
	});

	it("lets evidence stand in a file git reports as renamed with identical content, the failing file unchanged", async () => {
		const moved = { file: "src/moved.ts", startLine: 1, role: "cause", revision: "head", snippet: "x" } as const;
		const seen = { cause: "affected" as const, evidence: [moved] };
		const prepare = (root: string) => gitIn(root, "mv", "src/extra.ts", "src/moved.ts");
		expect(await refusals({}, {}, seen, { prepare })).toEqual([]);
		const shown = { newCaller: { answer: false, base: { file: "src/extra.ts", line: 1 } } };
		expect(await refusals({}, shown, seen, { prepare })).toEqual([]);
	});
});

describe("rule (b), the failing lines are the same lines", () => {
	it("refuses failing lines in another file, or outside the finding at either end", async () => {
		const outside = "(b) the failing lines src/parse.ts:9 lie outside the finding";
		expect(await refusals(commentEdit, {}, { endLine: 8 })).toEqual([outside]);
		expect(await refusals(commentEdit, {}, { startLine: 10 })).toEqual([outside]);
		expect(await refusals(commentEdit, {}, { startLine: 9, endLine: 9 })).toEqual([]);
		expect(await refusals(commentEdit, {}, { path: "src/run.ts", startLine: 1, endLine: 20 })).toEqual([outside]);
	});

	it("refuses failing lines it cannot read at the head or at the base", async () => {
		const past = { file: "src/parse.ts", line: 11, endLine: 12, baseLine: 10 };
		expect(await refusals(commentEdit, { failing: past })).toEqual([
			"(b) Melian cannot read src/parse.ts:11-12 at the head",
			"(d) Melian cannot find the function that holds the failing lines with the compiler",
		]);
		expect(
			await refusals(commentEdit, { failing: { file: "src/parse.ts", line: 9, endLine: 10, baseLine: 11 } }),
		).toContain("(b) Melian cannot read the failing lines at the base, at line 11 of the base file");
		expect(
			await refusals(commentEdit, { failing: { file: "src/parse.ts", line: 10, endLine: 9, baseLine: 9 } }),
		).toContain("(b) Melian cannot read src/parse.ts:10-9 at the head");
	});

	it("refuses a file too large to read whole", async () => {
		const large = (comment: string) =>
			`${parse(comment)}${"// padding that makes the file larger than Melian reads\n".repeat(11_000)}`;
		expect(
			await refusals(
				{ "src/large.ts": large("\t// Split the line at each comma.") },
				{
					failing: { file: "src/large.ts", line: 9, baseLine: 9 },
				},
				{ path: "src/large.ts", evidence: [] },
				{ base: { "src/large.ts": large("\t// Split on commas.") } },
			),
		).toEqual([
			"(b) Melian cannot read src/large.ts:9 at the head",
			"(d) Melian cannot find the function that holds the failing lines with the compiler",
		]);
	});

	it("reads the last line of the file at both revisions", async () => {
		const last = { file: "src/parse.ts", line: 9, endLine: 11, baseLine: 9 };
		expect(await refusals(commentEdit, { failing: last })).toEqual([]);
	});

	it("refuses base lines that differ from the head's by one character", async () => {
		expect(await refusals(commentEdit, { failing: { file: "src/parse.ts", line: 9, baseLine: 10 } })).toContain(
			"(b) the failing lines at the base differ from the head's",
		);
		const edited = {
			"src/parse.ts": parse("\t// Split on commas.").replace("fields[1].trim()", "fields[1].trim() "),
		};
		expect(await refusals(edited)).toContain("(b) the failing lines at the base differ from the head's");
	});

	it("finds the base file through git's rename map, and refuses a file the head added", async () => {
		const renamed = { "src/parse.ts": parse("\t// Split the line at each comma.") };
		const moved = { ...sighting, path: "src/reader.ts", evidence: [] };
		const at = (file: string) => ({ ...proposal, failing: { file, line: 9, baseLine: 9 } });
		const rename = (root: string) => gitIn(root, "mv", "src/parse.ts", "src/reader.ts");
		expect(await refusals(renamed, at("src/reader.ts"), moved, { prepare: rename })).toEqual([]);
		const copied = { ...commentEdit, "src/copy.ts": parse("\t// Split on commas.") };
		const inCopy = await refusals(copied, at("src/copy.ts"), { ...moved, path: "src/copy.ts" });
		expect(inCopy).toContain("(b) Melian cannot read the failing lines at the base, at line 9 of the base file");
	});
});

describe("rule (c), the trigger is untouched", () => {
	// The change also adds a blank line inside start, which names nothing a trigger could read.
	const spaced = {
		...commentEdit,
		"src/main.ts": main.replace("\treturn strict", "\n\treturn strict"),
	};

	it("refuses a proposal that names no trigger", async () => {
		const { trigger: _, ...unnamed } = proposal;
		repo = baseAndHead(base, commentEdit);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const { base: from, head: to, files } = changeset.revision;
		const review: ReviewState = { repoRoot: repo, nonce: "n", base: from, head: to, files: reviewFiles(files) };
		expect((await ScopeProposal.read(review, changeset.revision, sighting, unnamed, "confirmed")).refusals).toEqual([
			"(c) the proposal names no trigger",
		]);
	});

	it("refuses a trigger inside a hunk, and one beside it stands", async () => {
		expect(await refusals(spaced, { trigger: { file: "src/main.ts", line: 4, endLine: 6 } })).toEqual([
			"(c) src/main.ts:4-6 is inside a hunk of the diff",
		]);
		expect(await refusals(spaced, { trigger: { file: "src/main.ts", line: 6 } })).toEqual([]);
	});

	it("refuses a path location inside a hunk", async () => {
		expect(
			await refusals(spaced, {
				trigger: { file: "src/main.ts", line: 6 },
				path: [
					{ file: "src/run.ts", line: 4 },
					{ file: "src/main.ts", line: 5 },
				],
			}),
		).toEqual(["(c) src/main.ts:5 is inside a hunk of the diff"]);
	});

	it("refuses failing lines that reach an added line though the base holds the same bytes", async () => {
		const noted = (extra: string[]) =>
			lines(
				"export function noted(xs: number[]): number {",
				"\tconst n = xs[0];",
				"\t// One more.",
				"\t// One more.",
				...extra,
				"\treturn n + 1;",
				"}",
			);
		const found = await refusals(
			{ "src/noted.ts": noted(["\t// One more."]) },
			{ failing: { file: "src/noted.ts", line: 4, endLine: 5, baseLine: 3 } },
			{ path: "src/noted.ts", startLine: 1, endLine: 7, evidence: [] },
			{ base: { "src/noted.ts": noted([]) } },
		);
		expect(found).toEqual(["(c) src/noted.ts:4-5 is inside a hunk of the diff"]);
	});

	it("refuses a trigger it cannot read at the head", async () => {
		expect(await refusals(commentEdit, { trigger: { file: "src/main.ts", line: 40 } })).toEqual([
			"(d) Melian cannot find the function that holds src/main.ts:40 with the compiler",
			"(c) Melian cannot read the trigger src/main.ts:40 at the head",
		]);
	});
});

describe("rule (d), four typed answers, cross-checked", () => {
	it.each(["newCaller", "removedGuard", "changedTrigger", "copy"] as const)(
		"refuses %s answered true",
		async (name) => {
			expect(await refusals(commentEdit, { [name]: { ...answer, answer: true } })).toEqual([
				`(d) the verifier answered ${name} true`,
			]);
		},
	);

	it.each(["newCaller", "removedGuard", "changedTrigger", "copy"] as const)(
		"refuses %s with base lines Melian cannot read",
		async (name) => {
			expect(
				await refusals(commentEdit, { [name]: { answer: false, base: { file: "src/parse.ts", line: 99 } } }),
			).toEqual([`(d) Melian cannot read the base lines src/parse.ts:99 given for ${name}`]);
			expect(
				await refusals(commentEdit, { [name]: { answer: false, base: { file: "src/absent.ts", line: 1 } } }),
			).toEqual([`(d) Melian cannot read the base lines src/absent.ts:1 given for ${name}`]);
		},
	);

	it("refuses a hunk that adds a call to the failing symbol, beside an older caller", async () => {
		const head = {
			...commentEdit,
			"src/other.ts": 'import { parseRecord } from "./parse.ts";\n\nexport const first = parseRecord("a");\n',
		};
		expect(await refusals(head)).toEqual(["(d) a hunk in src/other.ts adds a line that names parseRecord"]);
		const near = { ...commentEdit, "src/other.ts": "export const reparseRecords = 1;\n" };
		expect(await refusals(near)).toEqual([]);
	});

	it("names a method by its own name and a constructor by its class", async () => {
		const reader = (extra: string) =>
			lines(
				"export class Reader {",
				"\tfields: string[];",
				"\tconstructor(raw: string) {",
				'\t\tthis.fields = raw.split(",");',
				"\t}",
				"\tsecondField(): string {",
				"\t\t// The second field.",
				"\t\treturn this.fields[1].trim();",
				"\t}",
				"}",
				extra,
			);
		const seen = { path: "src/reader.ts", startLine: 1, endLine: 10, evidence: [] };
		const options = { base: { "src/reader.ts": reader("") } };
		const inMethod = { failing: { file: "src/reader.ts", line: 8, baseLine: 8 } };
		expect(await refusals({ "src/reader.ts": reader("export const label = 1;") }, inMethod, seen, options)).toEqual(
			[],
		);
		expect(
			await refusals(
				{ "src/reader.ts": reader("export const two = new Reader(raw).secondField();") },
				inMethod,
				seen,
				options,
			),
		).toEqual(["(d) a hunk in src/reader.ts adds a line that names secondField"]);
		const inConstructor = { failing: { file: "src/reader.ts", line: 4, baseLine: 4 } };
		expect(
			await refusals(
				{ "src/reader.ts": reader('export const made = new Reader("a");') },
				inConstructor,
				seen,
				options,
			),
		).toEqual(["(d) a hunk in src/reader.ts adds a line that names Reader"]);
	});

	it("refuses a hunk that deletes or edits code inside the function that holds the failure", async () => {
		const weakened = { "src/parse.ts": parse("\t// Split on commas.", "\tif (fields.length < 1) return [];") };
		expect(await refusals(weakened)).toEqual([
			"(d) a hunk deletes code at base line 8, inside the function that holds the failure",
			"(d) a hunk adds code at line 8, inside the function that holds the failure",
		]);
		const removed = {
			"src/parse.ts": parse("\t// Split on commas.").replace("\tif (fields.length < 2) return [];\n", ""),
		};
		expect(await refusals(removed, { failing: { file: "src/parse.ts", line: 8, baseLine: 9 } })).toEqual([
			"(d) a hunk deletes code at base line 8, inside the function that holds the failure",
		]);
	});

	it("refuses a hunk that adds code inside the function that holds the failure, and lets one add a comment", async () => {
		const withLine = (line: string) => ({
			"src/parse.ts": parse("\t// Split on commas.").replace("\tif (fields", `${line}\n\tif (fields`),
		});
		const shifted = { failing: { file: "src/parse.ts", line: 10, baseLine: 9 } };
		expect(await refusals(withLine("\tfields.length = 1;"), shifted)).toEqual([
			"(d) a hunk adds code at line 8, inside the function that holds the failure",
		]);
		expect(await refusals(withLine("\t// Keep the first field."), shifted)).toEqual([]);
		const two = withLine("\t// Keep the first field.\n\tfields.length = 1;");
		expect(
			await refusals(two, { failing: { file: "src/parse.ts", line: 11, baseLine: 9 } }, { evidence: [] }),
		).toEqual(["(d) a hunk adds code at line 8, inside the function that holds the failure"]);
	});

	it("reads a deleted line at the base and an added line at the head, each by its own revision's lines", async () => {
		const noted = (guard: string[]) =>
			lines(
				"export function pick(raw: string): string {",
				'\tconst fields = raw.split(",");',
				...guard,
				"\t// The second field.",
				"\tconst name = fields[1].trim();",
				"\treturn name;",
				"}",
			);
		const seen = { path: "src/pick.ts", startLine: 1, endLine: 8, evidence: [] };
		// The guard on base line 3 goes, and head line 3 is the comment.
		expect(
			await refusals(
				{ "src/pick.ts": noted([]) },
				{ failing: { file: "src/pick.ts", line: 4, baseLine: 5 } },
				seen,
				{ base: { "src/pick.ts": noted(['\tif (fields.length < 2) return "";']) } },
			),
		).toEqual(["(d) a hunk deletes code at base line 3, inside the function that holds the failure"]);
		// Code arrives on head line 3, where the base holds the comment.
		expect(
			await refusals(
				{ "src/pick.ts": noted(["\tfields.length = 1;"]) },
				{ failing: { file: "src/pick.ts", line: 5, baseLine: 4 } },
				seen,
				{ base: { "src/pick.ts": noted([]) } },
			),
		).toEqual(["(d) a hunk adds code at line 3, inside the function that holds the failure"]);
	});

	it("lets a hunk delete code in another function of the file", async () => {
		const elsewhere = { "src/parse.ts": parse("\t// Split on commas.").replace("raw.length > 0", "raw.length > 1") };
		expect(await refusals(elsewhere)).toEqual([]);
		const after = { "src/parse.ts": `${parse("\t// Split on commas.")}\nexport const later = 1;\n` };
		expect(await refusals(after)).toEqual([]);
	});

	it("refuses a file the compiler does not read, top-level code, and a default export", async () => {
		const cannot = "(d) Melian cannot find the function that holds the failing lines with the compiler";
		const script = { "src/parse.mjs": parse("\t// Split on commas.") };
		expect(
			await refusals(
				{ "src/parse.mjs": parse("\t// Split the line at each comma.") },
				{ failing: { file: "src/parse.mjs", line: 9, baseLine: 9 } },
				{ path: "src/parse.mjs", evidence: [] },
				{ base: script },
			),
		).toEqual([cannot]);
		const top = (comment: string) =>
			lines(comment, 'const fields = "a".split(",");', "export const name = fields[1].trim();");
		expect(
			await refusals(
				{ "src/top.ts": top("// Reads a field.") },
				{ failing: { file: "src/top.ts", line: 3, baseLine: 3 } },
				{ path: "src/top.ts", startLine: 1, endLine: 3, evidence: [] },
				{ base: { "src/top.ts": top("// Reads.") } },
			),
		).toEqual([cannot]);
		const exported = (comment: string) =>
			lines("export default function (raw: string): string {", comment, '\treturn raw.split(",")[1].trim();', "}");
		expect(
			await refusals(
				{ "src/pick.ts": exported("\t// The second field.") },
				{ failing: { file: "src/pick.ts", line: 3, baseLine: 3 } },
				{ path: "src/pick.ts", startLine: 1, endLine: 4, evidence: [] },
				{ base: { "src/pick.ts": exported("\t// Second.") } },
			),
		).toEqual([
			"(d) the failing function is a default export or has a computed name, so Melian cannot name its callers",
		]);
	});

	it("refuses when a function holds the failing lines at only one of the two revisions", async () => {
		const cannot = "(d) Melian cannot find the function that holds the failing lines with the compiler";
		const mixed = (comment: string) =>
			lines(
				'const fields = ["a", "b"];',
				"\tconst name = fields[1].trim();",
				"export function pick(): string {",
				comment,
				"\tconst name = fields[1].trim();",
				"\treturn name;",
				"}",
			);
		const seen = { path: "src/mixed.ts", startLine: 1, endLine: 7, evidence: [] };
		const options = { base: { "src/mixed.ts": mixed("\t// Second.") } };
		const head = { "src/mixed.ts": mixed("\t// The second field.") };
		const inFunction = { failing: { file: "src/mixed.ts", line: 5, baseLine: 2 } };
		expect(await refusals(head, inFunction, seen, options)).toEqual([cannot]);
		const atTop = { failing: { file: "src/mixed.ts", line: 2, baseLine: 5 } };
		expect(await refusals(head, atTop, seen, options)).toEqual([cannot]);
	});

	it("refuses a method whose name is not a plain identifier", async () => {
		const quoted = (comment: string) =>
			lines(
				"export class Reader {",
				'\t"second-field"(raw: string): string {',
				comment,
				'\t\treturn raw.split(",")[1].trim();',
				"\t}",
				"}",
			);
		expect(
			await refusals(
				{ "src/quoted.ts": quoted("\t\t// The second field.") },
				{ failing: { file: "src/quoted.ts", line: 4, baseLine: 4 } },
				{ path: "src/quoted.ts", startLine: 1, endLine: 6, evidence: [] },
				{ base: { "src/quoted.ts": quoted("\t\t// Second.") } },
			),
		).toEqual([
			"(d) the failing function is a default export or has a computed name, so Melian cannot name its callers",
		]);
	});

	it("refuses base lines given for an answer when the change deleted or edited them", async () => {
		for (const name of ["newCaller", "removedGuard", "changedTrigger", "copy"] as const) {
			expect(
				await refusals(commentEdit, { [name]: { answer: false, base: { file: "src/parse.ts", line: 6 } } }),
			).toEqual([`(d) the change deleted or edited the base lines src/parse.ts:6 given for ${name}`]);
		}
	});

	it("refuses a hunk that deletes or adds code in a function on the path, as a guard in a caller would be", async () => {
		const guarded = run.replace("\treturn parseRecord", '\tif (!raw.includes(",")) return [];\n\treturn parseRecord');
		expect(
			await refusals({ ...commentEdit, "src/run.ts": run }, {}, {}, { base: { "src/run.ts": guarded } }),
		).toEqual(["(d) a hunk deletes code at base line 4, inside the function that holds src/run.ts:4"]);
		const reset = run.replace("\treturn parseRecord", "\traw.trim();\n\treturn parseRecord");
		expect(
			await refusals({ ...commentEdit, "src/run.ts": reset }, { path: [{ file: "src/run.ts", line: 5 }] }),
		).toEqual(["(d) a hunk adds code at line 4, inside the function that holds src/run.ts:5"]);
		const noted = run.replace("\treturn parseRecord", "\t// Parse it.\n\treturn parseRecord");
		expect(
			await refusals({ ...commentEdit, "src/run.ts": noted }, { path: [{ file: "src/run.ts", line: 5 }] }),
		).toEqual([]);
	});

	it("holds the trigger's own function to the same check, and refuses a trigger outside every function", async () => {
		const padded = main.replace("\treturn strict", "\tconst unused = 1;\n\treturn strict");
		expect(
			await refusals({ ...commentEdit, "src/main.ts": padded }, { trigger: { file: "src/main.ts", line: 6 } }),
		).toEqual(["(d) a hunk adds code at line 5, inside the function that holds src/main.ts:6"]);
		const boot = { "src/boot.ts": 'import { start } from "./main.ts";\n\nstart("a,b");\n' };
		expect(
			await refusals({ ...commentEdit, ...boot }, { trigger: { file: "src/boot.ts", line: 3 } }, {}, { base: boot }),
		).toEqual(["(d) Melian cannot find the function that holds src/boot.ts:3 with the compiler"]);
	});

	it("refuses when the head names the failing symbol without calling it, since a caller may use another name", async () => {
		const named = async (file: string) =>
			refusals({ ...commentEdit, "src/alias.ts": file }, {}, {}, { base: { "src/alias.ts": file } });
		const from = 'import { parseRecord } from "./parse.ts";\n';
		expect(await named(`${from}export const decode = parseRecord;\n`)).toEqual([
			"(d) src/alias.ts:2 names parseRecord without calling it, so a caller may reach it under another name",
		]);
		expect(
			await named('import { parseRecord as decode } from "./parse.ts";\nexport const one = decode("a");\n'),
		).toEqual([
			"(d) src/alias.ts:1 names parseRecord without calling it, so a caller may reach it under another name",
		]);
		expect(await named(`${from}export const both = [parseRecord("a,b"), parseRecord];\n`)).toEqual([
			"(d) src/alias.ts:2 names parseRecord without calling it, so a caller may reach it under another name",
		]);
		expect(await named('export { parseRecord } from "./parse.ts";\n')).toEqual([]);
		expect(
			await named('export { validate, parseRecord };\nimport { validate, parseRecord } from "./parse.ts";\n'),
		).toEqual([]);
		expect(await named(`${from}export const one = parseRecord < 1;\n`)).toEqual([
			"(d) src/alias.ts:2 names parseRecord without calling it, so a caller may reach it under another name",
		]);
		expect(await named(`${from}export const reparseRecords = parseRecord<string>("a,b");\n`)).toEqual([]);
		// The alias sits on line 5, where parseRecord's own declaration sits in its own file.
		expect(await named(`${from}\n\n\nexport const decode = parseRecord;\n`)).toEqual([
			"(d) src/alias.ts:5 names parseRecord without calling it, so a caller may reach it under another name",
		]);
		const own = `${parse("\t// Split on commas.")}export const decode = parseRecord;\n`;
		const edited = `${parse("\t// Split the line at each comma.")}export const decode = parseRecord;\n`;
		expect(await refusals({ "src/parse.ts": edited }, {}, {}, { base: { "src/parse.ts": own } })).toEqual([
			"(d) src/parse.ts:12 names parseRecord without calling it, so a caller may reach it under another name",
		]);
		// Another name for the trigger's own function is no new caller of the failing one.
		expect(await named('import { start } from "./main.ts";\nexport const begin = start;\n')).toEqual([]);
	});

	it("lets the failing function's own declaration name it without a call", async () => {
		const arrow = (comment: string) =>
			lines(
				"export const pickName = (raw: string): string => {",
				comment,
				'\treturn raw.split(",")[1].trim();',
				"};",
			);
		expect(
			await refusals(
				{ "src/arrow.ts": arrow("\t// The second field.") },
				{ failing: { file: "src/arrow.ts", line: 3, baseLine: 3 } },
				{ path: "src/arrow.ts", startLine: 1, endLine: 4, evidence: [] },
				{ base: { "src/arrow.ts": arrow("\t// Second.") } },
			),
		).toEqual([]);
	});

	it("refuses when the head names the failing symbol on more lines than Melian lists", async () => {
		const many = `import { parseRecord } from "./parse.ts";\n${'parseRecord("a,b");\n'.repeat(revisionLimits.searchMatches + 1)}`;
		expect(
			await refusals({ ...commentEdit, "src/many.ts": many }, {}, {}, { base: { "src/many.ts": many } }),
		).toEqual(["(d) Melian cannot list every line of the head that names parseRecord"]);
	});

	it("refuses when the compiler cannot start", async () => {
		vi.spyOn(HeadProgram, "open").mockImplementation(() => {
			throw new Error("no compiler");
		});
		expect(await refusals(commentEdit)).toEqual([
			"(d) Melian cannot find the function that holds the failing lines with the compiler",
			"(d) Melian cannot find the function that holds src/main.ts:5 with the compiler",
			"(d) Melian cannot find the function that holds src/run.ts:4 with the compiler",
		]);
	});

	it("refuses a hunk that changes a name the trigger reads, in a file the verifier never named", async () => {
		const flipped = { ...commentEdit, "src/config.ts": "export const strict = true;\n" };
		expect(await refusals(flipped)).toEqual([
			"(d) a hunk in src/config.ts changes a line that names strict, which the trigger reads",
		]);
		const removed = { ...commentEdit, "src/config.ts": "export const strict = false;\nexport const lax = true;\n" };
		expect(await refusals(removed)).toEqual([]);
	});

	it("reads a removed line as a change to what the trigger reads", async () => {
		const withFlag = { "src/flags.ts": "export const input = 1;\nexport const other = 2;\n" };
		const dropped = { ...commentEdit, "src/flags.ts": "export const other = 2;\n" };
		expect(await refusals(dropped, {}, {}, { base: withFlag })).toEqual([
			"(d) a hunk in src/flags.ts changes a line that names input, which the trigger reads",
		]);
	});

	it("reads a hunk's added lines when a review stored before removed lines were kept holds no others", async () => {
		const flipped = { ...commentEdit, "src/config.ts": "export const strict = true;\n" };
		repo = baseAndHead(base, flipped);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const { base: from, head: to, files } = changeset.revision;
		const stored = reviewFiles(files).map((file) => ({
			...file,
			hunks: file.hunks.map(({ changes: _, ...hunk }) => hunk),
		}));
		const review: ReviewState = { repoRoot: repo, nonce: "n", base: from, head: to, files: stored };
		expect((await ScopeProposal.read(review, changeset.revision, sighting, proposal, "confirmed")).refusals).toEqual([
			"(d) a hunk in src/config.ts changes a line that names strict, which the trigger reads",
		]);
	});

	it("does not read a keyword on the trigger's line as something it reads", async () => {
		const added = { ...commentEdit, "src/more.ts": "export function more(): number {\n\treturn 1;\n}\n" };
		expect(await refusals(added, { trigger: { file: "src/main.ts", line: 4, endLine: 5 } })).toEqual([]);
	});

	it("refuses a head that adds a copy of the failing lines", async () => {
		const copied = {
			...commentEdit,
			"src/second.ts": lines(
				"export function second(text: string): string {",
				'\tconst fields = text.split(";");',
				"\tconst name =",
				"\t\tfields[1].trim();",
				"\treturn name;",
				"}",
			),
		};
		expect(await refusals(copied)).toEqual([
			"(d) a hunk in src/second.ts adds the failing lines, so the head holds a copy",
		]);
	});
});

describe("the function around some lines, and its code lines", () => {
	const text = lines(
		"export function outer(a: number, b: number): string {",
		"\t// A comment.",
		"",
		"\tconst inner = (c: number) => {",
		"\t\t/* A block",
		"\t\t * comment. */",
		"\t\treturn c",
		"\t\t\t* b;",
		"\t};",
		"\tconst product = a",
		"\t\t*",
		"\t\tb; /* A trailing block",
		"\t\t* that runs on. */",
		"\tconst note = `first",
		"// not a comment",
		"last`;",
		"\t/*/ An odd opener",
		"\tthat ends here. */",
		"\tconst called = inner",
		"\t\t(",
		"\t\t\ta",
		"\t\t);",
		"\treturn note + called;",
		"}",
		"export const after = 1;",
	);
	const at = (path: string, startLine: number, endLine = startLine) =>
		EnclosingFunctions.around([{ path, text, startLine, endLine }])[0];

	it("finds the innermost named function that holds every line asked about", () => {
		expect(at("a.ts", 7)).toMatchObject({ name: "inner", startLine: 4, endLine: 9 });
		expect(at("a.ts", 4, 9)).toMatchObject({ name: "inner" });
		expect(at("a.ts", 9, 10)).toMatchObject({ name: "outer", startLine: 1, endLine: 24 });
		expect(at("a.ts", 3, 7)).toMatchObject({ name: "outer" });
		expect(at("a.ts", 1, 24)).toMatchObject({ name: "outer" });
	});

	it("finds none outside every function, in a file that is not TypeScript, or in a declaration file", () => {
		expect(at("a.ts", 25)).toBeUndefined();
		expect(at("a.ts", 24, 25)).toBeUndefined();
		expect(at("a.d.ts", 7)).toBeUndefined();
		const open = vi.spyOn(HeadProgram, "open");
		expect(at("a.mjs", 7)).toBeUndefined();
		expect(open).not.toHaveBeenCalled();
	});

	it("counts a comment or a blank line as no code, and everything it cannot tell as code", () => {
		expect([...at("a.ts", 23)!.code]).toEqual([1, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 24]);
		expect([...at("a.ts", 7)!.code]).toEqual([4, 7, 8, 9]);
	});

	it("opens two texts under one path, as a file's base and head", () => {
		const other = text.replace("outer", "renamed");
		const found = EnclosingFunctions.around([
			{ path: "a.ts", text, startLine: 23, endLine: 23 },
			{ path: "a.ts", text: other, startLine: 23, endLine: 23 },
			{ path: "a.mjs", text, startLine: 23, endLine: 23 },
		]);
		expect(found.map((each) => each?.name)).toEqual(["outer", "renamed", undefined]);
	});
});

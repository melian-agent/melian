import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { type ChangedFile, Changeset, type Hunk, Revision, type StoredCoverageLines } from "@melian-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { ChangePrompt, promptLimits } from "../src/change-prompt.ts";
import { cutDiffNote, type EnclosingFunctions } from "../src/enclosing-functions.ts";
import { quoteUntrusted } from "../src/untrusted.ts";
import { commit, createRepository, gitIn, lines, removeRepository } from "./fixtures/repo.ts";

const nonce = "n".repeat(24);
const q = (label: "listing" | "diff", text: string) => quoteUntrusted(label, text, nonce);
const base = "a".repeat(40);
const head = "b".repeat(40);
const modes = { oldMode: "100644", newMode: "100644", oldKind: "file", newKind: "file" } as const;
const facts = "mode 100644 (file) -> 100644 (file); text";

const hunk = (file: string, index: number, old: [number, number], now: [number, number], text: string): Hunk => ({
	file,
	index,
	oldStart: old[0],
	oldLines: old[1],
	newStart: now[0],
	newLines: now[1],
	header: `@@ -${old[0]},${old[1]} +${now[0]},${now[1]} @@`,
	text,
});
const changed = (path: string, hunks: Hunk[], extra: Partial<ChangedFile> = {}): ChangedFile => ({
	status: "modified",
	path,
	binary: false,
	hunks,
	...modes,
	...extra,
});
const prompt = (files: ChangedFile[], targets: ConstructorParameters<typeof ChangePrompt>[2] = {}) =>
	new ChangePrompt(
		{ revision: Revision.from({ base, head, files }), repoRoot: "/nowhere" } as unknown as Changeset,
		nonce,
		targets,
	);
const header = (listing: string, tools = true) =>
	[
		"Review the change from aaaaaaaaaaaa to bbbbbbbbbbbb.",
		"",
		"Files changed:",
		q("listing", listing),
		"",
		`Each file's diff follows in its own block, whose first line names the file and whose second gives its modes and kinds. The diff has no context lines.${tools ? " Read the head revision with read_file for the code around each hunk." : ""}`,
	].join("\n");
const delta = (head: StoredCoverageLines["head"], more: Partial<StoredCoverageLines> = {}): StoredCoverageLines => ({
	head,
	base: {},
	units: {},
	...more,
});

const a = changed("src/a.ts", [
	hunk("src/a.ts", 0, [3, 1], [3, 1], "-a 3\n+A 3"),
	hunk("src/a.ts", 1, [9, 1], [9, 2], "-a 9\n+A 9\n+A 10"),
]);
const renamed = changed("src/new.ts", [], { status: "renamed", oldPath: "src/old.ts" });
const aBlock = (...indexes: number[]) =>
	q(
		"diff",
		[
			"src/a.ts (modified)",
			facts,
			...indexes.map((index) => `${a.hunks[index]!.header}\n${a.hunks[index]!.text}`),
		].join("\n"),
	);
const renamedBlock = q("diff", `src/old.ts -> src/new.ts (renamed)\n${facts}`);
const listing = "modified src/a.ts\nrenamed src/old.ts -> src/new.ts";

describe("ChangePrompt.renderInput", () => {
	it("renders the header, then each file's block, smallest first, and records what it delivered", () => {
		const { text, cut, delivered } = prompt([a, renamed]).renderInput();
		expect(text).toBe([header(listing), renamedBlock, aBlock(0, 1)].join("\n\n"));
		expect(cut).toBe(false);
		expect(delivered).toEqual({
			hunks: { "src/new.ts": [], "src/a.ts": [0, 1] },
			fields: {
				"src/new.ts": ["status", "path", "oldPath", "oldMode", "newMode", "oldKind", "newKind", "binary"],
				"src/a.ts": ["status", "path", "oldMode", "newMode", "oldKind", "newKind", "binary"],
			},
			omitted: [],
		});
		expect(prompt([a, renamed]).render(undefined, { tools: false })).toBe(
			[header(listing, false), renamedBlock, aBlock(0, 1)].join("\n\n"),
		);
	});

	it("keeps only the files named, a renamed file by its old path", () => {
		expect(prompt([a, renamed]).renderInput(["src/old.ts"]).delivered.hunks).toEqual({ "src/new.ts": [] });
		expect(prompt([a, renamed]).renderInput(["src/a.ts"]).delivered.hunks).toEqual({ "src/a.ts": [0, 1] });
	});

	it("puts a delta's hunks under review and the rest after as context, and leaves out an empty context", () => {
		const text = prompt([a, renamed]).render(undefined, { delta: delta({ "src/a.ts": [[9, 9]] }) });
		expect(text).toBe(
			[
				header(listing),
				"## The change under review\n\nThese hunks are what this round reviews.",
				aBlock(1),
				"## Context\n\nThe rest of the diff, which earlier rounds reviewed. Read it for what the change under review touches.",
				aBlock(0),
			].join("\n\n"),
		);
		const whole = prompt([a]).render(undefined, { delta: delta({ "src/a.ts": [[1, 20]] }) });
		expect(whole).not.toContain("## Context");
		expect(whole).toContain(aBlock(0, 1));
	});

	it("reviews a file unit the delta names though it has no hunk, and none it does not", () => {
		const units = { units: { "src/new.ts": ["status" as const] } };
		expect(prompt([a, renamed]).render(undefined, { delta: delta({}, units) })).toContain(
			`## The change under review\n\nThese hunks are what this round reviews.\n\n${renamedBlock}`,
		);
		expect(prompt([a, renamed]).render(undefined, { delta: delta({}) })).not.toContain(renamedBlock);
	});

	it.each<[string, [number, number][], number[]]>([
		["a range that ends on the first hunk", [[1, 3]], [0]],
		[
			"one of several ranges",
			[
				[1, 1],
				[9, 9],
			],
			[1],
		],
		["a range just past the second hunk", [[11, 11]], []],
		["a range after both", [[20, 30]], []],
	])("puts under review the hunks %s overlaps", (_, ranges, reviewed) => {
		const rest = [0, 1].filter((index) => !reviewed.includes(index));
		expect(prompt([a]).render(undefined, { delta: delta({ "src/a.ts": ranges }) })).toBe(
			[
				header("modified src/a.ts"),
				"## The change under review\n\nThese hunks are what this round reviews.",
				...(reviewed.length === 0 ? [] : [aBlock(...reviewed)]),
				"## Context\n\nThe rest of the diff, which earlier rounds reviewed. Read it for what the change under review touches.",
				aBlock(...rest),
			].join("\n\n"),
		);
	});

	it("finds a pure deletion in the delta by its base lines alone, under a renamed file's old path", () => {
		const gone = changed("src/b.ts", [hunk("src/b.ts", 0, [5, 2], [4, 0], "-b 5\n-b 6")], {
			status: "renamed",
			oldPath: "src/old-b.ts",
		});
		const block = q(
			"diff",
			`src/old-b.ts -> src/b.ts (renamed)\n${facts}\n${gone.hunks[0]!.header}\n${gone.hunks[0]!.text}`,
		);
		const review = "## The change under review\n\nThese hunks are what this round reviews.";
		expect(prompt([gone]).render(undefined, { delta: delta({}, { base: { "src/old-b.ts": [[6, 6]] } }) })).toContain(
			`${review}\n\n${block}`,
		);
		expect(prompt([gone]).render(undefined, { delta: delta({ "src/b.ts": [[3, 5]] }) })).toContain(
			`${review}\n\n## Context`,
		);
	});
});

describe("ChangePrompt at its limits", () => {
	const limits = promptLimits as { bytes: number; metadataBytes: number };
	const saved = { ...promptLimits };
	afterEach(() => {
		limits.bytes = saved.bytes;
		limits.metadataBytes = saved.metadataBytes;
	});
	const gone = changed("src/gone.ts", [hunk("src/gone.ts", 0, [2, 2], [1, 0], "-g 2\n-g 3")]);
	const run = changed("bin/run", [], { newMode: "100755" });
	const runLine = "bin/run (modified): mode 100644 (file) -> 100755 (file); text";

	it("fits a prompt exactly at the limit, and cuts it one byte below", () => {
		const whole = prompt([a]).renderInput().text;
		limits.bytes = Buffer.byteLength(whole);
		expect(prompt([a]).renderInput().cut).toBe(false);
		limits.bytes = Buffer.byteLength(whole) - 1;
		expect(prompt([a]).renderInput().cut).toBe(true);
	});

	it("lists the hunks it left out, on each side, and names a left-out file unit's fields", () => {
		const files = [a, gone, run];
		limits.bytes = Buffer.byteLength(header("modified src/a.ts\nmodified src/gone.ts\nmodified bin/run")) + 1;
		const { text, delivered } = prompt(files).renderInput();
		expect(text.split("\n\n").slice(-2)).toEqual([
			`These hunks were left out for size. Read each with read_file, in windows, before you finish:\n${q(
				"listing",
				"src/gone.ts lines 2-3 at the base\nsrc/a.ts lines 3-3\nsrc/a.ts lines 9-10",
			)}`,
			`File units left out of the diff:\n${q("listing", runLine)}`,
		]);
		expect(delivered).toEqual({
			hunks: {},
			fields: { "bin/run": ["status", "path", "oldMode", "newMode", "oldKind", "newKind", "binary"] },
			omitted: ["src/gone.ts", "src/a.ts"],
		});
		expect(prompt(files).render(undefined, { tools: false })).toContain(
			"\n\n[The diff continues; the remaining hunks are omitted.]\n\nFile units left out",
		);
	});

	it("names a left-out file unit within its own bound, and none past it", () => {
		limits.bytes = 1;
		limits.metadataBytes = Buffer.byteLength(runLine) + 1;
		expect(prompt([run]).renderInput().delivered.fields).toHaveProperty("bin/run");
		limits.metadataBytes = Buffer.byteLength(runLine);
		const { text, delivered } = prompt([run]).renderInput();
		expect(delivered.fields).toEqual({});
		expect(text).not.toContain("File units left out");
	});

	it("follows a whole diff with its functions, and a cut one with the note that says why they are missing", () => {
		const functions = { blocks: () => ["FUNCTIONS"] } as unknown as EnclosingFunctions;
		expect(prompt([a]).render(undefined, { functions }).endsWith("\n\nFUNCTIONS")).toBe(true);
		limits.bytes = 1;
		const cut = prompt([a]).render(undefined, { functions });
		expect(cut.endsWith(`\n\n${cutDiffNote}`)).toBe(true);
		expect(cut).not.toContain("FUNCTIONS");
		expect(prompt([a]).render()).not.toContain(cutDiffNote);
	});
});

describe("a file's facts", () => {
	const link = changed("src/link", [], { oldKind: "file", newKind: "symlink", newMode: "120000" });
	const linkFacts = "mode 100644 (file) -> 120000 (symlink); text";

	it("names a symlink's target when it was read whole, and says when it was not", () => {
		const shown = prompt([link], { "src/link": { target: "../a\u0007", truncated: false } }).renderInput();
		expect(shown.text).toContain(`src/link (modified)\n${linkFacts}; symlink target ../a\\u0007\n`);
		expect(shown.delivered.fields["src/link"]).toContain("target");
		const unread: Record<string, { target: string; truncated: boolean }>[] = [
			{ "src/link": { target: "../a", truncated: true } },
			{},
		];
		for (const targets of unread) {
			const hidden = prompt([link], targets).renderInput();
			expect(hidden.text).toContain(`${linkFacts}; symlink target not shown\n`);
			expect(hidden.delivered.fields["src/link"]).not.toContain("target");
		}
	});

	it("says a file is binary, or empty", () => {
		const binary = changed("logo.png", [], { binary: true });
		expect(prompt([binary]).render()).toContain(
			"logo.png (modified)\nmode 100644 (file) -> 100644 (file); binary\n(binary)\n",
		);
		const empty = changed("empty.json", [], { status: "added", oldMode: undefined, oldKind: undefined });
		const { text, delivered } = prompt([empty]).renderInput();
		expect(text).toContain("empty.json (added)\nmode none (none) -> 100644 (file); text; empty file\n");
		expect(delivered.fields["empty.json"]).toEqual(["status", "path", "newMode", "newKind", "binary", "empty"]);
	});
});

describe("ChangePrompt.readTargets", () => {
	let repo: string | undefined;
	afterEach(() => {
		if (repo !== undefined) removeRepository(repo);
		repo = undefined;
	});

	it("reads each symlink's target at the head, and leaves out one git cannot read", async () => {
		repo = createRepository();
		const start = commit(repo, { "a.ts": lines("a") });
		symlinkSync("a.ts", join(repo, "link"));
		symlinkSync("missing", join(repo, "broken"));
		commit(repo, { "b.ts": lines("b") });
		const changeset = await Changeset.resolve(repo, `${start}..HEAD`);
		const blob = gitIn(repo, "rev-parse", `HEAD:broken`);
		rmSync(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
		expect(await ChangePrompt.readTargets(changeset)).toEqual({ link: { target: "a.ts", truncated: false } });
	});
});

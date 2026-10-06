import {
	Adjudication,
	Comparison,
	ComparisonError,
	codexReviewSchema,
	comparisonSchema,
	defaultConfig,
	ExternalFinding,
	type ExternalFindingInput,
	externalFindingSchema,
	externalFindingsFileSchema,
	Finding,
	type FindingInput,
	maxExternalBodyLength,
	maxExternalTitleLength,
} from "@melian-agent/core";
import Value from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const revision = { base: "a".repeat(40), head: "b".repeat(40) };

// A Melian finding at `src/run.ts:12`, or wherever `input` puts it.
const melian = (input: Partial<FindingInput> = {}) =>
	Finding.create({ ...evalInput, trigger: undefined, resolution: undefined, ...input });

let position = 0;
function external(input: Partial<ExternalFindingInput> = {}): ExternalFinding {
	return ExternalFinding.create({
		reviewer: { name: "codex" },
		file: "src/run.ts",
		line: 12,
		title: "eval runs request input",
		body: "The handler passes the body to eval.",
		source: { kind: "file", path: "codex.json", position: position++ },
		...input,
	});
}

const ids = (groups: ReturnType<Comparison["groups"]>) =>
	groups.map((group) => ({ external: group.external.map((each) => each.id), melian: [...group.melian] }));

describe("comparison schema contracts", () => {
	it.each([
		["stored title", "title", 200],
		["stored body", "body", 65_536],
		["external file body", "body", 65_536],
		["Codex body", "body", 65_536],
	] as const)("enforces the exact bound for %s", (kind, field, limit) => {
		const stored = external().toJSON();
		for (const length of [limit, limit + 1]) {
			const finding = { ...stored, [field]: "x".repeat(length) };
			if (kind.startsWith("stored")) {
				expect(Value.Check(externalFindingSchema, finding)).toBe(length === limit);
			} else if (kind === "external file body") {
				expect(
					Value.Check(externalFindingsFileSchema, {
						reviewer: { name: "human" },
						findings: [{ title: "t", body: finding.body }],
					}),
				).toBe(length === limit);
			} else {
				expect(
					Value.Check(codexReviewSchema, {
						verdict: "approve",
						summary: "",
						next_steps: [],
						findings: [
							{
								severity: "low",
								title: "t",
								body: finding.body,
								file: "a.ts",
								line_start: 1,
								line_end: 1,
								confidence: 1,
								recommendation: "",
							},
						],
					}),
				).toBe(length === limit);
			}
		}
	});

	it("validates stored finding IDs and both commit hash lengths", () => {
		const stored = external().toJSON();
		for (const id of ["a".repeat(16), "x".repeat(16), "a".repeat(15), "a".repeat(17)]) {
			expect(Value.Check(externalFindingSchema, { ...stored, id })).toBe(id === "a".repeat(16));
		}
		for (const commit of ["a".repeat(40), "a".repeat(64), "x".repeat(40), "a".repeat(39), "a".repeat(65)]) {
			expect(Value.Check(externalFindingSchema, { ...stored, commit })).toBe(
				commit === "a".repeat(40) || commit === "a".repeat(64),
			);
		}
	});

	it("keeps error metadata optional and preserves a supplied cause", () => {
		const absent = new ComparisonError("invalidFile", "invalid input");
		expect(absent).toMatchObject({ name: "ComparisonError", code: "invalidFile", message: "invalid input" });
		expect(absent.path).toBeUndefined();
		expect(absent.cause).toBeUndefined();
		const cause = new Error("read failed");
		const supplied = new ComparisonError("invalidFile", "invalid input", { path: "review.json", cause });
		expect(supplied.path).toBe("review.json");
		expect(supplied.cause).toBe(cause);
	});
});

describe("ExternalFinding", () => {
	it.each([
		[{ name: "human", login: "octocat" }, "octocat"],
		[{ name: "human" }, "human"],
		[{ name: "codex", login: "octocat" }, "codex"],
		[{ name: "claude-code" }, "claude-code"],
		[{ name: "coderabbit", login: "coderabbitai[bot]", kind: "bot" }, "coderabbit"],
		[{ name: "copilot", login: "copilot-pull-request-reviewer[bot]", kind: "bot" }, "copilot"],
	] satisfies [ExternalFindingInput["reviewer"], string][])("labels reviewer %j as %s", (reviewer, label) => {
		expect(external({ reviewer }).by()).toBe(label);
	});

	it("keeps an unexpected path-reader error unchanged", () => {
		const failure = new Error("path accessor failed");
		const input: ExternalFindingInput = {
			reviewer: { name: "human" },
			title: "t",
			body: "b",
			source: { kind: "file", path: "x.json", position: 0 },
		};
		Object.defineProperty(input, "file", {
			get() {
				throw failure;
			},
		});
		expect(() => ExternalFinding.create(input)).toThrow(failure);
	});

	it("keeps an unexpected finding-construction error unchanged", () => {
		const failure = new Error("construction failed");
		const create = vi.spyOn(ExternalFinding, "create").mockImplementationOnce(() => {
			throw failure;
		});
		try {
			expect(() =>
				ExternalFinding.fromFile({ reviewer: { name: "human" }, findings: [{ title: "t", body: "b" }] }, "x.json"),
			).toThrow(failure);
		} finally {
			create.mockRestore();
		}
	});

	it("distinguishes files and length-prefixed source fields in finding IDs", () => {
		const source = { kind: "file", path: "x.json", position: 0 } as const;
		expect(external({ source, file: "src/a.ts" }).id).not.toBe(external({ source, file: "src/b.ts" }).id);
		expect(external({ source, file: undefined, line: undefined }).id).not.toBe(
			external({ source, file: undefined, line: 1 }).id,
		);
		expect(external({ source: { ...source, path: "a", ref: "refb" } }).id).not.toBe(
			external({ source: { ...source, path: "aref", ref: "b" } }).id,
		);
	});

	it("orders absent sites first, then files, lines and IDs in both directions", () => {
		const fields: Partial<ExternalFindingInput>[] = [
			{ file: undefined, line: undefined },
			{ file: "src/a.ts", line: undefined },
			{ file: "src/a.ts", line: 1 },
			{ file: "src/a.ts", line: 2 },
			{ file: "src/a.ts", line: 2 },
			{ file: "src/b.ts", line: 1 },
		];
		const ordered = fields.map((input, index) =>
			ExternalFinding.from({ ...external(input).toJSON(), id: String(index + 1).repeat(16) }),
		);
		for (const [index, first] of ordered.entries()) {
			expect(first.compareSite(first)).toBe(0);
			for (const second of ordered.slice(index + 1)) {
				expect(first.compareSite(second)).toBeLessThan(0);
				expect(second.compareSite(first)).toBeGreaterThan(0);
			}
		}
		const comparison = Comparison.of(revision);
		comparison.import("file:x.json", { findings: [...ordered].reverse(), skippedBodies: 0 }, "t");
		expect(comparison.externalFindings().map((each) => each.id)).toEqual(ordered.map((each) => each.id));
	});

	it.each([
		[{ file: undefined, line: undefined }, "(no file)"],
		[{ line: undefined }, "src/run.ts (no line)"],
		[{}, "src/run.ts:12"],
		[{ endLine: 12 }, "src/run.ts:12"],
		[{ endLine: 14 }, "src/run.ts:12-14"],
		[{ outdated: true }, "src/run.ts:12 (outdated)"],
		[{ revision: "base" }, "src/run.ts:12 (base)"],
	] satisfies [Partial<ExternalFindingInput>, string][])("renders placement %j as %s", (input, shown) => {
		expect(external(input).where()).toBe(shown);
	});

	it("refuses an empty stored title after trimming blank lines", () => {
		expect(() => external({ title: " \r\n\t\n" })).toThrow(expect.objectContaining({ code: "invalidFinding" }));
	});

	it("clamps a reversed Codex span and ignores a blank recommendation", () => {
		const [finding] = ExternalFinding.fromFile(
			{
				verdict: "needs-attention",
				summary: "",
				next_steps: [],
				findings: [
					{
						severity: "low",
						title: "t",
						body: "body",
						file: "a.ts",
						line_start: 12,
						line_end: 7,
						confidence: 0,
						recommendation: " \t\n",
					},
				],
			},
			"codex.json",
		);
		expect(finding!.line).toBe(12);
		expect(finding!.endLine).toBe(12);
		expect(finding!.body).toBe("body");
	});

	it("checks minimum lengths in exported schemas before normalisation", () => {
		const stored = Comparison.of(revision).toJSON();
		for (const field of ["base", "head"] as const) {
			expect(Value.Check(comparisonSchema, { ...stored, [field]: "" })).toBe(false);
		}
		const review = {
			verdict: "approve",
			summary: "",
			next_steps: [],
			findings: [
				{
					severity: "low",
					title: "t",
					body: "b",
					file: "a.ts",
					line_start: 1,
					line_end: 1,
					confidence: 0,
					recommendation: "",
				},
			],
		};
		expect(Value.Check(codexReviewSchema, review)).toBe(true);
		for (const field of ["title", "file"] as const) {
			expect(Value.Check(codexReviewSchema, { ...review, findings: [{ ...review.findings[0], [field]: "" }] })).toBe(
				false,
			);
		}
	});

	it.each([
		{ file: undefined },
		{ line: undefined },
		{ outdated: true },
		{ revision: "base" },
	] satisfies Partial<ExternalFindingInput>[])("has no matchable site for %j", (input) => {
		const finding = external(input);
		expect(finding.site()).toBeUndefined();
		expect(finding.meetsFinding(melian())).toBe(false);
	});

	it.each([null, undefined, 1, "file"])("refuses primitive file input %j with a typed error", (value) => {
		expect(() => ExternalFinding.fromFile(value, "x.json")).toThrow(/\(top level\)/);
		expect(() => ExternalFinding.fromFile(value, "x.json")).toThrow(
			expect.objectContaining({ code: "invalidFile", path: "x.json" }),
		);
	});

	it("keeps the first source position when identical ref-less findings deduplicate", () => {
		const finding = { file: "a.ts", line: 1, title: "t", body: "b" };
		const imported = ExternalFinding.fromFile(
			{ reviewer: { name: "human" }, findings: [finding, finding] },
			"x.json",
		);
		expect(imported.map((each) => each.source)).toEqual([{ kind: "file", path: "x.json", position: 0 }]);
	});

	it("names unknown-key containers without repeating the key's text", () => {
		const key = "private-key-text";
		for (const [value, container] of [
			[{ reviewer: { name: "human" }, findings: [], [key]: 1 }, "(top level)"],
			[{ reviewer: { name: "human", version: 1, [key]: 1 }, findings: [] }, "/reviewer"],
		] as const) {
			expect(() => ExternalFinding.fromFile(value, "x.json")).toThrow(
				`x.json is not an external-finding file: it has an unknown key in ${container}`,
			);
		}
	});

	it.each([
		["thread", { kind: "thread", thread: "PRRT_1", url: "https://github.com/o/r/pull/1#r11" }, "69adbde5d94450d9"],
		["file with a ref", { kind: "file", path: "codex.json", position: 0, ref: "A1" }, "92511b68b984b476"],
		["file without a ref", { kind: "file", path: "codex.json", position: 0 }, "f82a480419b2d1c9"],
	] as const)("pins the persistent external ID for a %s", (_name, source, expected) => {
		expect(external({ source }).id).toBe(expected);
	});

	it("hashes the source reference into its ID, so importing again gives the same ID", () => {
		const source = {
			kind: "thread",
			thread: "PRRT_1",
			url: "https://github.com/o/r/pull/1#r11",
		} as const;
		const first = external({ reviewer: { name: "coderabbit", login: "coderabbitai[bot]" }, source } as const);
		const again = external({
			reviewer: { name: "coderabbit", login: "coderabbitai[bot]" },
			source,
			title: "edited since",
			line: 40,
		} as const);
		expect(again.id).toBe(first.id);
		expect(first.id).toMatch(/^[0-9a-f]{16}$/);
		// The reviewer stays out of the ID, so naming reviewers differently later never orphans a hand record.
		expect(external({ reviewer: { name: "human", login: "octocat" }, source } as const).id).toBe(first.id);
		// Without a ref, a file's finding is known by its file, line, and title, never its position.
		const file = { kind: "file", path: "codex.json", position: 0 } as const;
		expect(external({ source: file }).id).toBe(external({ source: { ...file, position: 7 } }).id);
		expect(external({ source: file }).id).not.toBe(external({ source: file, line: 99 }).id);
		expect(external({ source: file }).id).not.toBe(external({ source: file, title: "another" }).id);
		const ref = { ...file, ref: "A1" } as const;
		expect(external({ source: ref }).id).toBe(external({ source: ref, line: 99, title: "edited" }).id);
		expect(external({ source: ref }).id).not.toBe(external({ source: file }).id);
	});

	it("identifies a thread by its node ID when its first-comment URL changes", () => {
		const source = { kind: "thread", thread: "PRRT_1", url: "https://github.com/o/r/pull/1#r11" } as const;
		const first = external({ source });
		const edited = external({ source: { ...source, url: "https://github.com/o/r/pull/1#r12" } });
		const another = external({ source: { ...source, thread: "PRRT_2" } });

		expect(edited.id).toBe(first.id);
		expect(another.id).not.toBe(first.id);
	});

	it("keeps a title to its first line and a bounded length, and its file in canonical form", () => {
		const finding = external({ title: `\n  **${"long ".repeat(100)}**\nsecond line`, file: "./src//run.ts" });
		expect(finding.title.split("\n")).toHaveLength(1);
		expect([...finding.title]).toHaveLength(maxExternalTitleLength);
		expect(finding.title.endsWith("…")).toBe(true);
		expect(finding.file).toBe("src/run.ts");
	});

	it("refuses a path outside the repository and lines that end before they start", () => {
		expect(() => external({ file: "../etc/passwd" })).toThrow(ComparisonError);
		expect(() => external({ line: 12, endLine: 10 })).toThrow(/endLine comes before its line/);
		expect(() => external({ line: undefined, endLine: 10 })).toThrow(ComparisonError);
	});

	it("round-trips through its stored JSON", () => {
		const finding = external({ endLine: 14, severity: "high", resolved: true, postedAt: "2026-10-05T01:00:00Z" });
		expect(ExternalFinding.from(JSON.parse(JSON.stringify(finding))).toJSON()).toEqual(finding.toJSON());
	});

	it("reads the external-finding file shape, keeping each finding's ref as its source", () => {
		const findings = ExternalFinding.fromFile(
			{
				reviewer: { name: "claude-code", version: "2.1" },
				findings: [
					{ ref: "A1", file: "src/a.ts", line: 3, endLine: 5, title: "One", body: "Body", severity: "P1" },
					{ title: "General", body: "No file at all" },
				],
			},
			"reviews/claude.json",
		);
		expect(findings.map((each) => each.toJSON())).toEqual([
			expect.objectContaining({
				reviewer: { name: "claude-code", version: "2.1" },
				file: "src/a.ts",
				line: 3,
				endLine: 5,
				severity: "P1",
				source: { kind: "file", path: "reviews/claude.json", position: 0, ref: "A1" },
			}),
			expect.objectContaining({
				title: "General",
				source: { kind: "file", path: "reviews/claude.json", position: 1 },
			}),
		]);
		expect(findings[1]!.site()).toBeUndefined();
	});

	it("reads Codex's adversarial review output under its own schema", () => {
		const [finding] = ExternalFinding.fromFile(
			{
				verdict: "needs-attention",
				summary: "One problem.",
				findings: [
					{
						severity: "high",
						title: "Key leaks",
						body: "The diagnostic quotes the line.",
						file: "packages/core/src/config.ts",
						line_start: 40,
						line_end: 42,
						confidence: 0.8,
						recommendation: "Drop the source line.",
					},
				],
				next_steps: [],
			},
			"codex.json",
		);
		expect(finding!.toJSON()).toMatchObject({
			reviewer: { name: "codex" },
			file: "packages/core/src/config.ts",
			line: 40,
			endLine: 42,
			severity: "high",
			body: "The diagnostic quotes the line.\n\nRecommendation: Drop the source line.",
			source: { kind: "file", path: "codex.json", position: 0 },
		});
	});

	it.each(["x", "\u{10400}"])("bounds Codex's body and recommendation on a %s boundary", (character) => {
		const suffix = "\n\nRecommendation: Fix it";
		for (const length of [maxExternalBodyLength - suffix.length, maxExternalBodyLength]) {
			const body = character.repeat(length);
			const [finding] = ExternalFinding.fromFile(
				{
					verdict: "needs-attention",
					summary: "s",
					next_steps: [],
					findings: [
						{
							severity: "high",
							title: "t",
							body,
							file: "a.ts",
							line_start: 1,
							line_end: 1,
							confidence: 0.5,
							recommendation: "Fix it",
						},
					],
				},
				"codex.json",
			);
			expect(finding!.body).toBe(
				length === maxExternalBodyLength ? `${character.repeat(maxExternalBodyLength - 1)}…` : `${body}${suffix}`,
			);
			expect([...finding!.body]).toHaveLength(maxExternalBodyLength);
		}
	});

	it("cuts a file's long title as it cuts a thread's", () => {
		const [finding] = ExternalFinding.fromFile(
			{ reviewer: { name: "human" }, findings: [{ title: "x".repeat(500), body: "" }] },
			"x.json",
		);
		expect([...finding!.title]).toHaveLength(maxExternalTitleLength);
		expect(external({ title: "x".repeat(200) }).title).toBe("x".repeat(200));
		expect(external({ title: "x".repeat(201) }).title).toBe(`${"x".repeat(199)}…`);
	});

	it.each(["external-finding", "Codex"])("checks numeric boundaries in the %s file shape", (shape) => {
		const codex = shape === "Codex";
		const finding = codex
			? {
					severity: "high",
					title: "t",
					body: "b",
					file: "a.ts",
					line_start: 1,
					line_end: 1,
					confidence: 0.5,
					recommendation: "",
				}
			: { title: "t", body: "b", line: 1 };
		const file = codex
			? { verdict: "needs-attention", summary: "", next_steps: [] }
			: { reviewer: { name: "human" } };
		const cases: { field: string; accepted: (string | number)[]; rejected: (string | number)[] }[] = [
			{
				field: "body",
				accepted: [codex ? "b" : "", "x".repeat(65_536)],
				rejected: codex ? ["", "x".repeat(65_537)] : ["x".repeat(65_537)],
			},
			{ field: "title", accepted: ["t"], rejected: [""] },
			{ field: "file", accepted: ["a", "x".repeat(4096)], rejected: ["", "x".repeat(4097)] },
			...(codex ? ["line_start", "line_end"] : ["line", "endLine"]).map((field) => ({
				field,
				accepted: [1],
				rejected: [0, 1.5],
			})),
			...(codex
				? [{ field: "confidence", accepted: [0, 1], rejected: [-0.01, 1.01] }]
				: ["severity", "ref", "postedAt"].map((field) => ({
						field,
						accepted: ["x", "x".repeat(100)],
						rejected: ["", "x".repeat(101)],
					}))),
		];
		for (const { field, accepted, rejected } of cases) {
			for (const value of accepted) {
				const imported = ExternalFinding.fromFile(
					{ ...file, findings: [{ ...finding, [field]: value }] },
					"x.json",
				);
				expect(imported, field).toHaveLength(1);
				if (field === "body") expect(imported[0]!.body).toBe(value);
			}
			for (const value of rejected) {
				expect(
					() => ExternalFinding.fromFile({ ...file, findings: [{ ...finding, [field]: value }] }, "x.json"),
					field,
				).toThrow(expect.objectContaining({ code: "invalidFile", path: "x.json" }));
			}
		}
		if (!codex) {
			for (const length of [1, 100, 101, 0]) {
				const value = {
					reviewer: { name: "human", version: "x".repeat(length) },
					findings: [{ title: "t", body: "" }],
				};
				if (length === 1 || length === 100) expect(ExternalFinding.fromFile(value, "x.json")).toHaveLength(1);
				else
					expect(() => ExternalFinding.fromFile(value, "x.json")).toThrow(
						expect.objectContaining({ code: "invalidFile" }),
					);
			}
		}
		const value = { ...file, findings: [finding] };
		expect(ExternalFinding.fromFile(value, "x".repeat(4096))).toHaveLength(1);
		for (const path of ["", "x".repeat(4097)]) {
			expect(() => ExternalFinding.fromFile(value, path)).toThrow(
				expect.objectContaining({ code: "invalidFile", path }),
			);
		}
	});

	it("checks numeric boundaries on thread metadata and source positions", () => {
		for (const field of ["login", "version"] as const) {
			for (const length of [1, 100]) {
				expect(external({ reviewer: { name: "human", [field]: "x".repeat(length) } }).reviewer[field]).toBe(
					"x".repeat(length),
				);
			}
			for (const length of [0, 101]) {
				expect(() => external({ reviewer: { name: "human", [field]: "x".repeat(length) } })).toThrow(
					expect.objectContaining({ code: "invalidFinding" }),
				);
			}
		}
		for (const [field, limit] of [
			["thread", 100],
			["url", 4096],
		] as const) {
			const source = { kind: "thread", thread: "t", url: "u" } as const;
			for (const length of [1, limit]) {
				expect(external({ source: { ...source, [field]: "x".repeat(length) } }).source).toEqual({
					...source,
					[field]: "x".repeat(length),
				});
			}
			for (const length of [0, limit + 1]) {
				expect(() => external({ source: { ...source, [field]: "x".repeat(length) } })).toThrow(
					expect.objectContaining({ code: "invalidFinding" }),
				);
			}
		}
		const source = { kind: "file", path: "x.json", position: 0 } as const;
		expect(external({ source }).source).toEqual(source);
		for (const position of [-1, 0.5]) {
			expect(() => external({ source: { ...source, position } })).toThrow(
				expect.objectContaining({ code: "invalidFinding" }),
			);
		}
		const comparison = Comparison.of(revision);
		comparison.import("file:x.json", { findings: [], skippedBodies: 0 }, "t");
		const stored = comparison.toJSON();
		expect(Value.Check(comparisonSchema, stored)).toBe(true);
		for (const skippedBodies of [-1, 0.5]) {
			expect(
				Value.Check(comparisonSchema, {
					...stored,
					imports: { "file:x.json": { at: "t", ids: [], skippedBodies } },
				}),
			).toBe(false);
		}
	});

	it.each(["external-finding", "Codex"])("refuses more than 1,000 findings in the %s file shape", (shape) => {
		const findings = Array.from({ length: 1_001 }, (_, index) => ({ title: `Finding ${index}`, body: "b" }));
		const file =
			shape === "Codex"
				? {
						verdict: "needs-attention",
						summary: "s",
						findings: findings.map((finding) => ({
							...finding,
							severity: "high",
							file: "a.ts",
							line_start: 1,
							line_end: 1,
							confidence: 0.5,
							recommendation: "",
						})),
						next_steps: [],
					}
				: { reviewer: { name: "human" }, findings };

		expect(ExternalFinding.fromFile({ ...file, findings: file.findings.slice(0, 1_000) }, "x.json")).toHaveLength(
			1_000,
		);
		expect(() => ExternalFinding.fromFile(file, "x.json")).toThrow(
			expect.objectContaining({ code: "invalidFile", path: "x.json" }),
		);
	});

	it.each([
		["a severity", { severity: "x".repeat(101) }],
		["a ref", { ref: "x".repeat(101) }],
		["a file", { file: `src/${"x".repeat(4093)}` }],
		["a posting time", { postedAt: "x".repeat(101) }],
	])("refuses %s longer than its bound", (_, field) => {
		expect(() =>
			ExternalFinding.fromFile(
				{ reviewer: { name: "codex" }, findings: [{ title: "t", body: "", ...field }] },
				"x.json",
			),
		).toThrow(expect.objectContaining({ code: "invalidFile" }));
	});

	it("refuses a reviewer's version or login longer than its bound", () => {
		expect(() =>
			ExternalFinding.fromFile({ reviewer: { name: "codex", version: "x".repeat(101) }, findings: [] }, "x.json"),
		).toThrow(expect.objectContaining({ code: "invalidFile" }));
		expect(() => external({ reviewer: { name: "human", login: "x".repeat(101) } })).toThrow(ComparisonError);
	});

	it("keeps two findings at one site under one title apart when their bodies differ, in both file shapes", () => {
		const own = (body: string) => ({ file: "src/a.ts", line: 3, title: "Possible bug", body });
		const shaped = ExternalFinding.fromFile(
			{ reviewer: { name: "claude-code" }, findings: [own("Null manager."), own("Off by one.")] },
			"claude.json",
		);
		const codex = (body: string) => ({
			severity: "high",
			title: "Possible bug",
			body,
			file: "src/a.ts",
			line_start: 3,
			line_end: 3,
			confidence: 0.5,
			recommendation: "",
		});
		const codexFindings = ExternalFinding.fromFile(
			{
				verdict: "needs-attention",
				summary: "s",
				findings: [codex("Null manager."), codex("Off by one.")],
				next_steps: [],
			},
			"codex.json",
		);
		for (const findings of [shaped, codexFindings]) {
			expect(findings).toHaveLength(2);
			const comparison = Comparison.of(revision);
			comparison.import("file:codex.json", { findings: [], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
			comparison.compare(
				new Adjudication({ findings: [melian()], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
			);
			comparison.import("file:x", { findings, skippedBodies: 0 }, "t");
			expect(comparison.externalFindings()).toHaveLength(2);
		}
		// An unchanged finding keeps its ID when a rerun moves it in the file.
		const rerun = ExternalFinding.fromFile(
			{ reviewer: { name: "claude-code" }, findings: [own("Off by one."), own("Null manager.")] },
			"claude.json",
		);
		expect(rerun.map((each) => each.id).sort()).toEqual(shaped.map((each) => each.id).sort());
	});

	it("refuses a file that repeats a ref, and keeps one of two findings alike", () => {
		expect(() =>
			ExternalFinding.fromFile(
				{
					reviewer: { name: "codex" },
					findings: [
						{ ref: "A1", title: "one", body: "" },
						{ ref: "A1", title: "two", body: "" },
					],
				},
				"x.json",
			),
		).toThrow(
			expect.objectContaining({
				code: "invalidFile",
				message: "x.json: finding 1 repeats an earlier finding's ref",
			}),
		);
		const twice = { file: "src/a.ts", line: 3, title: "same", body: "" };
		expect(
			ExternalFinding.fromFile({ reviewer: { name: "codex" }, findings: [twice, twice] }, "x.json"),
		).toHaveLength(1);
	});

	it("deduplicates ref-less findings whose file spellings canonicalise alike", () => {
		const finding = { file: "src/run.ts", line: 12, title: "same", body: "same body" };
		const imported = ExternalFinding.fromFile(
			{ reviewer: { name: "codex" }, findings: [finding, { ...finding, file: "./src//run.ts" }] },
			"codex.json",
		);

		expect(imported).toHaveLength(1);
		expect(imported[0]!.file).toBe("src/run.ts");
	});

	it("refuses a file in neither shape, naming the file and what is wrong", () => {
		expect(() => ExternalFinding.fromFile({ findings: [] }, "x.json")).toThrow(
			/x\.json is not an external-finding file: it .*reviewer/,
		);
		expect(() =>
			ExternalFinding.fromFile(
				{ reviewer: { name: "codex" }, findings: [{ title: "t", body: "", extra: 1 }] },
				"x.json",
			),
		).toThrow(/unknown key in \/findings\/0$/);
		expect(() =>
			ExternalFinding.fromFile(
				{ reviewer: { name: "codex" }, findings: [{ title: "t", body: "", file: "/abs.ts", line: 1 }] },
				"x.json",
			),
		).toThrow(/x\.json: finding 0: /);
		expect(() =>
			ExternalFinding.fromFile({ verdict: "approve", summary: "", findings: [{}], next_steps: [] }, "c.json"),
		).toThrow(/c\.json is not Codex's review output/);
	});
});

describe("Comparison matching", () => {
	it.each([
		["three lines apart", { line: 30 }, { line: 33 }, true],
		["four lines apart", { line: 30 }, { line: 34 }, false],
		["far apart", { line: 30 }, { line: 100 }, false],
		["overlapping spans", { line: 30, endLine: 80 }, { line: 60, endLine: 100 }, true],
		["near a span's end", { line: 30, endLine: 80 }, { line: 83 }, true],
		["past a span's end", { line: 30, endLine: 80 }, { line: 84 }, false],
		["different files", { file: "src/a.ts", line: 30 }, { file: "src/b.ts", line: 30 }, false],
		["missing file", { file: undefined }, { line: 12 }, false],
		["missing line", { line: undefined }, { line: 12 }, false],
		["outdated", { outdated: true }, { line: 12 }, false],
		["at base", { revision: "base" }, { line: 12 }, false],
	] satisfies [string, Partial<ExternalFindingInput>, Partial<ExternalFindingInput>, boolean][])(
		"groups different reviewers only at a matchable site: %s",
		(_, first, second, grouped) => {
			const codex = external({ ...first, source: { kind: "file", path: "codex.json", position: 0, ref: "A" } });
			const claude = external({
				...second,
				reviewer: { name: "claude-code" },
				source: { kind: "file", path: "claude.json", position: 0, ref: "B" },
			});
			expect(codex.meets(claude)).toBe(grouped);
			expect(claude.meets(codex)).toBe(grouped);
			const comparison = Comparison.of(revision);
			comparison.import("file:reviews", { findings: [claude, codex], skippedBodies: 0 }, "t");
			comparison.compare(
				new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
			);
			expect(comparison.externalOnly()).toHaveLength(grouped ? 1 : 2);
			expect(comparison.matched()).toEqual([]);
			expect(comparison.render(undefined)).toContain("\nExternal only:\n");
			expect(comparison.render(undefined)).not.toContain("\nMatched:\n");
			expect(
				comparison
					.externalOnly()
					.flatMap((group) => group.external.map((each) => each.id))
					.sort(),
			).toEqual([codex.id, claude.id].sort());
			expect(comparison.render(undefined)).toContain(`External only: ${grouped ? 1 : 2}. Melian only: 0.`);
		},
	);

	it("reads only its own external IDs, including before the first import", () => {
		const comparison = Comparison.of(revision);
		expect(comparison.externalFinding("toString")).toBeUndefined();
		expect(comparison.externalFinding("0".repeat(16))).toBeUndefined();
		const finding = external();
		comparison.import("file:codex.json", { findings: [finding], skippedBodies: 0 }, "t");
		expect(comparison.externalFinding(finding.id)?.toJSON()).toEqual(finding.toJSON());
	});

	it("replaces an earlier unmatch of the same pair", () => {
		const finding = melian();
		const outside = external();
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [outside], skippedBodies: 0 }, "t");
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		comparison.unmatch(outside.id, finding.id, "first", "t1");
		comparison.unmatch(outside.id, finding.id, "second", "t2");
		expect(comparison.toJSON().unmatches).toEqual([
			{ external: outside.id, melian: finding.id, by: "second", at: "t2" },
		]);
		expect(comparison.effectiveMatches()).toEqual([]);
	});

	it("keeps another pair's unmatch when replacing one", () => {
		const first = melian();
		const second = melian({ startLine: 14, endLine: 14, snippet: "eval(second)" });
		const outside = external({ line: 13 });
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [outside], skippedBodies: 0 }, "t");
		comparison.compare(
			new Adjudication({ findings: [first, second], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		comparison.unmatch(outside.id, first.id, "M", "t1");
		comparison.unmatch(outside.id, second.id, "M", "t2");
		comparison.unmatch(outside.id, first.id, "other", "t3");
		expect(comparison.toJSON().unmatches).toEqual([
			{ external: outside.id, melian: second.id, by: "M", at: "t2" },
			{ external: outside.id, melian: first.id, by: "other", at: "t3" },
		]);
		comparison.compare(
			new Adjudication({ findings: [first, second], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.effectiveMatches()).toEqual([]);
	});

	it("ignores stale hand matches while retaining their stored history", () => {
		const finding = melian();
		const outside = external();
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [outside], skippedBodies: 0 }, "t");
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		const matches = [
			{ external: outside.id, melian: finding.id, kind: "hand" as const, by: "M", at: "t" },
			{ external: "0".repeat(16), melian: finding.id, kind: "hand" as const, by: "M", at: "t" },
			{ external: outside.id, melian: "f".repeat(16), kind: "hand" as const, by: "M", at: "t" },
		];
		const restored = Comparison.from({ ...comparison.toJSON(), matches });
		expect(restored.effectiveMatches()).toEqual([matches[0]]);
		expect(restored.toJSON().matches).toEqual(matches);
		expect(ids(restored.groups())).toEqual([{ external: [outside.id], melian: [finding.id] }]);
	});

	it.each([undefined, 0, 2])("renders skipped review bodies only when supplied: %s", (skipped) => {
		const comparison = Comparison.of(revision);
		const suffix = skipped === undefined ? "" : ` Skipped review bodies: ${skipped}.`;
		expect(comparison.render(undefined, skipped)).toBe(
			`Matched: 0 external findings, covering 0 Melian findings. External only: 0. Melian only: 0.${suffix}\n`,
		);
	});

	it("replaces a site match and then an earlier hand match without duplicating the pair", () => {
		const finding = melian();
		const outside = external();
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [outside], skippedBodies: 0 }, "t");
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		comparison.match(outside.id, finding.id, "first", "t1");
		expect(comparison.effectiveMatches()).toEqual([
			{ external: outside.id, melian: finding.id, kind: "hand", by: "first", at: "t1" },
		]);
		comparison.match(outside.id, finding.id, "second", "t2");
		expect(comparison.effectiveMatches()).toEqual([
			{ external: outside.id, melian: finding.id, kind: "hand", by: "second", at: "t2" },
		]);
	});

	it("keeps a Melian-only group out of matched groups and their rendered section", () => {
		const finding = melian();
		const comparison = Comparison.of(revision);
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.matched()).toEqual([]);
		expect(comparison.externalOnly()).toEqual([]);
		expect(comparison.melianOnly()).toEqual([finding.id]);
		expect(comparison.render(undefined)).toBe(
			`Matched: 0 external findings, covering 0 Melian findings. External only: 0. Melian only: 1.\nMelian only:\n  ${finding.id}\n`,
		);
	});

	it("stores duplicate input IDs once and keeps the final imported value", () => {
		const source = { kind: "file", path: "x.json", position: 0, ref: "A" } as const;
		const first = external({ source, title: "first" });
		const last = external({ source, title: "last" });
		const comparison = Comparison.of(revision);
		comparison.import("file:x.json", { findings: [first, last], skippedBodies: 0 }, "t");
		expect(comparison.externalFindings().map((each) => each.toJSON())).toEqual([last.toJSON()]);
		expect(comparison.importsBySource()).toEqual({ "file:x.json": { at: "t", ids: [last.id], skippedBodies: 0 } });
	});

	it("counts a repeated Melian finding and its generated pair once", () => {
		const finding = melian();
		const outside = external();
		const verdict = new Adjudication({
			findings: [finding],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		const shown = verdict.attention()[0]!;
		const attention = vi.spyOn(verdict, "attention").mockReturnValue([shown, shown]);
		try {
			const comparison = Comparison.of(revision);
			comparison.import("file:x.json", { findings: [outside], skippedBodies: 0 }, "t");
			comparison.compare(verdict);
			expect(comparison.melianFindings()).toEqual([finding.id]);
			expect(comparison.effectiveMatches()).toEqual([{ external: outside.id, melian: finding.id, kind: "site" }]);
			expect(ids(comparison.groups())).toEqual([{ external: [outside.id], melian: [finding.id] }]);
		} finally {
			attention.mockRestore();
		}
	});

	it("keeps ambiguity local to each external finding when hand and site pairs coexist", () => {
		const first = melian();
		const second = melian({ startLine: 15, endLine: 15, snippet: "eval(second)" });
		const third = melian({ startLine: 40, endLine: 40, snippet: "eval(third)" });
		const near = external({ line: 13 });
		const far = external({ line: 90 });
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [near, far], skippedBodies: 0 }, "t");
		comparison.compare(
			new Adjudication({
				findings: [first, second, third],
				manifest: [],
				checks: [],
				config: defaultConfig,
			}).adjudicate(),
		);
		comparison.match(far.id, first.id, "M", "t1");
		comparison.match(far.id, third.id, "M", "t1");
		expect(comparison.ambiguous()).toEqual([{ external: near, melian: [first.id, second.id].sort() }]);
	});

	it("lists a uniquely matched external finding beside its Melian finding, with its reviewer and site", () => {
		const finding = melian();
		const outside = external({ line: 11, endLine: 13 });
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [outside], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.ambiguous()).toEqual([]);
		expect(
			comparison.render(
				new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
			),
		).toContain(`Matched:\n  ${finding.id}\n    ${outside.id}  codex  src/run.ts:11-13\n`);
	});

	it("matches by site: the same file, with lines that overlap", () => {
		const finding = melian();
		const outside = external({ line: 11, endLine: 13 });
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [outside], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.effectiveMatches()).toEqual([{ external: outside.id, melian: finding.id, kind: "site" }]);
		expect(ids(comparison.matched())).toEqual([{ external: [outside.id], melian: [finding.id] }]);
		expect(comparison.externalOnly()).toEqual([]);
		expect(comparison.melianOnly()).toEqual([]);
	});

	it("matches lines within three of each other, and not four", () => {
		const finding = melian();
		const three = external({ line: 15 });
		const four = external({ line: 16 });
		const before = external({ line: 6, endLine: 9 });
		const comparison = Comparison.of(revision);
		comparison.import(
			"file:codex.json",
			{ findings: [three, four, before], skippedBodies: 0 },
			"2026-10-05T00:00:00.000Z",
		);
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.effectiveMatches().map((match) => match.external)).toEqual([three.id, before.id].sort());
		expect(ids(comparison.externalOnly())).toEqual([{ external: [four.id], melian: [] }]);
	});

	it("leaves a silent finding out of the comparison, since the author never saw it", () => {
		const nit = melian({ severity: "nit" });
		const near = external({ line: 12 });
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [near], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [nit], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.melianFindings()).toEqual([]);
		expect(comparison.effectiveMatches()).toEqual([]);
		expect(ids(comparison.externalOnly())).toEqual([{ external: [near.id], melian: [] }]);
		expect(comparison.melianOnly()).toEqual([]);
	});

	it.each([true, false])("includes and labels a dismissed Melian finding (matched: %s)", (matched) => {
		const finding = melian({ status: "dismissed" });
		const verdict = new Adjudication({
			findings: [finding],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		expect(verdict.attention()).toEqual([]);
		expect(verdict.dismissed.map((each) => each.id)).toEqual([finding.id]);
		const outside = external();
		const comparison = Comparison.of(revision);
		comparison.import(
			"file:codex.json",
			{ findings: matched ? [outside] : [], skippedBodies: 0 },
			"2026-10-05T00:00:00.000Z",
		);
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.melianFindings()).toEqual([finding.id]);
		if (matched) {
			expect(comparison.effectiveMatches()).toEqual([{ external: outside.id, melian: finding.id, kind: "site" }]);
			expect(comparison.render(verdict)).toContain(`Matched:\n  ${finding.id}  (dismissed)\n`);
		} else {
			expect(comparison.melianOnly()).toEqual([finding.id]);
			expect(comparison.render(verdict)).toContain(
				`Melian only:\n  ${finding.id}  P1 no-eval  src/run.ts:12  (dismissed)\n`,
			);
		}
	});

	it("site-matches a thread only when its reviewer read the compared head, and says why another waits", () => {
		const finding = melian();
		const thread = (id: string, commit: string) =>
			external({
				reviewer: { name: "coderabbit", login: "coderabbitai[bot]", kind: "bot" },
				source: { kind: "thread", thread: id, url: `https://github.com/o/r/pull/1#${id}` },
				commit,
			});
		const current = thread("PRRT_now", revision.head);
		const earlier = thread("PRRT_then", "c".repeat(40));
		const comparison = Comparison.of(revision);
		comparison.import(
			"file:codex.json",
			{ findings: [current, earlier], skippedBodies: 0 },
			"2026-10-05T00:00:00.000Z",
		);
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.effectiveMatches()).toEqual([{ external: current.id, melian: finding.id, kind: "site" }]);
		expect(ids(comparison.externalOnly())).toEqual([{ external: [earlier.id], melian: [] }]);
		expect(comparison.render(undefined)).toContain(`(read at ${"c".repeat(12)}; match it by hand)`);
		comparison.match(earlier.id, finding.id, "M", "t");
		expect(comparison.externalOnly()).toEqual([]);
	});

	it("never matches another file", () => {
		const comparison = Comparison.of(revision);
		comparison.import(
			"file:codex.json",
			{ findings: [external({ file: "src/other.ts" })], skippedBodies: 0 },
			"2026-10-05T00:00:00.000Z",
		);
		comparison.compare(
			new Adjudication({ findings: [melian()], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.effectiveMatches()).toEqual([]);
		expect(comparison.melianOnly()).toEqual([melian().id]);
	});

	it("matches a Melian finding's cause location at head, but not one at the base or its context", () => {
		const finding = melian({
			cause: "affected",
			evidence: [
				{ file: "src/api.ts", startLine: 3, role: "cause", revision: "head", snippet: "x" },
				{ file: "src/old.ts", startLine: 3, role: "cause", revision: "base", snippet: "x" },
				{ file: "src/context.ts", startLine: 3, role: "context", revision: "head", snippet: "x" },
			],
		});
		const atCause = external({ file: "src/api.ts", line: 4 });
		const atBase = external({ file: "src/old.ts", line: 3 });
		const atContext = external({ file: "src/context.ts", line: 3 });
		const comparison = Comparison.of(revision);
		comparison.import(
			"file:codex.json",
			{ findings: [atCause, atBase, atContext], skippedBodies: 0 },
			"2026-10-05T00:00:00.000Z",
		);
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.effectiveMatches().map((match) => match.external)).toEqual([atCause.id]);
	});

	it("matches the end of a cause-evidence span and its three-line margin", () => {
		const finding = melian({
			file: "src/run.ts",
			cause: "affected",
			evidence: [{ file: "src/api.ts", startLine: 3, endLine: 20, role: "cause", revision: "head", snippet: "x" }],
		});
		const atEnd = external({ file: "src/api.ts", line: 20 });
		const nearEnd = external({ file: "src/api.ts", line: 23 });
		const pastEnd = external({ file: "src/api.ts", line: 24 });
		const comparison = Comparison.of(revision);
		comparison.import(
			"file:codex.json",
			{ findings: [atEnd, nearEnd, pastEnd], skippedBodies: 0 },
			"2026-10-06T00:00:00.000Z",
		);
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.effectiveMatches()).toHaveLength(2);
		expect(comparison.effectiveMatches()).toEqual(
			expect.arrayContaining([
				{ external: atEnd.id, melian: finding.id, kind: "site" },
				{ external: nearEnd.id, melian: finding.id, kind: "site" },
			]),
		);
		expect(ids(comparison.matched())).toEqual([{ external: [atEnd.id, nearEnd.id], melian: [finding.id] }]);
		expect(ids(comparison.externalOnly())).toEqual([{ external: [pastEnd.id], melian: [] }]);
		expect(comparison.melianOnly()).toEqual([]);
	});

	it("matches a finding with no line, an outdated one, or one on the base side only by hand", () => {
		const finding = melian();
		const noLine = external({ line: undefined });
		const outdated = external({ outdated: true });
		const base = external({ revision: "base" });
		const comparison = Comparison.of(revision);
		comparison.import(
			"file:codex.json",
			{ findings: [noLine, outdated, base], skippedBodies: 0 },
			"2026-10-05T00:00:00.000Z",
		);
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.effectiveMatches()).toEqual([]);
		comparison.match(noLine.id, finding.id, "Maintainer <m@example.com>", "2026-10-05T02:00:00Z");
		expect(comparison.effectiveMatches()).toEqual([
			{
				external: noLine.id,
				melian: finding.id,
				kind: "hand",
				by: "Maintainer <m@example.com>",
				at: "2026-10-05T02:00:00Z",
			},
		]);
	});

	it("counts a defect once when several reviewers report it at one Melian finding", () => {
		const finding = melian();
		const codex = external({ line: 12 });
		const rabbit = external({
			reviewer: { name: "coderabbit", login: "coderabbitai[bot]" },
			line: 13,
			source: { kind: "thread", thread: "PRRT_9", url: "https://github.com/o/r/pull/1#r9" },
		});
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [codex, rabbit], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.matched()).toHaveLength(1);
		expect(ids(comparison.matched())[0]!.external.sort()).toEqual([codex.id, rabbit.id].sort());
	});

	it("groups external-only findings from different reviewers at one site, and keeps one reviewer's two apart", () => {
		const codex = external({ file: "src/b.ts", line: 30 });
		const codexAgain = external({ file: "src/b.ts", line: 31 });
		const claude = external({ reviewer: { name: "claude-code" }, file: "src/b.ts", line: 33 });
		const comparison = Comparison.of(revision);
		comparison.import(
			"file:codex.json",
			{ findings: [codex, codexAgain, claude], skippedBodies: 0 },
			"2026-10-05T00:00:00.000Z",
		);
		comparison.compare(
			new Adjudication({ findings: [melian()], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		// In site order: Codex at 30 starts a group, Codex at 31 cannot join it, and Claude Code at 33 joins the first.
		expect(ids(comparison.externalOnly())).toEqual([
			{ external: [codex.id, claude.id], melian: [] },
			{ external: [codexAgain.id], melian: [] },
		]);
		const apart = Comparison.of(revision);
		apart.import("file:codex.json", { findings: [codex, codexAgain], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		apart.compare(
			new Adjudication({ findings: [melian()], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(apart.externalOnly()).toHaveLength(2);
	});

	it("knows a reviewer by its name and login, ignoring the login's case", () => {
		const human = (login: string, line: number) =>
			external({ reviewer: { name: "human", login }, file: "src/b.ts", line });
		const octocat = human("octocat", 10);
		expect(octocat.sameReviewer(human("OctoCat", 11))).toBe(true);
		expect(octocat.sameReviewer(human("hubot", 11))).toBe(false);
		expect(octocat.sameReviewer(external({ reviewer: { name: "codex" }, file: "src/b.ts", line: 11 }))).toBe(false);
		const differentLogin = Comparison.of(revision);
		differentLogin.import(
			"file:codex.json",
			{ findings: [octocat, human("hubot", 11)], skippedBodies: 0 },
			"2026-10-05T00:00:00.000Z",
		);
		differentLogin.compare(
			new Adjudication({ findings: [melian()], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(differentLogin.externalOnly()).toHaveLength(1);
		const sameLogin = Comparison.of(revision);
		sameLogin.import(
			"file:codex.json",
			{ findings: [octocat, human("OctoCat", 11)], skippedBodies: 0 },
			"2026-10-05T00:00:00.000Z",
		);
		sameLogin.compare(
			new Adjudication({ findings: [melian()], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(sameLogin.externalOnly()).toHaveLength(2);
	});

	it("does not group a finding read at an earlier commit with another reviewer's finding at the same site", () => {
		const thread = (line: number) =>
			external({
				reviewer: { name: "coderabbit", login: "coderabbitai[bot]", kind: "bot" },
				source: { kind: "thread", thread: `PRRT_${line}`, url: `https://github.com/o/r/pull/1#PRRT_${line}` },
				line,
				commit: "c".repeat(40),
			});
		const peer = external({ reviewer: { name: "claude-code" }, line: 12 });
		// Findings group in site order, so the earlier thread comes before the peer and after it.
		for (const line of [11, 13]) {
			const earlier = thread(line);
			expect(earlier.meets(peer)).toBe(true);
			const comparison = Comparison.of(revision);
			comparison.import(
				"file:codex.json",
				{ findings: [earlier, peer], skippedBodies: 0 },
				"2026-10-05T00:00:00.000Z",
			);
			comparison.compare(
				new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
			);
			expect(ids(comparison.externalOnly())).toEqual(
				[earlier, peer].sort((a, b) => a.compareSite(b)).map((each) => ({ external: [each.id], melian: [] })),
			);
		}
	});

	it("keeps a reviewer's finding unmatched by hand out of the group another reviewer's match makes", () => {
		const finding = melian();
		const codex = external({ line: 12 });
		const claude = external({ reviewer: { name: "claude-code" }, line: 13 });
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [codex, claude], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		comparison.unmatch(claude.id, finding.id, "M", "t");
		expect(ids(comparison.matched())).toEqual([{ external: [codex.id], melian: [finding.id] }]);
		expect(ids(comparison.externalOnly())).toEqual([{ external: [claude.id], melian: [] }]);
	});

	it("matches an external finding with each of two Melian findings near it, and never merges them", () => {
		const first = melian();
		const second = melian({ snippet: "eval(other)", startLine: 15, endLine: 15 });
		const between = external({ line: 13, endLine: 14 });
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [between], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [first, second], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(ids(comparison.matched())).toEqual([
			{ external: [between.id], melian: [first.id] },
			{ external: [between.id], melian: [second.id] },
		]);
		expect(comparison.melianOnly()).toEqual([]);
		expect(comparison.externalOnly()).toEqual([]);
		// Counted once, and marked for the maintainer, since proximity cannot say which defect the reviewer meant.
		const shown = comparison.render(undefined);
		expect(shown).toMatch(
			/^Matched: 1 external finding, covering 2 Melian findings\. External only: 0\. Melian only: 0\.\n/,
		);
		expect(comparison.ambiguous().map((each) => each.external.id)).toEqual([between.id]);
		expect(shown).toContain(
			`Ambiguous, near several Melian findings; match or unmatch by hand:\n  ${between.id}  codex`,
		);
		comparison.unmatch(between.id, second.id, "M", "t");
		expect(comparison.ambiguous()).toEqual([]);
		expect(comparison.render(undefined)).toMatch(
			/^Matched: 1 external finding, covering 1 Melian finding\. External only: 0\. Melian only: 1\./,
		);
	});

	it("keeps a mechanical pairing ambiguous after a hand match settles only the other pair", () => {
		const first = melian();
		const second = melian({ snippet: "eval(other)", startLine: 15, endLine: 15 });
		const between = external({ line: 13, endLine: 14 });
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [between], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [first, second], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		comparison.match(between.id, first.id, "M", "t");
		comparison.compare(
			new Adjudication({ findings: [first, second], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(
			comparison
				.effectiveMatches()
				.map((match) => match.kind)
				.sort(),
		).toEqual(["hand", "site"]);
		expect(comparison.ambiguous()).toEqual([{ external: between, melian: [first.id, second.id].sort() }]);
		expect(comparison.render(undefined)).toContain(
			`  ${between.id}  codex  src/run.ts:13-14  near ${[first.id, second.id].sort().join(", ")}\n`,
		);
		comparison.unmatch(between.id, second.id, "M", "t2");
		expect(comparison.ambiguous()).toEqual([]);
	});

	it("does not call a finding ambiguous that a maintainer matched by hand to two Melian findings", () => {
		const first = melian();
		const second = melian({ snippet: "eval(other)", startLine: 40, endLine: 40 });
		const far = external({ line: 90 });
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [far], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [first, second], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		comparison.match(far.id, first.id, "M", "t1");
		comparison.match(far.id, second.id, "M", "t2");
		expect(comparison.effectiveMatches().filter((match) => match.kind === "hand")).toHaveLength(2);
		expect(comparison.ambiguous()).toEqual([]);
		expect(comparison.render(undefined)).not.toContain("Ambiguous");
	});

	it("lists each Melian-only finding with its ID, severity, rule, and place, or its ID alone without the verdict", () => {
		const finding = melian();
		const comparison = Comparison.of(revision);
		comparison.import(
			"file:codex.json",
			{ findings: [external({ file: "src/far.ts", line: 90 })], skippedBodies: 0 },
			"2026-10-05T00:00:00.000Z",
		);
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(
			comparison.render(
				new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
			),
		).toContain(`Melian only:\n  ${finding.id}  P1 no-eval  src/run.ts:12\n`);
		expect(comparison.render(undefined)).toContain(`Melian only:\n  ${finding.id}\n`);
		const spanning = melian({ startLine: 20, endLine: 24 });
		const spanningComparison = Comparison.of(revision);
		spanningComparison.import("file:codex.json", { findings: [], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		spanningComparison.compare(
			new Adjudication({ findings: [spanning], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(
			spanningComparison.render(
				new Adjudication({ findings: [spanning], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
			),
		).toContain(`  ${spanning.id}  P1 no-eval  src/run.ts:20-24\n`);
	});

	it("lets an unmatch override a site match, and keeps both kinds of hand record across a re-import", () => {
		const finding = melian();
		const other = melian({ snippet: "eval(other)", startLine: 40, endLine: 40 });
		const near = external({ line: 12 });
		const far = external({ line: 40, file: "src/far.ts" });
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [near, far], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [finding, other], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		comparison.unmatch(near.id, finding.id, "M", "t1");
		comparison.match(far.id, other.id, "M", "t2");
		const again = Comparison.from(comparison.toJSON());
		again.import("file:codex.json", { findings: [near, far], skippedBodies: 0 }, "t3");
		again.compare(
			new Adjudication({ findings: [finding, other], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(again.effectiveMatches()).toEqual([
			{ external: far.id, melian: other.id, kind: "hand", by: "M", at: "t2" },
		]);
		expect(again.melianOnly()).toEqual([finding.id]);
		expect(ids(again.externalOnly())).toEqual([{ external: [near.id], melian: [] }]);
		again.match(near.id, finding.id, "M", "t4");
		expect(again.toJSON().unmatches).toEqual([]);
		again.unmatch(far.id, other.id, "M", "t5");
		expect(again.effectiveMatches().map((match) => match.external)).toEqual([near.id]);
	});

	it("keeps a field a newer Melian stored, through an import and a comparison", () => {
		const finding = melian();
		const original = Comparison.of(revision);
		original.import("file:codex.json", { findings: [], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		original.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		const stored = { ...original.toJSON(), adjudications: { later: { verdict: "valid" } } };
		const comparison = Comparison.from(stored);
		comparison.import("file:codex.json", { findings: [external()], skippedBodies: 0 }, "t");
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.toJSON()).toMatchObject({ adjudications: { later: { verdict: "valid" } } });
	});

	it("refuses a hand match naming a finding it does not hold", () => {
		const finding = melian();
		const near = external();
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [near], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(() => comparison.match("0".repeat(16), finding.id, "M", "t")).toThrow(
			expect.objectContaining({ code: "unknownExternal" }),
		);
		expect(() => comparison.unmatch(near.id, "f".repeat(16), "M", "t")).toThrow(
			expect.objectContaining({ code: "unknownMelian" }),
		);
	});

	it("updates a re-imported finding in place rather than adding another, and records each source's import", () => {
		const finding = melian();
		const source = { kind: "file", path: "codex.json", position: 0, ref: "A1" } as const;
		const comparison = Comparison.of(revision);
		comparison.import(
			"file:codex.json",
			{ findings: [external({ source })], skippedBodies: 0 },
			"2026-10-05T00:00:00.000Z",
		);
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		const moved = external({ source, line: 60 });
		comparison.import("file:codex.json", { findings: [moved], skippedBodies: 2 }, "later");
		comparison.compare(
			new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		expect(comparison.externalFindings()).toHaveLength(1);
		expect(comparison.externalFindings()[0]!.line).toBe(60);
		expect(comparison.effectiveMatches()).toEqual([]);
		expect(comparison.importsBySource()).toEqual({
			"file:codex.json": { at: "later", ids: [moved.id], skippedBodies: 2 },
		});
	});

	it("replaces what a source last imported, dropping a withdrawn finding and its hand records", () => {
		const finding = melian();
		const other = melian({ snippet: "eval(other)", startLine: 40, endLine: 40 });
		const file = (line: number, title: string) => ({ file: "src/run.ts", line, title, body: "b" });
		const first = ExternalFinding.fromFile(
			{ reviewer: { name: "codex" }, findings: [file(12, "kept"), file(40, "withdrawn"), file(90, "also gone")] },
			"codex.json",
		);
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [finding, other], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		comparison.import("file:codex.json", { findings: first, skippedBodies: 0 }, "t1");
		comparison.compare(
			new Adjudication({ findings: [finding, other], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		comparison.match(first[1]!.id, other.id, "M", "t2");
		comparison.unmatch(first[2]!.id, finding.id, "M", "t2");
		const second = ExternalFinding.fromFile(
			{ reviewer: { name: "codex" }, findings: [file(12, "kept")] },
			"codex.json",
		);

		comparison.import("file:codex.json", { findings: second, skippedBodies: 0 }, "t3");
		comparison.compare(
			new Adjudication({ findings: [finding, other], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);

		expect(second[0]!.id).toBe(first[0]!.id);
		expect(comparison.externalFindings().map((each) => each.id)).toEqual([first[0]!.id]);
		expect(comparison.toJSON().matches).toEqual([{ external: first[0]!.id, melian: finding.id, kind: "site" }]);
		expect(comparison.toJSON().unmatches).toEqual([]);
		expect(comparison.importsBySource()["file:codex.json"]!.ids).toEqual([first[0]!.id]);
	});

	it("keeps a finding another source still holds when one source withdraws it", () => {
		const shared = external({
			source: { kind: "thread", thread: "PRRT_1", url: "https://github.com/o/r/pull/1#r1" },
		});
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", { findings: [], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.compare(
			new Adjudication({ findings: [melian()], manifest: [], checks: [], config: defaultConfig }).adjudicate(),
		);
		comparison.import("github:coderabbitai[bot]", { findings: [shared], skippedBodies: 0 }, "t1");
		comparison.import("github:coderabbitai", { findings: [shared], skippedBodies: 0 }, "t2");
		comparison.import("github:coderabbitai[bot]", { findings: [], skippedBodies: 0 }, "t3");
		expect(comparison.externalFindings().map((each) => each.id)).toEqual([shared.id]);
	});
});

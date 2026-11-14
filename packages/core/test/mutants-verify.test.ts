import { describe, expect, it } from "vitest";
import {
	answerHash,
	type MutantAnswer,
	MutantsVerdict,
	MutantsVerifyError,
	type MutantsVerifyInput,
	type MutationInventoryRow,
} from "../src/index.ts";

const tree = "a".repeat(64);
const other = "b".repeat(64);
const head = "c".repeat(40);

function row(id: string, overrides: Partial<MutationInventoryRow> = {}): MutationInventoryRow {
	return {
		id: id.repeat(64).slice(0, 64),
		file: "src/a.ts",
		line: 2,
		column: 9,
		endLine: 2,
		endColumn: 14,
		mutatorName: "EqualityOperator",
		replacement: "n >= 0",
		status: "generated",
		...overrides,
	};
}

function reported(
	rows: readonly MutationInventoryRow[],
	status: string,
	extra: { killedBy?: string[]; shift?: number } = {},
): string {
	const shift = extra.shift ?? 1;
	const files: Record<string, { mutants: unknown[] }> = {};
	for (const each of rows) {
		files[each.file] ??= { mutants: [] };
		files[each.file]!.mutants.push({
			id: each.id.slice(0, 4),
			mutatorName: each.mutatorName,
			replacement: each.replacement,
			location: {
				start: { line: each.line, column: each.column + shift },
				end: { line: each.endLine, column: each.endColumn + shift },
			},
			status,
			...(extra.killedBy === undefined ? {} : { killedBy: extra.killedBy }),
		});
	}
	return JSON.stringify({ files, testFiles: { "test/a.test.ts": { tests: [{ id: "0", name: "a works" }] } } });
}

function input(overrides: Partial<MutantsVerifyInput> = {}): MutantsVerifyInput {
	return {
		head,
		tree,
		files: ["src/a.ts"],
		mutants: [row("1")],
		setAside: [],
		report: undefined,
		noTests: false,
		endCheck: {},
		answers: undefined,
		...overrides,
	};
}

function answers(...each: MutantAnswer[]): string {
	return `version: 1\nanswers:\n${each.map((answer) => `  - ${JSON.stringify(answer)}`).join("\n")}\n`;
}

const equivalent = (mutant: string, at = tree): Extract<MutantAnswer, { kind: "equivalent" }> => ({
	mutant,
	kind: "equivalent",
	reason: "n is never 0 here",
	tree: at,
});

describe("MutantsVerdict.decide", () => {
	it("cannot decide a run over no listed file", () => {
		const verdict = MutantsVerdict.decide(input({ files: [] }));
		expect(verdict.exitCode()).toBe(2);
		expect(verdict.undecided).toBe("no file was listed, so nothing was proved");
	});

	it("cannot decide listed files that hold neither a mutant nor a set-aside file", () => {
		const verdict = MutantsVerdict.decide(input({ mutants: [] }));
		expect(verdict.exitCode()).toBe(2);
		expect(verdict.undecided).toMatch(/hold no mutant and no set-aside file/);
	});

	it("decides a listed file that holds only a set-aside entry", () => {
		const verdict = MutantsVerdict.decide(
			input({ mutants: [], setAside: [{ file: "src/a.ts", reason: "configuration" }] }),
		);
		expect(verdict.exitCode()).toBe(1);
		expect(verdict.lines).toEqual([{ kind: "file", file: "src/a.ts", outcome: "unsettled", note: "configuration" }]);
	});

	it("cannot decide when Stryker wrote no report without saying it found no test", () => {
		const verdict = MutantsVerdict.decide(input({ report: undefined, noTests: false }));
		expect(verdict.exitCode()).toBe(2);
		expect(verdict.undecided).toMatch(/Stryker wrote no report/);
	});

	it("counts every mutant uncovered when the dry run found no test", () => {
		const verdict = MutantsVerdict.decide(input({ report: undefined, noTests: true }));
		expect(verdict.exitCode()).toBe(1);
		expect(verdict.lines).toEqual([
			{ kind: "mutant", file: "src/a.ts", mutant: row("1"), outcome: "survivor", status: "NoCoverage" },
		]);
	});

	it("passes an uncovered mutant a hand proof answers", () => {
		const proof: MutantAnswer = {
			mutant: row("1").id,
			kind: "hand-proof",
			reason: "the CLI suite spawns this file",
			tree,
			test: { file: "packages/cli/test/cli.test.ts", name: "cli > review > works" },
			command: "npx vitest run packages/cli/test/cli.test.ts -t works",
		};
		const verdict = MutantsVerdict.decide(input({ noTests: true, answers: answers(proof) }));
		expect(verdict.exitCode()).toBe(0);
		expect(verdict.lines[0]).toMatchObject({ outcome: "answered", answer: proof, answerHash: answerHash(proof) });
	});

	it("catches a kill whose killing test passes the end check", () => {
		const mutants = [row("1")];
		const verdict = MutantsVerdict.decide(
			input({
				mutants,
				report: reported(mutants, "Killed", { killedBy: ["0"] }),
				endCheck: { "test/a.test.ts": true },
			}),
		);
		expect(verdict.exitCode()).toBe(0);
		expect(verdict.lines).toEqual([
			{ kind: "mutant", file: "src/a.ts", mutant: mutants[0], outcome: "caught", status: "Killed" },
		]);
	});

	it("turns a kill into a survivor when its killing test fails the end check", () => {
		const mutants = [row("1")];
		const verdict = MutantsVerdict.decide(
			input({
				mutants,
				report: reported(mutants, "Killed", { killedBy: ["0"] }),
				endCheck: { "test/a.test.ts": false },
			}),
		);
		expect(verdict.exitCode()).toBe(1);
		expect(verdict.lines[0]).toMatchObject({ outcome: "survivor", status: "Killed, not confirmed" });
	});

	it("turns a kill into a survivor when its killing test was not rerun", () => {
		const mutants = [row("1")];
		const verdict = MutantsVerdict.decide(
			input({ mutants, report: reported(mutants, "Killed", { killedBy: ["0"] }), endCheck: {} }),
		);
		expect(verdict.lines[0]?.outcome).toBe("survivor");
	});

	it("turns a kill into a survivor when Stryker names no killing test", () => {
		const mutants = [row("1")];
		const verdict = MutantsVerdict.decide(
			input({
				mutants,
				report: reported(mutants, "Killed", { killedBy: [] }),
				endCheck: { "test/a.test.ts": true },
			}),
		);
		expect(verdict.lines[0]?.outcome).toBe("survivor");
	});

	it("turns a kill into a survivor when one of two killing tests is unknown to the report", () => {
		const mutants = [row("1")];
		const verdict = MutantsVerdict.decide(
			input({
				mutants,
				report: reported(mutants, "Killed", { killedBy: ["0", "9"] }),
				endCheck: { "test/a.test.ts": true },
			}),
		);
		expect(verdict.lines[0]?.outcome).toBe("survivor");
	});

	it("counts a timeout as a catch", () => {
		const mutants = [row("1")];
		const verdict = MutantsVerdict.decide(input({ mutants, report: reported(mutants, "Timeout") }));
		expect(verdict.exitCode()).toBe(0);
		expect(verdict.lines[0]).toMatchObject({ outcome: "timeout", status: "Timeout" });
	});

	it("passes a survivor only with an answer that names the same tree", () => {
		const mutants = [row("1")];
		const report = reported(mutants, "Survived");
		expect(MutantsVerdict.decide(input({ mutants, report })).exitCode()).toBe(1);
		expect(
			MutantsVerdict.decide(input({ mutants, report, answers: answers(equivalent(row("1").id, other)) })).exitCode(),
		).toBe(1);
		const answered = MutantsVerdict.decide(input({ mutants, report, answers: answers(equivalent(row("1").id)) }));
		expect(answered.exitCode()).toBe(0);
		expect(answered.lines[0]?.outcome).toBe("answered");
	});

	it("does not let an answer for one mutant pass another", () => {
		const mutants = [row("1"), row("2", { column: 20, endColumn: 25 })];
		const verdict = MutantsVerdict.decide(
			input({ mutants, report: reported(mutants, "Survived"), answers: answers(equivalent(row("1").id)) }),
		);
		expect(verdict.exitCode()).toBe(1);
		expect(verdict.lines.map((line) => line.outcome)).toEqual(["answered", "survivor"]);
	});

	it("notes a mutant the base's configuration excludes, and holds one a comment hides as a survivor", () => {
		const mutants = [
			row("1", { status: "ignored", ignoredBy: "config" }),
			row("2", { status: "ignored", ignoredBy: "comment" }),
		];
		const verdict = MutantsVerdict.decide(input({ mutants, report: reported([], "Killed") }));
		expect(verdict.lines.map((line) => [line.outcome, line.status])).toEqual([
			["noted", "Ignored"],
			["survivor", "Ignored"],
		]);
		expect(verdict.exitCode()).toBe(1);
	});

	it("cannot decide when the report has no result for an enumerated mutant", () => {
		const verdict = MutantsVerdict.decide(input({ report: reported([], "Killed") }));
		expect(verdict.exitCode()).toBe(2);
		expect(verdict.undecided).toMatch(/has no result for mutant/);
	});

	it("matches the report by columns counted from one", () => {
		const mutants = [row("1")];
		const verdict = MutantsVerdict.decide(input({ mutants, report: reported(mutants, "Timeout", { shift: 0 }) }));
		expect(verdict.exitCode()).toBe(2);
	});

	it("settles a set-aside file only with a settlement for that file at the same tree", () => {
		const setAside = [{ file: "src/run.ts", reason: "sends signals" }];
		const settlement: MutantAnswer = {
			file: "src/run.ts",
			kind: "settlement",
			reason: "a fake kill proves it",
			tree,
		};
		const base = { mutants: [], setAside };
		expect(
			MutantsVerdict.decide(input({ ...base, answers: answers({ ...settlement, file: "src/x.ts" }) })).exitCode(),
		).toBe(1);
		expect(
			MutantsVerdict.decide(input({ ...base, answers: answers({ ...settlement, tree: other }) })).exitCode(),
		).toBe(1);
		const settled = MutantsVerdict.decide(input({ ...base, answers: answers(settlement) }));
		expect(settled.exitCode()).toBe(0);
		expect(settled.lines[0]).toMatchObject({ outcome: "settled", answerHash: answerHash(settlement) });
	});

	it("does not let a settlement for a file answer a mutant in it", () => {
		const mutants = [row("1")];
		const settlement: MutantAnswer = { file: "src/a.ts", kind: "settlement", reason: "tested", tree };
		const verdict = MutantsVerdict.decide(
			input({ mutants, report: reported(mutants, "Survived"), answers: answers(settlement) }),
		);
		expect(verdict.exitCode()).toBe(1);
	});

	it("refuses an answers file that does not match its format", () => {
		expect(() => MutantsVerdict.decide(input({ answers: "version: 1\nanswers:\n  - kind: equivalent\n" }))).toThrow(
			MutantsVerifyError,
		);
		expect(() => MutantsVerdict.answers("version: [")).toThrow(/answers\.yaml/);
	});

	it("refuses a report that is not Stryker's JSON", () => {
		expect(() => MutantsVerdict.decide(input({ report: "not json" }))).toThrow(
			expect.objectContaining({ code: "invalidReport" }),
		);
		expect(() => MutantsVerdict.decide(input({ report: JSON.stringify({ files: 3 }) }))).toThrow(
			expect.objectContaining({ code: "invalidReport" }),
		);
	});
});

describe("answerHash", () => {
	it("hashes an answer's canonical JSON, whatever its key order", () => {
		const answer = equivalent(row("1").id);
		const reordered = JSON.parse(
			JSON.stringify({ tree, reason: answer.reason, kind: answer.kind, mutant: answer.mutant }),
		);
		expect(answerHash(reordered)).toBe(answerHash(answer));
		expect(answerHash({ ...answer, reason: "another reason" })).not.toBe(answerHash(answer));
	});
});

describe("MutantsVerdict rendering", () => {
	it("prints the files, counts, head, tree and each open survivor with its answer", () => {
		const mutants = [row("1"), row("2", { column: 20, endColumn: 25 })];
		const verdict = MutantsVerdict.decide(
			input({
				mutants,
				report: reported(mutants, "Survived"),
				answers: answers(equivalent(row("1").id)),
			}),
		);
		const text = verdict.render();
		expect(text.split("\n")).toEqual([
			`Mutation proof by \`melian mutants verify\` at ${head}: failed.`,
			"Files: `src/a.ts`",
			`Tree: ${tree}`,
			"Mutants: 2; caught 0, by timeout 0, noted 0, answered 1, survivors 1.",
			`- \`src/a.ts:2:9\` EqualityOperator to \`n >= 0\`, Survived, mutant ${row("1").id}: equivalent, answer ${answerHash(equivalent(row("1").id))}: n is never 0 here`,
			`- \`src/a.ts:2:20\` EqualityOperator to \`n >= 0\`, Survived, mutant ${row("2").id}: no answer`,
		]);
		expect(JSON.parse(verdict.renderJson())).toMatchObject({ head, tree, result: "failed" });
	});

	it("prints why a run could not decide", () => {
		const verdict = MutantsVerdict.decide(input({ files: [] }));
		expect(verdict.render()).toContain("could not decide");
		expect(verdict.render()).toContain("Why: no file was listed, so nothing was proved.");
		expect(JSON.parse(verdict.renderJson())).toMatchObject({ result: "undecided" });
	});
});

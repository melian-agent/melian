import { createHash } from "node:crypto";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { parseYaml } from "./config.ts";
import type { MutationInventoryRow } from "./mutation-inventory.ts";

const strict = { additionalProperties: false };
const text = Type.String({ pattern: "\\S" });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });

const answerSchema = Type.Union([
	Type.Object({ mutant: digest, kind: Type.Literal("equivalent"), reason: text, tree: digest }, strict),
	Type.Object(
		{
			mutant: digest,
			kind: Type.Literal("hand-proof"),
			reason: text,
			tree: digest,
			test: Type.Object({ file: text, name: text }, strict),
			command: text,
			node: Type.Optional(text),
			platform: Type.Optional(text),
		},
		strict,
	),
	Type.Object({ file: text, kind: Type.Literal("settlement"), reason: text, tree: digest }, strict),
]);
const answersSchema = Type.Object({ version: Type.Literal(1), answers: Type.Array(answerSchema) }, strict);

/** A builder's answer for one survivor or one set-aside file, as `.melian/mutants/answers.yaml` holds it. */
export type MutantAnswer = Static<typeof answerSchema>;

const position = Type.Object({ line: Type.Integer({ minimum: 1 }), column: Type.Integer({ minimum: 1 }) });
const reportSchema = Type.Object({
	files: Type.Record(
		Type.String(),
		Type.Object({
			mutants: Type.Array(
				Type.Object({
					id: Type.String(),
					mutatorName: Type.String(),
					replacement: Type.Optional(Type.String()),
					location: Type.Object({ start: position, end: position }),
					status: Type.String(),
					killedBy: Type.Optional(Type.Array(Type.String())),
				}),
			),
		}),
	),
	testFiles: Type.Optional(
		Type.Record(
			Type.String(),
			Type.Object({ tests: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })) }),
		),
	),
});
type StrykerReport = Static<typeof reportSchema>;

/** The codes a {@link MutantsVerifyError} carries. */
export type MutantsVerifyErrorCode = "invalidAnswers" | "invalidReport";

/** A malformed answers file or Stryker report. */
export class MutantsVerifyError extends Error {
	readonly code: MutantsVerifyErrorCode;

	constructor(code: MutantsVerifyErrorCode, message: string) {
		super(message);
		this.name = "MutantsVerifyError";
		this.code = code;
	}
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** The SHA-256 of an answer's canonical JSON: the hash the coordinator's recorded read names. */
export function answerHash(answer: MutantAnswer): string {
	return createHash("sha256").update(canonical(answer)).digest("hex");
}

/** What `melian mutants verify` found for one mutant or one set-aside file. */
export type MutantOutcome = "caught" | "timeout" | "noted" | "answered" | "survivor" | "settled" | "unsettled";

/** One line of a verdict: a mutant or a set-aside file, what was found, and the answer that matched it. */
export interface MutantVerdictLine {
	readonly kind: "mutant" | "file";
	readonly file: string;
	readonly mutant?: MutationInventoryRow;
	readonly outcome: MutantOutcome;
	/** Stryker's status, or `NoCoverage` when Stryker wrote no report because no test relates to the files. */
	readonly status?: string;
	/** Why a kill did not count: its killing test's file failed the end check. */
	readonly note?: string;
	readonly answer?: MutantAnswer;
	readonly answerHash?: string;
}

/** What a verify run hands the verdict: the run's own facts, read from the run and git. */
export interface MutantsVerifyInput {
	/** The head commit the run verified. */
	readonly head: string;
	/** The digest of the head's tree with `.melian/mutants/answers.yaml` left out, which an answer must name. */
	readonly tree: string;
	/** The files the builder listed, each a changed file of the range. */
	readonly files: readonly string[];
	/** The enumerated mutants of the listed files' changed lines. */
	readonly mutants: readonly MutationInventoryRow[];
	/** The listed files the enumerator could not mutate, with why. */
	readonly setAside: readonly { readonly file: string; readonly reason: string }[];
	/** Stryker's JSON report, or undefined when it wrote none. */
	readonly report: string | undefined;
	/** Whether Stryker's dry run found no test, which with `allowEmpty` leaves no report. */
	readonly noTests: boolean;
	/** Each killing test file's result when rerun unmutated after the mutants: true when it passed. */
	readonly endCheck: Readonly<Record<string, boolean>>;
	/** The text of `.melian/mutants/answers.yaml` at the head, or undefined when it has none. */
	readonly answers: string | undefined;
}

// Melian's mutant coordinates hold the instrumenter's zero-based columns; Stryker's report counts columns from one.
function locationKey(file: string, line: number, column: number, endLine: number, endColumn: number): string {
	return JSON.stringify([file, line, column, endLine, endColumn]);
}

function rowKey(row: MutationInventoryRow): string {
	return JSON.stringify([
		locationKey(row.file, row.line, row.column + 1, row.endLine, row.endColumn + 1),
		row.mutatorName,
		row.replacement,
	]);
}

/**
 * What `melian mutants verify` decides from one run over a builder's listed files: every mutant caught, noted or
 * answered, and every set-aside file settled, passes; anything else fails or cannot be decided.
 */
export class MutantsVerdict {
	readonly head: string;
	readonly tree: string;
	readonly files: readonly string[];
	readonly lines: readonly MutantVerdictLine[];
	/** Why the run could not decide, when it could not. */
	readonly undecided: string | undefined;

	private constructor(
		head: string,
		tree: string,
		files: readonly string[],
		lines: readonly MutantVerdictLine[],
		undecided: string | undefined,
	) {
		this.head = head;
		this.tree = tree;
		this.files = files;
		this.lines = lines;
		this.undecided = undecided;
	}

	/** Reads the answers file. Throws {@link MutantsVerifyError} `invalidAnswers` when it is not valid. */
	static answers(text: string): MutantAnswer[] {
		let value: unknown;
		try {
			value = parseYaml(text, { file: ".melian/mutants/answers.yaml", where: "" }, answersSchema);
		} catch (error) {
			throw new MutantsVerifyError("invalidAnswers", `.melian/mutants/answers.yaml: ${(error as Error).message}`);
		}
		return (value as Static<typeof answersSchema>).answers;
	}

	static decide(input: MutantsVerifyInput): MutantsVerdict {
		const undecided = (reason: string) => new MutantsVerdict(input.head, input.tree, input.files, [], reason);
		if (input.files.length === 0) return undecided("no file was listed, so nothing was proved");
		if (input.mutants.length === 0 && input.setAside.length === 0)
			return undecided("the listed files hold no mutant and no set-aside file, so nothing was proved");
		const answers = (input.answers === undefined ? [] : MutantsVerdict.answers(input.answers)).filter(
			(answer) => answer.tree === input.tree,
		);
		const generated = input.mutants.filter((row) => row.status === "generated");
		let report: StrykerReport | undefined;
		if (input.report !== undefined) {
			let value: unknown;
			try {
				value = JSON.parse(input.report);
			} catch {
				throw new MutantsVerifyError("invalidReport", "Stryker's report is not JSON");
			}
			if (!Value.Check(reportSchema, value))
				throw new MutantsVerifyError("invalidReport", "Stryker's report does not match its format");
			report = value;
		} else if (generated.length > 0 && !input.noTests)
			return undecided("Stryker wrote no report, and its dry run did not say it found no test");
		const found = new Map<string, StrykerReport["files"][string]["mutants"][number]>();
		const testFileOf = new Map<string, string>();
		for (const [file, tests] of Object.entries(report?.testFiles ?? {}))
			for (const test of tests.tests) testFileOf.set(test.id, file);
		for (const [file, entry] of Object.entries(report?.files ?? {}))
			for (const mutant of entry.mutants) {
				const { start, end } = mutant.location;
				found.set(
					JSON.stringify([
						locationKey(file, start.line, start.column, end.line, end.column),
						mutant.mutatorName,
						mutant.replacement ?? "",
					]),
					mutant,
				);
			}
		const lines: MutantVerdictLine[] = [];
		for (const row of input.mutants) {
			if (row.status === "ignored" && row.ignoredBy === "config") {
				lines.push({ kind: "mutant", file: row.file, mutant: row, outcome: "noted", status: "Ignored" });
				continue;
			}
			let status: string;
			let note: string | undefined;
			if (row.status === "ignored") status = "Ignored";
			else if (report === undefined) status = "NoCoverage";
			else {
				const mutant = found.get(rowKey(row));
				if (mutant === undefined)
					return undecided(
						`Stryker's report has no result for mutant ${row.id} at ${row.file}:${row.line}:${row.column}`,
					);
				status = mutant.status;
				if (status === "Killed") {
					const killers = (mutant.killedBy ?? []).map((id) => testFileOf.get(id));
					if (
						killers.length === 0 ||
						killers.some((file) => file === undefined || input.endCheck[file] !== true)
					) {
						note = "its killing test failed when rerun unmutated after the mutants, or was not rerun";
						status = "Killed, not confirmed";
					}
				}
			}
			if (status === "Killed")
				lines.push({ kind: "mutant", file: row.file, mutant: row, outcome: "caught", status });
			else if (status === "Timeout")
				lines.push({ kind: "mutant", file: row.file, mutant: row, outcome: "timeout", status });
			else {
				const answer = answers.find((each) => "mutant" in each && each.mutant === row.id);
				lines.push({
					kind: "mutant",
					file: row.file,
					mutant: row,
					outcome: answer === undefined ? "survivor" : "answered",
					status,
					...(note === undefined ? {} : { note }),
					...(answer === undefined ? {} : { answer, answerHash: answerHash(answer) }),
				});
			}
		}
		for (const { file, reason } of input.setAside) {
			const answer = answers.find((each) => each.kind === "settlement" && each.file === file);
			lines.push({
				kind: "file",
				file,
				outcome: answer === undefined ? "unsettled" : "settled",
				note: reason,
				...(answer === undefined ? {} : { answer, answerHash: answerHash(answer) }),
			});
		}
		return new MutantsVerdict(input.head, input.tree, input.files, lines, undefined);
	}

	/** 0 when every mutant is caught, noted or answered and every set-aside file settled; 1 when one is not; 2 undecided. */
	exitCode(): 0 | 1 | 2 {
		if (this.undecided !== undefined) return 2;
		return this.lines.some((line) => line.outcome === "survivor" || line.outcome === "unsettled") ? 1 : 0;
	}

	#count(outcome: MutantOutcome): number {
		return this.lines.filter((line) => line.outcome === outcome).length;
	}

	/** The block a builder pastes into the pull request in place of a hand-written inventory for these files. */
	render(): string {
		const result = ["passed", "failed", "could not decide"][this.exitCode()];
		const out = [
			`Mutation proof by \`melian mutants verify\` at ${this.head}: ${result}.`,
			`Files: ${this.files.map((file) => `\`${file}\``).join(", ")}`,
			`Tree: ${this.tree}`,
		];
		if (this.undecided !== undefined) return [...out, `Why: ${this.undecided}.`].join("\n");
		const mutants = this.lines.filter((line) => line.kind === "mutant").length;
		out.push(
			`Mutants: ${mutants}; caught ${this.#count("caught")}, by timeout ${this.#count("timeout")}, noted ${this.#count("noted")}, answered ${this.#count("answered")}, survivors ${this.#count("survivor")}.`,
		);
		const files = this.lines.filter((line) => line.kind === "file");
		if (files.length > 0)
			out.push(
				`Set-aside files: ${files.length}; settled ${this.#count("settled")}, unsettled ${this.#count("unsettled")}.`,
			);
		const open = this.lines.filter((line) => ["answered", "survivor", "settled", "unsettled"].includes(line.outcome));
		for (const line of open) {
			const where =
				line.mutant === undefined
					? `\`${line.file}\`, set aside: ${line.note}`
					: `\`${line.file}:${line.mutant.line}:${line.mutant.column}\` ${line.mutant.mutatorName} to \`${line.mutant.replacement}\`, ${line.status}${line.note === undefined ? "" : ` (${line.note})`}, mutant ${line.mutant.id}`;
			const answer =
				line.answer === undefined
					? "no answer"
					: `${line.answer.kind}, answer ${line.answerHash}: ${line.answer.reason}`;
			out.push(`- ${where}: ${answer}`);
		}
		return out.join("\n");
	}

	renderJson(): string {
		return JSON.stringify(
			{
				head: this.head,
				tree: this.tree,
				files: this.files,
				result: ["passed", "failed", "undecided"][this.exitCode()],
				...(this.undecided === undefined ? {} : { undecided: this.undecided }),
				lines: this.lines.map((line) => ({
					kind: line.kind,
					file: line.file,
					outcome: line.outcome,
					...(line.mutant === undefined ? {} : { mutant: line.mutant.id }),
					...(line.status === undefined ? {} : { status: line.status }),
					...(line.note === undefined ? {} : { note: line.note }),
					...(line.answerHash === undefined ? {} : { answer: line.answerHash }),
				})),
			},
			null,
			"\t",
		);
	}
}

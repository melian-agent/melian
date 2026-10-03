// A regular-expression engine whose matching time is linear in the input, for patterns from configuration run over text
// the change under review controls. JavaScript's RegExp backtracks: `.*foo.*bar` over a crafted line takes cubic time,
// and a head commit chooses the line. This engine compiles a pattern to a Thompson NFA and simulates every thread in
// step, so a line of n characters costs at most n times the program size.

type Test = (code: number) => boolean;

type Node =
	// `cost` is how many tests one character takes: a class's member count, and 1 for anything else.
	| { readonly kind: "char"; readonly test: Test; readonly cost?: number }
	| { readonly kind: "assert"; readonly at: Assertion }
	| { readonly kind: "concat"; readonly items: readonly Node[] }
	| { readonly kind: "alt"; readonly options: readonly Node[] }
	| { readonly kind: "repeat"; readonly item: Node; readonly min: number; readonly max: number };

type Assertion = "start" | "end" | "boundary" | "notBoundary";

type Instruction =
	| { readonly op: "char"; readonly test: Test }
	| { readonly op: "split"; x: number; y: number }
	| { readonly op: "jmp"; x: number }
	| { readonly op: "assert"; readonly at: Assertion }
	| { readonly op: "match" };

/** A compiled pattern. `test` says whether it matches anywhere in a line, in time linear in the line's length. */
export interface LinearPattern {
	readonly source: string;
	test(text: string): boolean;
}

export type PatternResult =
	| { readonly ok: true; readonly pattern: LinearPattern }
	| { readonly ok: false; readonly reason: string };

/** The most a counted repetition such as `{2,5}` may ask for. */
export const maxRepeat = 100;
/** The largest compiled program; past it a pattern is refused as too complex. */
export const maxProgram = 2000;
/** The deepest groups may nest. The parser and compiler recurse once per level. */
export const maxDepth = 100;

// Why a pattern or glob is refused. An Error, so that one escaping a caller still carries a stack and a message.
export class Refused extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(reason);
		this.name = "Refused";
		this.reason = reason;
	}
}

const isDigit: Test = (code) => code >= 48 && code <= 57;
const isWord: Test = (code) =>
	isDigit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
// JavaScript's \s, line terminators included.
const isSpace: Test = (code) =>
	code === 32 ||
	(code >= 9 && code <= 13) ||
	code === 0xa0 ||
	code === 0x1680 ||
	(code >= 0x2000 && code <= 0x200a) ||
	code === 0x2028 ||
	code === 0x2029 ||
	code === 0x202f ||
	code === 0x205f ||
	code === 0x3000 ||
	code === 0xfeff;
const not =
	(test: Test): Test =>
	(code) =>
		!test(code);
const exactly =
	(expected: number): Test =>
	(code) =>
		code === expected;
const anyChar: Test = () => true;
// JavaScript's `.` without the s flag.
const notLineTerminator: Test = (code) => code !== 10 && code !== 13 && code !== 0x2028 && code !== 0x2029;

const classEscapes: Readonly<Record<string, Test>> = {
	d: isDigit,
	D: not(isDigit),
	w: isWord,
	W: not(isWord),
	s: isSpace,
	S: not(isSpace),
};
const controlEscapes: Readonly<Record<string, number>> = { t: 9, n: 10, v: 11, f: 12, r: 13, "0": 0 };

// The other cases of a code unit that has them in one code unit, as RegExp's i flag folds.
function caseVariants(code: number): number[] {
	const char = String.fromCharCode(code);
	return [char.toLowerCase(), char.toUpperCase()]
		.filter((variant) => variant.length === 1 && variant !== char)
		.map((variant) => variant.charCodeAt(0));
}

const folded =
	(test: Test): Test =>
	(code) =>
		test(code) || caseVariants(code).some(test);

class Parser {
	readonly source: string;
	readonly ignoreCase: boolean;
	position = 0;
	depth = 0;

	constructor(source: string, ignoreCase: boolean) {
		this.source = source;
		this.ignoreCase = ignoreCase;
	}

	// A literal or a class's members, folded when matching ignores case. A negated class folds before it negates.
	private literal(test: Test): Test {
		return this.ignoreCase ? folded(test) : test;
	}

	parse(): Node {
		const node = this.alternation();
		if (this.position < this.source.length) throw this.refuse(`unexpected "${this.peek()}"`);
		return node;
	}

	private peek(): string | undefined {
		return this.source[this.position];
	}

	private refuse(reason: string): Refused {
		return new Refused(`${reason} at offset ${this.position}`);
	}

	private alternation(): Node {
		const options = [this.sequence()];
		while (this.peek() === "|") {
			this.position++;
			options.push(this.sequence());
		}
		return options.length === 1 ? options[0]! : { kind: "alt", options };
	}

	private sequence(): Node {
		const items: Node[] = [];
		for (let next = this.peek(); next !== undefined && next !== "|" && next !== ")"; next = this.peek()) {
			items.push(this.quantified(this.atom()));
		}
		return { kind: "concat", items };
	}

	private quantified(item: Node): Node {
		const next = this.peek();
		let min: number;
		let max: number;
		if (next === "*") [min, max] = [0, Infinity];
		else if (next === "+") [min, max] = [1, Infinity];
		else if (next === "?") [min, max] = [0, 1];
		else if (next === "{") [min, max] = this.braces();
		else return item;
		if (next !== "{") this.position++;
		// A lazy quantifier matches the same lines as a greedy one; only the match boundaries differ.
		if (this.peek() === "?") this.position++;
		if (item.kind === "assert") throw this.refuse("a quantifier cannot follow an anchor");
		const following = this.peek();
		if (following === "*" || following === "+" || following === "?" || following === "{") {
			throw this.refuse("a quantifier cannot follow a quantifier");
		}
		return { kind: "repeat", item, min, max };
	}

	private braces(): [number, number] {
		const match = /^\{(\d+)(,(\d*))?\}/.exec(this.source.slice(this.position));
		if (match === null) throw this.refuse('"{" must start a repetition such as {2,5}; write \\{ for a brace');
		const min = Number(match[1]);
		const max = match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3]);
		if (min > maxRepeat || (max !== Infinity && max > maxRepeat)) {
			throw this.refuse(`a repetition may not exceed ${maxRepeat}`);
		}
		if (max < min) throw this.refuse("a repetition's maximum is below its minimum");
		this.position += match[0].length;
		return [min, max];
	}

	private atom(): Node {
		const char = this.peek()!;
		this.position++;
		switch (char) {
			case ".":
				return { kind: "char", test: notLineTerminator };
			case "^":
				return { kind: "assert", at: "start" };
			case "$":
				return { kind: "assert", at: "end" };
			case "(":
				return this.group();
			case "[":
				return { kind: "char", ...this.characterClass() };
			case "\\":
				return this.escape();
			case "*":
			case "+":
			case "?":
			case "{":
				throw new Refused(`nothing to repeat at offset ${this.position - 1}`);
			case "]":
			case "}":
				throw new Refused(`unbalanced "${char}" at offset ${this.position - 1}; escape it with a backslash`);
			default:
				return { kind: "char", test: this.literal(exactly(char.charCodeAt(0))) };
		}
	}

	private group(): Node {
		if (this.peek() === "?") {
			const rest = this.source.slice(this.position);
			if (rest.startsWith("?:")) this.position += 2;
			else if (/^\?<[A-Za-z_$][\w$]*>/.test(rest)) this.position = this.source.indexOf(">", this.position) + 1;
			else if (/^\?[a-z-]+[:)]/.test(rest)) {
				throw this.refuse("inline flags such as (?i) are not supported; set ignoreCase: true on the rule instead");
			} else throw this.refuse("lookahead and lookbehind cannot run in linear time");
		}
		if (++this.depth > maxDepth) throw this.refuse(`groups may not nest more than ${maxDepth} deep`);
		const inner = this.alternation();
		if (this.peek() !== ")") throw this.refuse('missing ")"');
		this.position++;
		this.depth--;
		return inner;
	}

	private escape(): Node {
		const char = this.peek();
		if (char === undefined) throw this.refuse("the pattern ends with a backslash");
		this.position++;
		if (char === "b") return { kind: "assert", at: "boundary" };
		if (char === "B") return { kind: "assert", at: "notBoundary" };
		const shorthand = classEscapes[char];
		return { kind: "char", test: shorthand ?? this.literal(exactly(this.escapedCode(char))) };
	}

	// The code unit a single-character escape names, such as \t, \x41, or \. for a literal dot.
	private escapedCode(char: string): number {
		// RegExp reads \01 as an octal escape; this engine would read NUL and then 1.
		if (char === "0" && isDigit(this.source.charCodeAt(this.position))) {
			throw this.refuse(
				"\\0 followed by a digit is an octal escape in RegExp; write \\x01 for that, or \\x00 and the digit",
			);
		}
		const control = controlEscapes[char];
		if (control !== undefined) return control;
		if (char === "x" || char === "u") {
			const digits = char === "x" ? 2 : 4;
			const hex = this.source.slice(this.position, this.position + digits);
			if (!(hex.length === digits && /^[0-9A-Fa-f]+$/.test(hex))) {
				throw this.refuse(`\\${char} needs ${digits} hex digits`);
			}
			this.position += digits;
			return Number.parseInt(hex, 16);
		}
		if (/[1-9]/.test(char) || char === "k") throw this.refuse("backreferences cannot run in linear time");
		if (/[A-Za-z0-9]/.test(char)) throw this.refuse(`\\${char} is not supported`);
		return char.charCodeAt(0);
	}

	// Follows JavaScript: "]" closes the class even first, so [] matches nothing and [^] matches anything.
	private characterClass(): { test: Test; cost: number } {
		const negated = this.peek() === "^";
		if (negated) this.position++;
		const tests: Test[] = [];
		while (this.peek() !== "]") {
			const low = this.classMember();
			if (this.peek() === "-" && this.source[this.position + 1] !== "]" && typeof low === "number") {
				this.position++;
				const high = this.classMember();
				if (typeof high !== "number") throw this.refuse("a range must run between two characters");
				if (high < low) throw this.refuse("a range runs backwards");
				tests.push((code) => code >= low && code <= high);
			} else {
				tests.push(typeof low === "number" ? exactly(low) : low);
			}
		}
		this.position++;
		const member: Test = this.literal((code) => tests.some((test) => test(code)));
		return { test: negated ? not(member) : member, cost: Math.max(tests.length, 1) };
	}

	// A code unit for one character, or a test for a shorthand such as \d.
	private classMember(): number | Test {
		const char = this.peek();
		if (char === undefined) throw this.refuse('missing "]"');
		this.position++;
		if (char !== "\\") return char.charCodeAt(0);
		const escaped = this.peek();
		if (escaped === undefined) throw this.refuse("the pattern ends with a backslash");
		this.position++;
		// Inside a class, \b is a backspace, as in JavaScript.
		if (escaped === "b") return 8;
		return classEscapes[escaped] ?? this.escapedCode(escaped);
	}
}

class Compiler {
	readonly program: Instruction[] = [];
	// What one character can cost, counting each member of a class, which the simulation tests one by one.
	steps = 0;

	emit(instruction: Instruction, cost = 1): number {
		this.steps += cost;
		if (this.steps > maxProgram) {
			throw new Refused(`the pattern compiles to more than ${maxProgram} steps; simplify it`);
		}
		this.program.push(instruction);
		return this.program.length - 1;
	}

	compile(node: Node): void {
		switch (node.kind) {
			case "char":
				this.emit({ op: "char", test: node.test }, node.cost);
				return;
			case "assert":
				this.emit({ op: "assert", at: node.at });
				return;
			case "concat":
				for (const item of node.items) this.compile(item);
				return;
			case "alt": {
				const exits: { op: "jmp"; x: number }[] = [];
				node.options.forEach((option, index) => {
					if (index === node.options.length - 1) {
						this.compile(option);
						return;
					}
					const split = { op: "split" as const, x: 0, y: 0 };
					this.emit(split);
					split.x = this.program.length;
					this.compile(option);
					const exit = { op: "jmp" as const, x: 0 };
					this.emit(exit);
					exits.push(exit);
					split.y = this.program.length;
				});
				for (const exit of exits) exit.x = this.program.length;
				return;
			}
			case "repeat":
				this.repeat(node.item, node.min, node.max);
				return;
		}
	}

	private repeat(item: Node, min: number, max: number): void {
		for (let count = 0; count < min; count++) this.compile(item);
		if (max === Infinity) {
			const split = { op: "split" as const, x: 0, y: 0 };
			const loop = this.emit(split);
			split.x = this.program.length;
			this.compile(item);
			this.emit({ op: "jmp", x: loop });
			split.y = this.program.length;
			return;
		}
		const skips: { op: "split"; x: number; y: number }[] = [];
		for (let count = min; count < max; count++) {
			const split = { op: "split" as const, x: 0, y: 0 };
			this.emit(split);
			split.x = this.program.length;
			skips.push(split);
			this.compile(item);
		}
		for (const split of skips) split.y = this.program.length;
	}
}

function holds(at: Assertion, text: string, position: number): boolean {
	switch (at) {
		case "start":
			return position === 0;
		case "end":
			return position === text.length;
		default: {
			const before = position > 0 && isWord(text.charCodeAt(position - 1));
			const after = position < text.length && isWord(text.charCodeAt(position));
			return (before !== after) === (at === "boundary");
		}
	}
}

// Pike's simulation: every live thread advances one character at a time, and a thread already at an instruction for
// this position is never added twice, so each character costs at most one visit per instruction.
function simulate(program: readonly Instruction[], text: string, anchored: boolean): boolean {
	const size = program.length;
	let current = new Int32Array(size);
	let next = new Int32Array(size);
	const seen = new Int32Array(size).fill(-1);
	const stack: number[] = [];
	let currentCount = 0;
	let nextCount = 0;
	let generation = 0;
	let matched = false;

	const add = (list: Int32Array, count: number, pc: number, position: number): number => {
		stack.push(pc);
		while (stack.length > 0) {
			const at = stack.pop()!;
			if (seen[at] === generation) continue;
			seen[at] = generation;
			const instruction = program[at]!;
			switch (instruction.op) {
				case "jmp":
					stack.push(instruction.x);
					break;
				case "split":
					stack.push(instruction.y, instruction.x);
					break;
				case "assert":
					if (holds(instruction.at, text, position)) stack.push(at + 1);
					break;
				case "match":
					matched = true;
					break;
				case "char":
					list[count++] = at;
					break;
			}
		}
		return count;
	};

	for (let position = 0; ; position++) {
		if (position === 0 || !anchored) currentCount = add(current, currentCount, 0, position);
		if (matched) return true;
		if (position === text.length || (anchored && currentCount === 0)) return false;
		const code = text.charCodeAt(position);
		generation++;
		nextCount = 0;
		for (let index = 0; index < currentCount; index++) {
			const pc = current[index]!;
			const instruction = program[pc] as Extract<Instruction, { op: "char" }>;
			if (instruction.test(code)) nextCount = add(next, nextCount, pc + 1, position + 1);
		}
		if (matched) return true;
		[current, next] = [next, current];
		currentCount = nextCount;
	}
}

function build(source: string, node: Node, anchored: boolean): LinearPattern {
	const compiler = new Compiler();
	compiler.compile(node);
	compiler.emit({ op: "match" });
	const program = compiler.program;
	return { source, test: (text) => simulate(program, text, anchored) };
}

/**
 * Compiles a regular expression for linear-time matching. Supports literals, `.`, classes with ranges, `\d \w \s` and
 * their negations, `\b \B`, `^ $`, groups, alternation, and the quantifiers `* + ? {n} {n,} {n,m}`, greedy or lazy.
 * Refuses backreferences and lookaround, which no linear-time engine can run, and anything else it does not know.
 * `ignoreCase` matches as RegExp's `i` flag does without `u`.
 */
export function compilePattern(source: string, options: { readonly ignoreCase?: boolean } = {}): PatternResult {
	try {
		return { ok: true, pattern: build(source, new Parser(source, options.ignoreCase === true).parse(), false) };
	} catch (error) {
		if (error instanceof Refused) return { ok: false, reason: error.reason };
		throw error;
	}
}

const notSlash: Node = { kind: "char", test: (code) => code !== 47 };

/**
 * Compiles a path glob that must match a whole repository-relative path: `*` and `?` stay within one segment, `**`
 * crosses segments, and `**` followed by `/` matches zero or more whole directories, so `**` + `/*.ts` matches `a.ts`
 * and `src/a.ts`. Every other character is literal. Throws {@link Refused} for a glob past {@link maxProgram} steps;
 * `loadConfig` compiles every glob when it reads the file, so a review never meets one.
 */
export function compileGlob(glob: string): LinearPattern {
	let compiled = globs.get(glob);
	if (compiled === undefined) {
		compiled = buildGlob(glob);
		globs.set(glob, compiled);
	}
	return compiled;
}

// Globs come from configuration, so there are few; a guardrail matches each against every touched path.
const globs = new Map<string, LinearPattern>();

function buildGlob(glob: string): LinearPattern {
	const items: Node[] = [{ kind: "assert", at: "start" }];
	for (let index = 0; index < glob.length; ) {
		if (glob.startsWith("**/", index) && (index === 0 || glob[index - 1] === "/")) {
			const directory: Node = {
				kind: "concat",
				items: [
					{ kind: "repeat", item: notSlash, min: 1, max: Infinity },
					{ kind: "char", test: exactly(47) },
				],
			};
			items.push({ kind: "repeat", item: directory, min: 0, max: Infinity });
			index += 3;
		} else if (glob.startsWith("**", index)) {
			items.push({ kind: "repeat", item: { kind: "char", test: anyChar }, min: 0, max: Infinity });
			index += 2;
		} else if (glob[index] === "*") {
			items.push({ kind: "repeat", item: notSlash, min: 0, max: Infinity });
			index++;
		} else if (glob[index] === "?") {
			items.push(notSlash);
			index++;
		} else {
			items.push({ kind: "char", test: exactly(glob.charCodeAt(index)) });
			index++;
		}
	}
	items.push({ kind: "assert", at: "end" });
	return build(glob, { kind: "concat", items }, true);
}

/**
 * Whether `path` matches a list of globs: at least one plain glob, and no glob written with a leading `!`, which
 * excludes what it matches.
 */
export function matchesGlobs(globs: readonly string[], path: string): boolean {
	let included = false;
	for (const glob of globs) {
		if (glob.startsWith("!")) {
			if (compileGlob(glob.slice(1)).test(path)) return false;
		} else if (!included && compileGlob(glob).test(path)) {
			included = true;
		}
	}
	return included;
}

import { describe, expect, it } from "vitest";
import { compileGlob, compilePattern, type LinearPattern, matchesGlobs } from "../src/pattern.ts";

function compiled(source: string): LinearPattern {
	const result = compilePattern(source);
	if (!result.ok) throw new Error(`${source} was refused: ${result.reason}`);
	return result.pattern;
}

function refusal(source: string): string {
	const result = compilePattern(source);
	if (result.ok) throw new Error(`${source} compiled`);
	return result.reason;
}

describe("compilePattern", () => {
	const patterns = [
		"foo",
		"^foo$",
		"a|bc|",
		"colou?r",
		"(?:ab)+c",
		"(?<word>ab)*c",
		"a{2,3}b",
		"a{2}",
		"a{2,}",
		"x.*?y",
		"[a-c]+[^a-c]",
		"[]x",
		"[^]",
		"[\\]\\-]",
		"\\d+\\.\\d+",
		"\\bconsole\\.log\\(",
		"\\Bog",
		"\\s\\S\\w\\W\\D",
		"\\x41\\u0042",
		"\\.only\\(",
		"(a*)*b",
		"(a|aa)+$",
		"[\\d-]+",
		"^$",
		".+",
		"x.y",
		"a\\sb",
	];
	const inputs = [
		"",
		"foo",
		"xfoox",
		"color colour",
		"ababc",
		"aab",
		"aaaab",
		"x123y",
		"abcd",
		"]",
		"]x",
		"-]",
		"3.14",
		"  console.log(x)",
		"dog blog",
		" a_!",
		"AB",
		"it.only(",
		"aaaaaaaa",
		"aaab",
		"12-3",
		"\n",
		"x\ry",
		"x\u2028y",
		"a\nb",
	];

	it("agrees with JavaScript's RegExp on what matches", () => {
		for (const source of patterns) {
			const ours = compiled(source);
			const theirs = new RegExp(source);
			for (const input of inputs) {
				expect({ source, input, matched: ours.test(input) }).toEqual({
					source,
					input,
					matched: theirs.test(input),
				});
			}
		}
	});

	it("ignores case as RegExp's i flag does, folding before a class negates", () => {
		const sources = ["todo", "[a-c]x", "[^a]", "\\bFIXME\\b", "\\x41", "[^A-Z]+"];
		const texts = ["TODO", "ToDo", "Bx", "A", "a", "b", "fixme now", "a", "ABC", "abc", "é", "É"];
		for (const source of sources) {
			const ours = compilePattern(source, { ignoreCase: true });
			if (!ours.ok) throw new Error(ours.reason);
			const theirs = new RegExp(source, "i");
			for (const text of texts) {
				expect({ source, text, matched: ours.pattern.test(text) }).toEqual({
					source,
					text,
					matched: theirs.test(text),
				});
			}
		}
		expect(refusal("(?i)todo")).toMatch(/set ignoreCase: true on the rule/);
	});

	it("refuses backreferences and lookaround, which no linear-time engine runs", () => {
		expect(refusal("(a)\\1")).toMatch(/backreferences/);
		expect(refusal("(?<x>a)\\k<x>")).toMatch(/backreferences/);
		expect(refusal("a(?=b)")).toMatch(/lookahead/);
		expect(refusal("(?<!a)b")).toMatch(/lookahead/);
	});

	it("refuses what it cannot parse, naming where", () => {
		expect(refusal("(a")).toMatch(/missing "\)" at offset 2/);
		expect(refusal("[ab")).toMatch(/missing "]"/);
		expect(refusal("*a")).toMatch(/nothing to repeat/);
		expect(refusal("a{1001}")).toMatch(/may not exceed 100/);
		expect(refusal("a{3,2}")).toMatch(/below its minimum/);
		expect(refusal("a{x}")).toMatch(/must start a repetition/);
		expect(refusal("\\p{L}")).toMatch(/not supported/);
		expect(refusal("[z-a]")).toMatch(/backwards/);
		expect(refusal("a**")).toMatch(/cannot follow a quantifier/);
		expect(refusal("^*")).toMatch(/cannot follow an anchor/);
		expect(refusal("\\01")).toMatch(/octal escape/);
		expect(refusal("[\\07]")).toMatch(/octal escape/);
		expect(compiled("\\0a").test("\0a")).toBe(true);
	});

	it("refuses groups nested deeper than 100, rather than overflowing the stack", () => {
		expect(compiled(`${"(".repeat(100)}a${")".repeat(100)}`).test("a")).toBe(true);
		expect(refusal(`${"(".repeat(5000)}a${")".repeat(5000)}`)).toMatch(/may not nest more than 100 deep/);
	});

	it("refuses a pattern that compiles to too many steps, counting each member of a class", () => {
		expect(refusal("(?:(?:a{100}){100})")).toMatch(/more than 2000 steps/);
		expect(refusal(`[${"a".repeat(30_000)}b]{100}`)).toMatch(/more than 2000 steps/);
		expect(refusal(`[${"ab".repeat(20)}]{100}`)).toMatch(/more than 2000 steps/);
		expect(compiled(`[${"ab".repeat(9)}]{100}`).test("ab")).toBe(false);
	});

	// RegExp needs about n³ steps for `.*a.*a.*b` on a line of a's; 20,000 of them would run for hours.
	it("matches in time linear in the line, where RegExp backtracks", () => {
		const line = "a".repeat(20_000);
		for (const source of [".*a.*a.*b", "(a*)*b", "(a|aa)+b", "(?:a+)+b"]) {
			const started = performance.now();
			expect(compiled(source).test(line)).toBe(false);
			expect(performance.now() - started).toBeLessThan(2000);
		}
	});
});

describe("compileGlob", () => {
	it("keeps * and ? within a segment and lets ** cross them", () => {
		expect(compileGlob("src/*.ts").test("src/a.ts")).toBe(true);
		expect(compileGlob("src/*.ts").test("src/x/a.ts")).toBe(false);
		expect(compileGlob("src/?.ts").test("src/a.ts")).toBe(true);
		expect(compileGlob("src/?.ts").test("src/ab.ts")).toBe(false);
		expect(compileGlob("dist/**").test("dist/a/b.js")).toBe(true);
		expect(compileGlob("dist/**").test("src/dist/a.js")).toBe(false);
	});

	it("lets **/ match zero or more whole directories", () => {
		const glob = compileGlob("**/*.test.ts");
		expect(glob.test("a.test.ts")).toBe(true);
		expect(glob.test("packages/core/test/a.test.ts")).toBe(true);
		expect(glob.test("a.test.tsx")).toBe(false);
		expect(compileGlob("db/**/schema.sql").test("db/schema.sql")).toBe(true);
		expect(compileGlob("db/**/schema.sql").test("db/x/y/schema.sql")).toBe(true);
	});

	it("matches every other character literally, regular-expression syntax included", () => {
		expect(compileGlob("a+b.(c)").test("a+b.(c)")).toBe(true);
		expect(compileGlob("a+b.(c)").test("aab.(c)")).toBe(false);
		expect(compileGlob("[ab].ts").test("[ab].ts")).toBe(true);
	});

	it("matches the whole path, not a part of it", () => {
		expect(compileGlob("a.ts").test("src/a.ts")).toBe(false);
		expect(compileGlob("src").test("src/a.ts")).toBe(false);
	});
});

describe("matchesGlobs", () => {
	it("needs one plain glob to match and no ! glob to match", () => {
		const globs = ["src/**", "!src/generated/**"];
		expect(matchesGlobs(globs, "src/a.ts")).toBe(true);
		expect(matchesGlobs(globs, "src/generated/a.ts")).toBe(false);
		expect(matchesGlobs(globs, "test/a.ts")).toBe(false);
		expect(matchesGlobs([], "src/a.ts")).toBe(false);
	});
});

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reviewExitCodes } from "../src/commands.ts";
import { usage, usageExitCode } from "../src/main.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const hosts = ["claude-code", "codex", "pi"];

function parseSkill(text: string, file: string) {
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	if (match === null) throw new Error(`${file} has no front matter`);
	const fields = Object.fromEntries(
		match[1]!
			.split("\n")
			.filter((line) => line.includes(": "))
			.map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]),
	);
	return { fields, body: match[2]! };
}

function skill(host: string) {
	return parseSkill(readFileSync(join(root, "skills", host, "SKILL.md"), "utf8"), `skills/${host}/SKILL.md`);
}

// The commands `melian --help` lists, such as review and doctor.
const commands = new Set([...usage.split("\n\n")[1]!.matchAll(/^ {2}([a-z]+) /gm)].map((match) => match[1]!));

// The options `melian --help` lists, such as --rerun and --model.
const options = new Set([...usage.split("\n\n")[2]!.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]));

// The one tool a skill may run without the user's approval.
const allowedTools = ["Bash(melian doctor)"];

// Single words a skill quotes from `melian doctor`'s output, which are not commands.
const doctorWords = new Set(["warn", "routes", "static", "state"]);

const operators = new Set([";", "|", "&", "(", ")"]);

// One command line as shell words, quotes removed, with each control operator its own word.
function shellWords(line: string): string[] {
	const words: string[] = [];
	let word = "";
	let started = false;
	let quote: string | undefined;
	const end = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	for (let index = 0; index < line.length; index++) {
		const char = line[index]!;
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"' && index + 1 < line.length) word += line[++index];
			else word += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (char === "\\" && index + 1 < line.length) {
			word += line[++index];
			started = true;
		} else if (/\s/.test(char)) {
			end();
		} else if (operators.has(char)) {
			end();
			words.push(char);
		} else {
			word += char;
			started = true;
		}
	}
	end();
	return words;
}

interface Command {
	readonly executable: string;
	readonly args: readonly string[];
	readonly source: string;
}

// Every simple command in `line`, split at its control operators, with leading variable assignments dropped. A
// command substitution hides an executable from the parse, so it counts as one named by its syntax.
function commandsIn(line: string): Command[] {
	if (/\$\(|`|<\(|>\(/.test(line)) return [{ executable: "$(...)", args: [], source: line }];
	const found: Command[] = [];
	let current: string[] = [];
	const flush = () => {
		const start = current.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
		if (start !== -1) found.push({ executable: current[start]!, args: current.slice(start + 1), source: line });
		current = [];
	};
	for (const word of shellWords(line)) {
		if (operators.has(word)) flush();
		else current.push(word);
	}
	flush();
	return found;
}

// A code span that is not a command: an option, a path or file name, a number, a quoted argument, or a word quoted from
// doctor. A span of several words is a command unless it starts with an option; a lone bare word is a command too.
function isCommandSpan(span: string): boolean {
	const words = shellWords(span);
	if (words.length === 0 || words[0]!.startsWith("-")) return false;
	if (words.length > 1 || /\$\(|<\(|>\(/.test(span)) return true;
	// An environment variable's name, such as MELIAN_STATE_DIR.
	if (doctorWords.has(words[0]!) || /^[A-Z][A-Z0-9_]*$/.test(words[0]!)) return false;
	return /^[A-Za-z_][\w-]*$/.test(words[0]!) || /^(?:\.{0,2}\/|~\/)/.test(words[0]!);
}

const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;

// Every command a skill's markdown shows: each line of every fenced block, and every inline code span that reads as a
// command line.
function shellCommands(markdown: string): Command[] {
	const blocks = [...markdown.matchAll(fence)].flatMap((match) =>
		match[2]!
			.replace(/\\\n/g, " ")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#")),
	);
	const spans = [...markdown.replace(fence, "").matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)]
		.map((match) => match[2]!.trim())
		.filter(isCommandSpan);
	return [...blocks, ...spans].flatMap(commandsIn);
}

// The inline spans that start with an option, such as `--model provider/id`.
function optionSpans(markdown: string): string[] {
	return [...markdown.replace(fence, "").matchAll(/`(--[a-z][a-z-]*)[^`]*`/g)].map((match) => match[1]!);
}

// `allowed-tools` entries, such as `Bash(melian doctor)`, split at the spaces between them.
function allowedToolEntries(field: string | undefined): string[] {
	return [...(field ?? "").matchAll(/[^\s(]+(?:\([^)]*\))?/g)].map((match) => match[0]);
}

function foreignExecutables(markdown: string): string[] {
	return shellCommands(markdown)
		.filter((command) => command.executable !== "melian")
		.map((command) => `${command.executable} in ${command.source}`);
}

describe("the skill boundary's parser", () => {
	it("finds an executable other than melian in a fenced block, a span, or after an operator", () => {
		expect(foreignExecutables("```sh\ngit clone https://example.invalid/melian.git\n```\n")).toEqual([
			"git in git clone https://example.invalid/melian.git",
		]);
		expect(foreignExecutables("  ```sh\n  npm ci --ignore-scripts \\\n    && npm run build\n  ```\n")).toEqual([
			"npm in npm ci --ignore-scripts      && npm run build",
			"npm in npm ci --ignore-scripts      && npm run build",
		]);
		expect(foreignExecutables("Use `npx --no melian` in place of melian.")).toEqual(["npx in npx --no melian"]);
		expect(foreignExecutables("Run `npm run build`, then `make`.")).toEqual(["npm in npm run build", "make in make"]);
		expect(foreignExecutables("`melian review main && curl https://example.invalid`")).toEqual([
			"curl in melian review main && curl https://example.invalid",
		]);
		expect(foreignExecutables("`MELIAN=1 node packages/cli/bin/melian.js doctor`")).toEqual([
			"node in MELIAN=1 node packages/cli/bin/melian.js doctor",
		]);
		expect(foreignExecutables("`./packages/cli/bin/melian.js`")).toEqual([
			"./packages/cli/bin/melian.js in ./packages/cli/bin/melian.js",
		]);
		expect(foreignExecutables("`melian review $(git merge-base main HEAD)`")).toEqual([
			"$(...) in melian review $(git merge-base main HEAD)",
		]);
	});

	it("reads paths, options, numbers, quoted arguments, and doctor's words as data", () => {
		const text =
			'Set `models.<tier>.model` in `melian.yaml`, pass `--model provider/id`, exit `2`, `"#N"`, `#`, `.git/melian/`, `routes`, `MELIAN_STATE_DIR`, and `melian review "#N"`.';
		expect(foreignExecutables(text)).toEqual([]);
		expect(shellCommands(text).map((command) => [command.executable, ...command.args])).toEqual([
			["melian", "review", "#N"],
		]);
	});

	it("splits allowed-tools into entries", () => {
		expect(allowedToolEntries('Bash(melian doctor) Bash(melian publish "#1") Read')).toEqual([
			"Bash(melian doctor)",
			'Bash(melian publish "#1")',
			"Read",
		]);
	});
});

const consentRule = /^- Never run `melian publish` until the user has seen the findings and told you to publish\.$/m;
const dismissalRule =
	/^- Never run `melian dismiss` unless the user has told you to dismiss that finding, and give the reason they gave\.$/m;

// What breaks a skill's boundary: an executable other than melian, a pre-approval beyond `melian doctor`, a command or
// option the CLI lacks, or a missing rule that publication waits for the user.
function boundaryProblems(text: string, host: string): string[] {
	const { fields, body } = parseSkill(text, host);
	const entries = allowedToolEntries(fields["allowed-tools"]);
	// A bare `melian` names the tool rather than running a command.
	const used = shellCommands(body).filter((command) => command.executable === "melian" && command.args.length > 0);
	return [
		...foreignExecutables(body),
		...foreignExecutables(Object.values(fields).join("\n")),
		...entries.filter((entry) => !allowedTools.includes(entry)).map((entry) => `pre-approves ${entry}`),
		...entries
			.filter((entry) => /publish|review|findings|dismiss/.test(entry))
			.map((entry) => `pre-approves ${entry}`),
		...(host === "claude-code" && entries.join(" ") !== allowedTools.join(" ")
			? ["does not pre-approve doctor"]
			: []),
		...used.filter((command) => !commands.has(command.args[0]!)).map((command) => `runs ${command.source}`),
		...[...used.flatMap((command) => command.args.filter((arg) => arg.startsWith("--"))), ...optionSpans(body)]
			.filter((option) => !options.has(option))
			.map((option) => `passes ${option}`),
		...(consentRule.test(body) ? [] : ["lacks the rule that publication waits for the user"]),
		...(dismissalRule.test(body) ? [] : ["lacks the rule that dismissal waits for the user"]),
	];
}

describe("the skill boundary", () => {
	const text = readFileSync(join(root, "skills/claude-code/SKILL.md"), "utf8");

	// Each edit an earlier skill made, or a reviewer tried, must fail the gate.
	it.each([
		[
			"pre-approving publish",
			(skill: string) => skill.replace(/^(allowed-tools: .*)$/m, "$1 Bash(melian publish:*)"),
		],
		["pre-approving a build", (skill: string) => skill.replace(/^(allowed-tools: .*)$/m, "$1 Bash(npm run build)")],
		[
			"pre-approving every command",
			(skill: string) => skill.replace(/^allowed-tools: .*$/m, "allowed-tools: Bash(*)"),
		],
		[
			"building and running the checkout's melian",
			(skill: string) =>
				skill.replace(
					"## Check readiness\n",
					"## Check readiness\n\nIn a checkout of Melian, run `npm run build` and use `npx --no melian` in place of `melian`.\n",
				),
		],
		[
			"running npx without --no",
			(skill: string) => skill.replace("## Check readiness\n", "## Check readiness\n\nUse `npx melian`.\n"),
		],
		["dropping the consent rule", (skill: string) => skill.replace(consentRule, "")],
		["dropping the dismissal rule", (skill: string) => skill.replace(dismissalRule, "")],
		[
			"pre-approving dismiss",
			(skill: string) => skill.replace(/^(allowed-tools: .*)$/m, "$1 Bash(melian dismiss:*)"),
		],
		["renaming --model", (skill: string) => skill.replaceAll("`--model provider/id`", "`--models provider/id`")],
	])("fails on %s", (_, mutate) => {
		const mutated = mutate(text);
		expect(mutated).not.toBe(text);
		expect(boundaryProblems(mutated, "claude-code")).not.toEqual([]);
	});
});

describe.each(hosts)("skills/%s/SKILL.md", (host) => {
	const { fields, body } = skill(host);

	it("keeps to the boundary", () => {
		expect(boundaryProblems(readFileSync(join(root, "skills", host, "SKILL.md"), "utf8"), host)).toEqual([]);
	});

	it("names the skill and says when to use it", () => {
		expect(fields.name).toBe("melian");
		expect(fields.description).toBeDefined();
		expect(fields.description!.length).toBeLessThanOrEqual(1024);
		expect(fields.description).toMatch(/after committing and before pushing or opening a pull request/);
		expect(fields.description).toMatch(/asked to review a change/);
		expect(fields.description).toMatch(/what Melian thinks/);
	});

	it("runs no executable but melian", () => {
		expect(foreignExecutables(body)).toEqual([]);
		expect(foreignExecutables(Object.values(fields).join("\n"))).toEqual([]);
	});

	it("pre-approves melian doctor alone, and never publish, review, findings, or dismiss", () => {
		const entries = allowedToolEntries(fields["allowed-tools"]);
		for (const entry of entries) expect(allowedTools).toContain(entry);
		for (const entry of entries) expect(entry).not.toMatch(/publish|review|findings|dismiss/);
		if (host === "claude-code") expect(entries).toEqual(allowedTools);
	});

	it("runs only commands and options the melian CLI has", () => {
		// A bare `melian` names the tool rather than running a command.
		const used = shellCommands(body).filter((command) => command.executable === "melian" && command.args.length > 0);
		const names = used.map((each) => each.args[0]);
		expect(new Set(names)).toEqual(new Set(["doctor", "review", "findings", "dismiss", "publish", "compare"]));
		for (const command of names) expect(commands).toContain(command);
		const passed = used.flatMap((each) => each.args.filter((arg) => arg.startsWith("--")));
		expect(new Set(passed)).toEqual(new Set(["--rerun", "--reason", "--from"]));
		for (const option of [...passed, ...optionSpans(body)]) expect(options).toContain(option);
	});

	it("reads the exit codes melian review and the command line end with", () => {
		const table = Object.fromEntries(
			[...body.matchAll(/^ *\| `(\d+)` \| ([A-Za-z, ]+)/gm)].map((match) => [match[2]!.trim(), Number(match[1])]),
		);
		expect(table).toEqual({
			passed: reviewExitCodes.passed,
			"findings, at least one blocking": reviewExitCodes.blocking,
			"not reviewed": reviewExitCodes.notReviewed,
			"findings, none blocking": reviewExitCodes.findings,
			"Melian could not read the command line": usageExitCode,
		});
	});
});

it("gives Codex and Pi the same skill", () => {
	expect(skill("pi")).toEqual(skill("codex"));
});

describe("skill installation", () => {
	// A copy, not a symlink: git writes a symlink as a text file where symlinks are off, and the skill does not load.
	it("installs a copy of the Claude Code skill in this repository, identical to the source", () => {
		const installed = join(root, ".claude/skills/melian");
		expect(lstatSync(installed).isDirectory()).toBe(true);
		expect(lstatSync(join(installed, "SKILL.md")).isFile()).toBe(true);
		expect(
			readFileSync(join(installed, "SKILL.md"), "utf8"),
			"run cp skills/claude-code/SKILL.md .claude/skills/melian/SKILL.md",
		).toBe(readFileSync(join(root, "skills/claude-code/SKILL.md"), "utf8"));
	});

	it("declares the Pi skill in its package manifest", () => {
		const manifest = JSON.parse(readFileSync(join(root, "skills/pi/package.json"), "utf8")) as {
			pi: { skills: string[] };
		};
		expect(manifest.pi.skills.map((path) => realpathSync(join(root, "skills/pi", path)))).toEqual([
			realpathSync(join(root, "skills/pi/SKILL.md")),
		]);
	});
});

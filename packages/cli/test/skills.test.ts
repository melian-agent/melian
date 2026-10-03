import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { usage } from "../src/main.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const hosts = ["claude-code", "codex", "pi"];

function skill(host: string) {
	const text = readFileSync(join(root, "skills", host, "SKILL.md"), "utf8");
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	if (match === null) throw new Error(`skills/${host}/SKILL.md has no front matter`);
	const fields = Object.fromEntries(
		match[1]!.split("\n").map((line) => {
			const colon = line.indexOf(": ");
			return [line.slice(0, colon), line.slice(colon + 2)];
		}),
	);
	return { fields, body: match[2]! };
}

// The commands `melian --help` lists, such as review and doctor.
const commands = new Set([...usage.split("\n\n")[1]!.matchAll(/^ {2}([a-z]+) /gm)].map((match) => match[1]!));

// Every `melian <command>` in the skill's code: inline spans, fenced blocks, and allowed-tools.
function invoked(text: string): string[] {
	const code = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```|`([^`\n]+)`|Bash\(([^)]+)\)/g)].map(
		(match) => match[1] ?? match[2] ?? match[3]!,
	);
	return code.flatMap((span) => [...span.matchAll(/(?:^|[ \t])melian[ \t]+([a-z][a-z-]*)/gm)].map((m) => m[1]!));
}

describe.each(hosts)("skills/%s/SKILL.md", (host) => {
	const { fields, body } = skill(host);

	it("names the skill and says when to use it", () => {
		expect(fields.name).toBe("melian");
		expect(fields.description).toBeDefined();
		expect(fields.description!.length).toBeLessThanOrEqual(1024);
		expect(fields.description).toMatch(/before committing or opening a pull request/);
		expect(fields.description).toMatch(/asked to review a change/);
		expect(fields.description).toMatch(/what Melian thinks/);
	});

	it("runs only commands the melian CLI has", () => {
		const used = invoked(`${fields["allowed-tools"] ?? ""}\n${body}`);
		expect(new Set(used)).toEqual(new Set(["doctor", "review", "findings", "publish"]));
		for (const command of used) expect(commands).toContain(command);
	});
});

describe("skill installation", () => {
	it("installs the Claude Code skill in this repository", () => {
		expect(realpathSync(join(root, ".claude/skills/melian/SKILL.md"))).toBe(
			realpathSync(join(root, "skills/claude-code/SKILL.md")),
		);
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

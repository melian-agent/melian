import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Lens } from "@melian-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { raiseBudgets, roundBudget, withBudget } from "./round.mjs";

const script = fileURLToPath(new URL("./round-budgets.mjs", import.meta.url));
const lenses = fileURLToPath(new URL("../.melian/lenses", import.meta.url));
const scratch = [];

function repository() {
	const dir = mkdtempSync(join(tmpdir(), "round-budgets-"));
	scratch.push(dir);
	cpSync(lenses, join(dir, ".melian", "lenses"), { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: dir });
	return dir;
}

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("withBudget", () => {
	it("adds a budget line before the closing --- when the front matter has none", () => {
		expect(withBudget("---\nname: tests\nextends: tests\n---\nBody\n", roundBudget)).toBe(
			`---\nname: tests\nextends: tests\n${roundBudget}\n---\nBody\n`,
		);
	});

	it("replaces the top-level budget and leaves a level's own budget alone", () => {
		const text = "---\nname: d\nbudget: { findings: 6 }\nlevels:\n  quick: { budget: { findings: 3 } }\n---\n";
		expect(withBudget(text, roundBudget)).toBe(
			`---\nname: d\n${roundBudget}\nlevels:\n  quick: { budget: { findings: 3 } }\n---\n`,
		);
	});

	it("replaces a budget written with spaces before its mapping", () => {
		expect(withBudget("---\nname: t\nbudget:   { findings: 6 }\n---\n", roundBudget)).toBe(
			`---\nname: t\n${roundBudget}\n---\n`,
		);
	});

	it("reads only the front matter, not a budget line in the body", () => {
		expect(withBudget("---\nname: t\n---\nbudget: { findings: 1 }\n", roundBudget)).toBe(
			`---\nname: t\n${roundBudget}\n---\nbudget: { findings: 1 }\n`,
		);
	});

	it("refuses a budget written as a block mapping, which a one-line edit would break", () => {
		expect(() => withBudget("---\nname: t\nbudget:\n  findings: 6\n---\n", roundBudget)).toThrow(
			"a top-level budget must be one flow mapping on one line",
		);
	});

	it("refuses a file without front matter", () => {
		expect(() => withBudget("name: t\n---\n", roundBudget)).toThrow("a LENS.md must open with front matter");
	});

	it("refuses front matter with no closing ---", () => {
		expect(() => withBudget("---\nname: t\n", roundBudget)).toThrow("a LENS.md front matter has no closing ---");
	});
});

describe("raiseBudgets", () => {
	it("gives every committed lens but design the round budget, as Melian's loader reads it", async () => {
		const dir = repository();
		const design = readFileSync(join(dir, ".melian/lenses/design/LENS.md"), "utf8");
		const raised = raiseBudgets(join(dir, ".melian", "lenses"));
		expect(raised.toSorted()).toEqual([
			"contracts",
			"conventions",
			"correctness",
			"durability",
			"removed-behaviour",
			"tests",
			"trust-boundary",
		]);
		expect(readFileSync(join(dir, ".melian/lenses/design/LENS.md"), "utf8")).toBe(design);
		const loaded = new Map((await Lens.load(dir, { kind: "worktree" }, [])).map((lens) => [lens.name, lens]));
		for (const name of raised) {
			expect(loaded.get(name).level("careful").budget, name).toMatchObject({
				findings: 8,
				tokens: 600000,
				tools: 90,
			});
		}
		expect(loaded.get("design").level("careful").budget).toMatchObject({
			findings: 8,
			tokens: 3_000_000,
			tools: 250,
		});
	});

	it("prints the lenses it raised, and refuses to run without a directory", () => {
		const dir = repository();
		const ran = spawnSync(process.execPath, [script, join(dir, ".melian", "lenses")], { encoding: "utf8" });
		expect(ran.status).toBe(0);
		expect(ran.stdout).toMatch(/^raised: [a-z-]+(, [a-z-]+){6}\n$/);
		expect(ran.stdout.slice("raised: ".length, -1).split(", ").toSorted()).toEqual([
			"contracts",
			"conventions",
			"correctness",
			"durability",
			"removed-behaviour",
			"tests",
			"trust-boundary",
		]);
		const bare = spawnSync(process.execPath, [script], { encoding: "utf8" });
		expect(bare.status).toBe(64);
		expect(bare.stderr).toBe("usage: node scripts/round-budgets.mjs <lenses directory>\n");
	});
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DecisionFiles } from "@melian-agent/decisions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commit, createRepository, gitIn, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { DecisionIndexWarning } from "../src/decision-index.ts";
import { main } from "../src/main.ts";

let repo: string;
let base: string;
let io: Io & {
	stdout: ReturnType<typeof vi.fn<(text: string) => void>>;
	stderr: ReturnType<typeof vi.fn<(text: string) => void>>;
};
beforeEach(() => {
	repo = createRepository();
	base = commit(repo, {
		"a.ts": "export const a = 1;\n",
		"melian.yaml": "tiers:\n  fast: [guardrails]\n  full: [fast]\n",
	});
	// The change sits on a branch, so the base the warning reads is not the head.
	gitIn(repo, "checkout", "--quiet", "-b", "change");
	commit(repo, { "a.ts": "export const a = 2;\n" });
	const script = join(repo, "script.json");
	writeFileSync(script, "{}");
	io = {
		cwd: repo,
		env: {
			MELIAN_TEST_SCRIPT: script,
			XDG_CONFIG_HOME: join(repo, "config"),
			PI_CODING_AGENT_DIR: join(repo, "pi"),
			MELIAN_STATE_DIR: join(repo, "state"),
		},
		color: false,
		stdout: vi.fn<(text: string) => void>(),
		stderr: vi.fn<(text: string) => void>(),
	};
});
afterEach(() => {
	vi.restoreAllMocks();
	removeRepository(repo);
});

const longLog = `# ${"x".repeat(70_000)}\n`;
const designTiers = "tiers:\n  fast: [guardrails, lens.design]\n  full: [fast]\n";

// The decision log and the tiers sit at the base, where the design lens reads them; the change stays on its branch.
function withBase(files: Record<string, string>) {
	gitIn(repo, "checkout", "--quiet", "main");
	base = commit(repo, files);
	gitIn(repo, "checkout", "--quiet", "change");
	gitIn(repo, "merge", "--quiet", "--no-edit", "main");
}

it.each([false, true])(
	"prints the warning for the index the design lens read, beside the verdict (json=%s)",
	async (json) => {
		withBase({ "melian.yaml": designTiers, "docs/decisions/2026-10-01-a.md": longLog });
		writeFileSync(io.env.MELIAN_TEST_SCRIPT!, JSON.stringify({ design: [{ text: "Reported 0 findings." }] }));
		const from = vi.spyOn(DecisionIndexWarning, "from");
		expect(await main(["review", "main...HEAD", ...(json ? ["--json"] : [])], io)).toBe(0);
		const warning = (await DecisionFiles.load(repo, base)).warning()!;
		expect(warning).toContain("The decision log is long");
		expect(from).toHaveBeenCalledExactlyOnceWith(
			warning,
			expect.arrayContaining([expect.objectContaining({ name: "lens.design", status: "ran" })]),
		);
		expect(io.stderr).toHaveBeenCalledWith(`melian: ${warning}\n`);
		const printed = io.stdout.mock.calls[0]![0];
		if (json) expect(JSON.parse(printed)).toMatchObject({ status: "passed", warnings: [warning] });
		else expect(printed).not.toContain("The decision log is long");
	},
);

it("prints no warning for a long index no reviewer read", async () => {
	withBase({ "docs/decisions/2026-10-01-a.md": longLog });
	expect(await main(["review", "main...HEAD", "--json"], io)).toBe(0);
	expect(JSON.parse(io.stdout.mock.calls[0]![0])).not.toHaveProperty("warnings");
	expect(io.stderr.mock.calls.filter(([line]) => String(line).includes("decision log"))).toEqual([]);
});

it("hands the warning the checks that did not run as well as those that ran", async () => {
	// A disabled lens leaves a skipped record, which the verdict holds among the checks that did not run.
	withBase({
		"melian.yaml":
			"tiers:\n  fast: [guardrails, lens.tests]\n  full: [fast]\nlenses:\n  tests:\n    enabled: false\n",
	});
	const from = vi.spyOn(DecisionIndexWarning, "from");
	await main(["review", "main...HEAD", "--json"], io);
	expect(from.mock.calls[0]![1]).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "guardrails", status: "ran" }),
			expect.objectContaining({ name: "lens.tests", status: "skipped" }),
		]),
	);
});

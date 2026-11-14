import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

const warned = (text: string) => ({ text }) as DecisionIndexWarning;

it.each([false, true])("prints the decision index warning beside the verdict, never in it (json=%s)", async (json) => {
	const read = vi.spyOn(DecisionIndexWarning, "read").mockResolvedValue(warned("The decision log is long."));
	expect(await main(["review", "main...HEAD", ...(json ? ["--json"] : [])], io)).toBe(0);
	expect(read).toHaveBeenCalledExactlyOnceWith(
		repo,
		base,
		expect.arrayContaining([expect.objectContaining({ name: "guardrails" })]),
	);
	expect(io.stderr).toHaveBeenCalledWith("melian: The decision log is long.\n");
	const printed = io.stdout.mock.calls[0]![0];
	if (json) {
		expect(JSON.parse(printed)).toMatchObject({ status: "passed", warnings: ["The decision log is long."] });
	} else expect(printed).not.toContain("The decision log is long.");
});

it("prints no warning and no warnings field when there is none", async () => {
	expect(await main(["review", "main...HEAD", "--json"], io)).toBe(0);
	expect(JSON.parse(io.stdout.mock.calls[0]![0])).not.toHaveProperty("warnings");
	expect(io.stderr.mock.calls.filter(([line]) => String(line).includes("decision log"))).toEqual([]);
});

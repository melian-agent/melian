import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Pipeline from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commit, createRepository, gitIn, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";

const unshared = [{ finding: "f-static-1", code: "unprovenRun" as const }];
const failWith = vi.hoisted(() => ({ fail: false }));
const dismissed = vi.hoisted(() => ({ records: false }));

vi.mock("@melian-agent/pipeline", async (importOriginal) => {
	const actual = await importOriginal<typeof Pipeline>();
	return {
		...actual,
		reviewChangeset: async (...args: Parameters<typeof actual.reviewChangeset>) => {
			const review = await actual.reviewChangeset(...args);
			if (!failWith.fail) return { ...review, unshared };
			throw new actual.ReviewError("verifierFailed", "the review failed after its export", {
				lenses: [],
				verdict: review.verdict,
				unshared,
			});
		},
		recordDismissal: async (options: Parameters<typeof actual.recordDismissal>[0]) => {
			dismissed.records = options.records !== undefined;
			return {
				finding: {
					ruleId: "biome/no-debugger",
					properties: { path: "a.ts", id: "f-static-1" },
					locations: [{ physicalLocation: { region: { startLine: 1 } } }],
				},
				also: [],
				live: [],
				verdict: { status: "passed", blocking: false },
				unshared,
			} as unknown as Awaited<ReturnType<typeof actual.recordDismissal>>;
		},
	};
});

let repo: string;
let io: Io & {
	stdout: ReturnType<typeof vi.fn<(text: string) => void>>;
	stderr: ReturnType<typeof vi.fn<(text: string) => void>>;
};
beforeEach(() => {
	failWith.fail = false;
	repo = createRepository();
	commit(repo, {
		"a.ts": "export const a = 1;\n",
		"melian.yaml": "tiers:\n  fast: [guardrails]\n  full: [fast]\ntrust:\n  writers: true\n",
	});
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

const warning = "the dismissal of f-static-1 is not shared with the records (unprovenRun)";

it.each([false, true])("warns of each dismissal the review left unshared (json=%s)", async (json) => {
	expect(await main(["review", "main...HEAD", ...(json ? ["--json"] : [])], io)).toBe(0);
	expect(io.stderr).toHaveBeenCalledWith(`melian: ${warning}\n`);
	const printed = io.stdout.mock.calls[0]![0];
	if (json) expect(JSON.parse(printed)).toMatchObject({ status: "passed", warnings: [warning] });
	else expect(printed).not.toContain("not shared");
});

it("warns of an unshared dismissal when the review failed after its export", async () => {
	failWith.fail = true;
	await main(["review", "main...HEAD", "--json"], io);
	expect(io.stderr).toHaveBeenCalledWith("melian: the review failed after its export\n");
	expect(io.stderr).toHaveBeenCalledWith(`melian: ${warning}\n`);
	expect(JSON.parse(io.stdout.mock.calls[0]![0])).toMatchObject({ warnings: [warning] });
});

it("names each dismissal melian dismiss --records left unshared", async () => {
	expect(await main(["review", "main...HEAD"], io)).toBe(0);
	io.stderr.mockClear();
	const store = `dir:${join(repo, "records")}`;
	const id = "0123456789abcdef";

	expect(await main(["dismiss", "main...HEAD", id, "--reason", "meant to stay", "--records", store], io)).toBe(0);

	expect(dismissed.records).toBe(true);
	expect(io.stderr.mock.calls).toEqual([[`melian: ${warning}\n`]]);
});

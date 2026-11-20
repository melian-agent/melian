import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lens } from "@melian-agent/core";
import { CallerContext, reviewChangeset } from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { buildGoldenRepository, loadGoldens, runRange } from "../src/goldens.ts";
import { Miss, ProbeTrust } from "../src/probing.ts";

// Spied, so a test can read what runRange hands the review and stop it there.
vi.mock("@melian-agent/pipeline", { spy: true });

afterEach(() => vi.restoreAllMocks());

it("hands a graph-backed review the callers Enola's graph of the head opened", { timeout: 60_000 }, async () => {
	const failOpen = loadGoldens().find((each) => each.name === "trust-boundary-fail-open")!;
	const { repo, base, head } = buildGoldenRepository(failOpen);
	const scratch = mkdtempSync(join(tmpdir(), "melian-graph-callers-"));
	try {
		const misses = join(scratch, "misses.json");
		writeFileSync(misses, JSON.stringify([{ name: "m", repo, base, head, file: "src/scan.ts", rule: "fail-open" }]));
		const target = Miss.load(misses)[0]!.target(ProbeTrust.parse(`${base},${head}`), "whole", []);
		const callers = { coverageSource: () => ({ parts: [], paths: [], root: repo }) } as unknown as CallerContext;
		vi.spyOn(CallerContext, "open").mockResolvedValue(callers);
		const stopped = new Error("stopped before the review");
		vi.mocked(reviewChangeset).mockRejectedValueOnce(stopped);
		const fake = createFakeModels({ models: [{ id: "x" }] });
		await expect(
			runRange(target, {
				kind: "live",
				models: fake.review,
				model: `${fake.ref("x").provider}/x`,
				probing: { graph: true, routed: (config, lenses) => ({ config, lenses }) },
			}),
		).rejects.toThrow(/^stopped before the review$/);
		expect(reviewChangeset).toHaveBeenCalledOnce();
		expect(vi.mocked(reviewChangeset).mock.calls[0]![0].callers).toBe(callers);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

it("opens the graph over the changed files the lenses select, a rename by its old path included, and names every changed path", {
	timeout: 60_000,
}, async () => {
	const failOpen = loadGoldens().find((each) => each.name === "trust-boundary-fail-open")!;
	const { repo, base } = buildGoldenRepository(failOpen);
	const scratch = mkdtempSync(join(tmpdir(), "melian-graph-files-"));
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
			encoding: "utf8",
		}).trim();
	try {
		git("checkout", "-q", "-b", "selected", base);
		const lenses = (await Lens.builtins()).map((lens) => `  ${lens.name}: { paths: ["src/**"] }`);
		writeFileSync(join(repo, "melian.yaml"), `lenses:\n${lenses.join("\n")}\n`);
		writeFileSync(
			join(repo, "src/old.ts"),
			"export const moved = 1;\nexport const kept = 2;\nexport const also = 3;\n",
		);
		git("add", "--all");
		git("commit", "-q", "-m", "base");
		const policyBase = git("rev-parse", "HEAD");
		writeFileSync(join(repo, "src/scan.ts"), "export const scanned = true;\n");
		mkdirSync(join(repo, "docs"));
		writeFileSync(join(repo, "docs/notes.md"), "# Notes\n");
		mkdirSync(join(repo, "lib"));
		git("mv", "src/old.ts", "lib/new.ts");
		git("add", "--all");
		git("commit", "-q", "-m", "head");
		const head = git("rev-parse", "HEAD");
		const misses = join(scratch, "misses.json");
		writeFileSync(
			misses,
			JSON.stringify([{ name: "m", repo, base: policyBase, head, file: "src/scan.ts", rule: "fail-open" }]),
		);
		const target = Miss.load(misses)[0]!.target(ProbeTrust.parse(`${policyBase},${head}`), "whole", []);
		const open = vi.spyOn(CallerContext, "open").mockResolvedValue({
			coverageSource: () => ({ parts: [], paths: [], root: repo }),
		} as unknown as CallerContext);
		vi.mocked(reviewChangeset).mockRejectedValueOnce(new Error("stopped before the review"));
		const fake = createFakeModels({ models: [{ id: "x" }] });
		await expect(
			runRange(target, {
				kind: "live",
				models: fake.review,
				model: `${fake.ref("x").provider}/x`,
				probing: { graph: true, routed: (config, lenses) => ({ config, lenses }) },
			}),
		).rejects.toThrow(/^stopped before the review$/);
		expect(open).toHaveBeenCalledOnce();
		const [, files, , changed] = open.mock.calls[0]!;
		expect(files.map(({ path, oldPath }) => [path, oldPath])).toEqual([
			["lib/new.ts", "src/old.ts"],
			["src/scan.ts", undefined],
		]);
		expect(changed).toEqual(["docs/notes.md", "lib/new.ts", "src/scan.ts"]);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

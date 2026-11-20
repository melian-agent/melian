import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Comparison, ComparisonExport, ExternalFinding } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { Miss } from "../src/probing.ts";

describe("the comparison's misses export", () => {
	it("is a misses file the measurement tool reads unchanged", () => {
		const report = ExternalFinding.create({
			reviewer: { name: "codex" },
			file: "src/run.ts",
			line: 12,
			endLine: 14,
			title: "eval runs request input",
			body: "The handler passes the body to eval.",
			source: { kind: "file", path: "codex.json", position: 0 },
		});
		const comparison = Comparison.of({ base: "a".repeat(40), head: "b".repeat(40) });
		comparison.import("file:codex.json", { findings: [report], skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
		comparison.adjudicate(report.id, {
			by: "M",
			at: "2026-10-05T00:00:00Z",
			verdict: "valid",
			reason: "owned-missed",
		});
		const { cases } = new ComparisonExport([{ changeset: "pull-7", round: "pull-7.r1", comparison }], "#7").misses(
			"/clone",
		);
		const directory = mkdtempSync(join(tmpdir(), "melian-misses-"));
		try {
			const path = join(directory, "misses.json");
			writeFileSync(path, JSON.stringify(cases));
			const [miss, ...rest] = Miss.load(path);
			expect(rest).toEqual([]);
			expect({ ...miss }).toEqual({
				name: `pull-7-${report.id}`,
				repo: "/clone",
				base: "a".repeat(40),
				head: "b".repeat(40),
				file: "src/run.ts",
				rules: [],
				fix: undefined,
				lines: [12, 14],
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

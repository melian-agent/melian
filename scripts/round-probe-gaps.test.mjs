import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeGapSentences } from "../packages/pipeline/src/review.ts";
import { probeGapLines, unreadable } from "./round-probe-gaps.mjs";

const gap = { check: "lens.trust-boundary", level: "deep", cause: "untrusted-writer" };

describe("round-probe-gaps", () => {
	it("prints each gap's check, level, code and fixed sentence, and nothing else", () => {
		for (const [cause, sentence] of Object.entries(probeGapSentences))
			expect(probeGapLines(JSON.stringify([{ ...gap, cause }]))).toEqual([
				`melian: lens.trust-boundary at deep could not probe here, ${cause}: ${sentence}`,
			]);
		expect(Object.keys(probeGapSentences)).toHaveLength(9);
	});

	it("prints one line for each gap, in order, and none for none", () => {
		expect(
			probeGapLines(JSON.stringify([gap, { check: "lens.design", level: "careful", cause: "probe-refused" }])),
		).toEqual([
			`melian: lens.trust-boundary at deep could not probe here, untrusted-writer: ${probeGapSentences["untrusted-writer"]}`,
			`melian: lens.design at careful could not probe here, probe-refused: ${probeGapSentences["probe-refused"]}`,
		]);
		expect(probeGapLines("[]\n")).toEqual([]);
	});

	it.each([
		["text that is not JSON", "not json"],
		["an object, not a list", JSON.stringify(gap)],
		["a gap that is not an object", JSON.stringify(["lens.trust-boundary"])],
		["a null gap", JSON.stringify([null])],
		["a gap that is a list", JSON.stringify([["lens.trust-boundary", "deep", "untrusted-writer"]])],
		["a gap with a reason beside its cause", JSON.stringify([{ ...gap, reason: "/home/runner/secret" }])],
		["a gap missing its level", JSON.stringify([{ check: gap.check, cause: gap.cause }])],
		["a check with a path in it", JSON.stringify([{ ...gap, check: "lens.trust-boundary /home/runner/secret" }])],
		["a check that is no lens", JSON.stringify([{ ...gap, check: "static.biome" }])],
		["a check with a capital", JSON.stringify([{ ...gap, check: "lens.Trust" }])],
		["a check that is not a string", JSON.stringify([{ ...gap, check: 7 }])],
		["a check that is a list holding a lens", JSON.stringify([{ ...gap, check: ["lens.trust-boundary"] }])],
		["a check with text before its lens", JSON.stringify([{ ...gap, check: "static.lens.trust-boundary" }])],
		["a level outside the levels", JSON.stringify([{ ...gap, level: "/home/runner/secret" }])],
		["a cause outside the causes", JSON.stringify([{ ...gap, cause: "/home/runner/secret" }])],
		["a cause an object inherits", JSON.stringify([{ ...gap, cause: "toString" }])],
		["a cause that is not a string", JSON.stringify([{ ...gap, cause: ["untrusted-writer"] }])],
		["a good gap before a bad one", JSON.stringify([gap, { ...gap, cause: "/home/runner/secret" }])],
	])("prints the fixed line alone for %s", (_, text) => {
		expect(probeGapLines(text)).toEqual([unreadable]);
	});

	it("prints from a file, writes the gaps it printed to the public file, and a fixed line when the round wrote none", () => {
		const directory = mkdtempSync(join(tmpdir(), "melian-probe-gaps-"));
		try {
			const file = join(directory, "gaps.json");
			writeFileSync(file, JSON.stringify([gap]));
			const run = (path) =>
				spawnSync(process.execPath, ["--conditions=@melian-agent/source", "scripts/round-probe-gaps.mjs", path], {
					encoding: "utf8",
				});
			const run2 = (path, out) =>
				spawnSync(
					process.execPath,
					["--conditions=@melian-agent/source", "scripts/round-probe-gaps.mjs", path, out],
					{
						encoding: "utf8",
					},
				);
			const printed = run(file);
			expect(printed.status).toBe(0);
			expect(printed.stdout).toBe(
				`melian: lens.trust-boundary at deep could not probe here, untrusted-writer: ${probeGapSentences["untrusted-writer"]}\n`,
			);
			expect(run(join(directory, "missing.json")).stdout).toBe(
				"melian: the round wrote no probe gaps, so it ended before its lenses did\n",
			);
			const public_ = join(directory, "public.json");
			expect(run2(file, public_).status).toBe(0);
			expect(JSON.parse(readFileSync(public_, "utf8"))).toEqual([gap]);
			for (const text of ["[]", JSON.stringify([{ ...gap, reason: "/home/runner/secret" }])]) {
				rmSync(public_, { force: true });
				writeFileSync(file, text);
				expect(run2(file, public_).status).toBe(0);
				expect(existsSync(public_)).toBe(false);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("prints nothing when another module imports it", () => {
		const imported = spawnSync(
			process.execPath,
			[
				"--conditions=@melian-agent/source",
				"--input-type=module",
				"-e",
				'await import("./scripts/round-probe-gaps.mjs");',
			],
			{ encoding: "utf8" },
		);
		expect([imported.status, imported.stdout]).toEqual([0, ""]);
	});
});

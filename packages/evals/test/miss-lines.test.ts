import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, ExternalFinding } from "@melian-agent/core";
import { MissCause, MissLines, type Stage, StageTelemetry } from "@melian-agent/pipeline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miss, type MissLocation } from "../src/probing.ts";

const file = "f.ts";
let repo: string;
let base: string;
let head: string;

function git(...args: string[]): string {
	return execFileSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" },
	}).trim();
}

function commit(lines: readonly string[]): string {
	writeFileSync(join(repo, file), `${lines.join("\n")}\n`);
	git("add", file);
	git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "change");
	return git("rev-parse", "HEAD");
}

beforeAll(() => {
	repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-miss-lines-")));
	git("init", "--quiet");
	const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
	base = commit(original);
	// The diff's one head-side hunk holds lines 9 to 11.
	head = commit(original.map((line, index) => (index >= 8 && index <= 10 ? `changed ${index + 1}` : line)));
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

function lens(conversation: number, overrides: Partial<Stage> = {}): Stage {
	return {
		id: `conversation:${conversation}`,
		name: "melian.lens",
		subject: "correctness@1@careful",
		task: 7,
		conversation,
		outcome: "completed",
		timing: "available",
		reused: false,
		resumed: false,
		coverage: { scope: "", paths: ["**"], nearer: [] },
		shown: [],
		...overrides,
	};
}

const read = (first: number, last: number) => ({ read: [{ path: file, ranges: [[first, last] as [number, number]] }] });

describe("Miss.unscoped and MissCause", () => {
	it("agree on whether a completed run saw the lines, on one diff", async () => {
		const misses = join(repo, "misses.json");
		writeFileSync(misses, JSON.stringify([{ name: "m", repo, base, head, file, rule: "null-deref" }]));
		const miss = Miss.load(misses)[0]!;
		const { revision } = await Changeset.resolve(repo, `${base}...${head}`);
		const cases: [string, MissLocation, Partial<Stage>, boolean][] = [
			["shown, in a hunk", { by: "lines", ranges: [[11, 12]] }, { shown: [file] }, true],
			["shown, past the hunk", { by: "lines", ranges: [[12, 13]] }, { shown: [file] }, false],
			["shown, before the hunk", { by: "lines", ranges: [[7, 8]] }, { shown: [file] }, false],
			["shown, by file and rule", { by: "file and rule" }, { shown: [file] }, true],
			["read, meeting the start", { by: "lines", ranges: [[5, 6]] }, read(1, 5), true],
			["read, short of the start", { by: "lines", ranges: [[5, 6]] }, read(1, 4), false],
			["read, by file and rule", { by: "file and rule" }, read(18, 19), true],
			["neither", { by: "lines", ranges: [[5, 6]] }, {}, false],
		];
		for (const [name, location, overrides, saw] of cases) {
			const stage = lens(1, overrides);
			const unseen = await miss.unscoped(
				{ telemetry: new StageTelemetry("base..head", [stage]) },
				{ range: `${base}...${head}` },
				location,
				["correctness"],
			);
			const ranges = location.by === "file and rule" ? undefined : location.ranges;
			const external = ExternalFinding.create({
				reviewer: { name: "codex" },
				file,
				...(ranges === undefined ? {} : { line: ranges[0]![0], endLine: ranges[0]![1] }),
				title: name,
				body: "body",
				source: { kind: "file", path: "codex.json", position: 0 },
			});
			expect(unseen === undefined, name).toBe(saw);
			expect(MissLines.of(file, ranges, revision).saw(stage), name).toBe(saw);
			expect(MissCause.of(external, [], { stages: [stage], revision })?.firstRead, name).toBe(
				saw ? "seen, not reported" : "never shown",
			);
		}
	});
});

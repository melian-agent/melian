import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sandbox } from "../../pipeline/src/sandbox.ts";
import { baseAndHead, isolatedGitEnv } from "../../pipeline/test/fixtures/repo.ts";
import { findings, review } from "../src/commands.ts";

let repo: string;
let outside: string;
beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	vi.stubEnv("MELIAN_STATE_DIR", undefined);
	outside = "";
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
	if (outside !== "") rmSync(outside, { recursive: true, force: true });
});

// The head's biome.json extends a file outside the repository, which stock Biome quotes in its error.
function probe(): void {
	repo = baseAndHead(
		{
			"src/a.ts": "export const a = 1;\n",
			"melian.yaml": "tiers:\n  fast: [static.biome]\n  full: [static.biome]\n",
		},
		{},
	);
	outside = join(dirname(repo), `melian-outside-${process.pid}`);
	mkdirSync(outside);
	writeFileSync(join(outside, "auth.json"), JSON.stringify({ anthropic: { key: "FAKE-SECRET-112-KEY" } }, null, 2));
	writeFileSync(join(repo, "biome.json"), JSON.stringify({ extends: [join(outside, "auth.json")] }));
	for (const args of [
		["add", "--all"],
		["commit", "--quiet", "-m", "extends"],
	])
		execFileSync("git", args, { cwd: repo });
}

it("names the file that holds an unconfined tool's output on the terminal's error stream, and nowhere else", {
	timeout: 120_000,
}, async () => {
	probe();
	vi.spyOn(Sandbox, "detect").mockResolvedValue(undefined);
	const out: string[] = [];
	const err: string[] = [];
	const io = {
		cwd: repo,
		env: { ...process.env },
		stdout: (text: string) => out.push(text),
		stderr: (text: string) => err.push(text),
		color: false,
	};
	await review(io, "main", { rerun: false });
	const kept = err.join("").match(/^melian: a tool ran unconfined; what it printed is kept in (.+)$/gm) ?? [];
	// Biome ran on the head and on the base; the base has no such configuration and printed nothing to keep.
	expect(kept).toHaveLength(1);
	const path = kept[0]!.replace("melian: a tool ran unconfined; what it printed is kept in ", "");
	expect(path.startsWith(join(repo, ".git/melian/withheld/static.biome-"))).toBe(true);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
	// The file is where the reviewer reads what the tool said, the quoted file included.
	expect(readFileSync(path, "utf8")).toContain("FAKE-SECRET-112-KEY");
	// The terminal's verdict says the tool ran unconfined and failed, without its words or the path of the file.
	const verdict = out.join("");
	expect(verdict).toContain("ran unconfined: this host offers no sandbox");
	expect(verdict).toContain("output withheld: the tool ran unconfined");
	for (const text of [verdict, err.join("").replace(kept[0]!, "")]) {
		expect(text).not.toContain("FAKE-SECRET");
		expect(text).not.toContain("/withheld/");
	}
	// Nor does the stored verdict, read back as JSON, hold either.
	const json: string[] = [];
	await findings({ ...io, stdout: (text: string) => json.push(text), stderr: () => undefined }, "main", {
		open: false,
		all: true,
		json: true,
	});
	expect(json.join("")).toContain('"confined": false');
	expect(json.join("")).not.toContain("FAKE-SECRET");
	expect(json.join("")).not.toContain("withheld/");
});

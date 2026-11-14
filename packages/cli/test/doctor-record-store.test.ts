import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pipeline from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { check, Remote } from "../../state-git/test/fixtures/remote.ts";
import type { Io } from "../src/commands.ts";
import { doctor } from "../src/doctor.ts";

let directory: string;
let repo: string;
let remote: Remote;
let output: string;
let io: Io;

beforeEach(async () => {
	vi.spyOn(pipeline.Probe, "availability").mockResolvedValue({ available: true });
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	directory = mkdtempSync(join(tmpdir(), "melian-doctor-records-"));
	repo = join(directory, "repo");
	execFileSync("git", ["init", "--quiet", repo]);
	remote = await Remote.create();
	output = "";
	io = {
		cwd: repo,
		env: {
			PATH: process.env.PATH,
			XDG_CONFIG_HOME: directory,
			PI_CODING_AGENT_DIR: directory,
			MELIAN_STATE_DIR: join(directory, "state"),
		},
		stdout: (text) => {
			output += text;
		},
		stderr: () => {},
		color: false,
	};
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await remote.close();
	rmSync(directory, { recursive: true, force: true });
});

// The name column is as wide as the longest name doctor prints, so the line is read without its padding.
const line = () =>
	output
		.split("\n")
		.find((row) => /^\S+\s+records\s/.test(row))
		?.replace(/^(\S+)\s+records\s+/, "$1 records ");
const origin = (url: string) => execFileSync("git", ["remote", "add", "origin", url], { cwd: repo });

describe("doctor's record store line", { timeout: 60_000 }, () => {
	it("leaves the line out with no origin", async () => {
		await doctor(io);
		expect(line()).toBeUndefined();
	});

	it("says the branch holds only what Melian wrote, when it is absent or clean", async () => {
		origin(remote.url);
		await doctor(io);
		expect(line()).toMatch(/^ok records melian\/state holds only records and cells Melian wrote/);
		await (await remote.open()).add([check("a")]);
		output = "";
		await doctor(io);
		expect(line()).toMatch(/^ok records melian\/state holds only/);
	});

	it("names a file Melian did not write, and leaves the exit code alone", async () => {
		origin(remote.url);
		remote.plant({ "notes.txt": { bytes: "hello" } });
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			"warn records melian/state holds a file Melian did not write, which a writer must remove: notes.txt",
		);
	});

	it("names five files and counts the rest", async () => {
		origin(remote.url);
		remote.plant(Object.fromEntries(Array.from({ length: 7 }, (_, n) => [`stray-${n}.txt`, { bytes: `${n}` }])));
		await doctor(io);
		expect(line()).toBe(
			"warn records melian/state holds 7 files Melian did not write, which a writer must remove: stray-0.txt, stray-1.txt, stray-2.txt, stray-3.txt, stray-4.txt, and 2 more",
		);
	});

	it("shows a control character in a file's name as visible text", async () => {
		origin(remote.url);
		remote.plant({ "bad\u001b[31m.txt": { bytes: "x" } });
		await doctor(io);
		expect(line()).not.toContain("\u001b");
		expect(line()).toMatch(/^warn records melian\/state holds a file/);
	});

	it("warns when the remote cannot be read", async () => {
		origin(`file://${join(directory, "absent.git")}`);
		expect(await doctor(io)).toBe(0);
		expect(line()).toMatch(/^warn records /);
	});
});

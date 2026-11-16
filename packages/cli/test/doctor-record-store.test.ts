import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import * as pipeline from "@melian-agent/pipeline";
import { GitRecordStore } from "@melian-agent/state-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { check, Remote } from "../../state-git/test/fixtures/remote.ts";
import type { Io } from "../src/commands.ts";
import { doctor } from "../src/doctor.ts";
import { stateDirectory } from "../src/repository.ts";

let directory: string;
let repo: string;
let remote: Remote;
let output: string;
let io: Io;
let trusted: string;

beforeEach(async () => {
	vi.spyOn(pipeline.Probe, "availability").mockResolvedValue({ available: true });
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	directory = mkdtempSync(join(tmpdir(), "melian-doctor-records-"));
	repo = join(directory, "repo");
	execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
	trusted = policy(true);
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
// Commits a root policy that sets trust.writers, and returns the commit's short name.
function policy(writers: boolean): string {
	writeFileSync(join(repo, "melian.yaml"), `trust: { writers: ${writers} }\n`);
	execFileSync("git", ["add", "melian.yaml"], { cwd: repo });
	execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", `writers ${writers}`], { cwd: repo });
	return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}
const clean = "melian/state holds only records and cells Melian wrote, or is not there yet";
const writersTrusted = (ref: string, commit: string) =>
	`its writers are trusted as the repository's writers, by trust.writers in ${ref} (${commit})`;

describe("doctor's record store line", { timeout: 60_000 }, () => {
	it("leaves the line out with no origin", async () => {
		await doctor(io);
		expect(line()).toBeUndefined();
	});

	it("leaves the line out outside a repository", async () => {
		await doctor({ ...io, cwd: directory });
		expect(line()).toBeUndefined();
	});

	it("warns when the store's own repository cannot be opened", async () => {
		origin(remote.url);
		const state = await stateDirectory(repo, io.env);
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "records.git"), "");
		expect(await doctor(io)).toBe(0);
		expect(line()).toMatch(/^warn records .*records\.git is not a directory; its writers are trusted /);
	});

	it("names none of an origin that carries a token", async () => {
		origin("https://melian:FAKESECRET@127.0.0.1:9/x.git?token=QUERYSECRET");
		expect(await doctor(io)).toBe(0);
		expect(line()).toMatch(
			/^warn records fetching melian\/state from the clone's origin failed, git exit \d+; run `git ls-remote/,
		);
		expect(output).not.toMatch(/melian:|FAKESECRET|QUERYSECRET|127\.0\.0\.1/);
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
			`warn records melian/state holds a file Melian did not write, which a writer must remove: notes.txt; ${writersTrusted("main", trusted)}`,
		);
	});

	it("names five files and counts the rest", async () => {
		origin(remote.url);
		remote.plant(Object.fromEntries(Array.from({ length: 7 }, (_, n) => [`stray-${n}.txt`, { bytes: `${n}` }])));
		await doctor(io);
		expect(line()).toBe(
			`warn records melian/state holds 7 files Melian did not write, which a writer must remove: stray-0.txt, stray-1.txt, stray-2.txt, stray-3.txt, stray-4.txt, and 2 more; ${writersTrusted("main", trusted)}`,
		);
	});

	it("shows a control character in a file's name as visible text", async () => {
		origin(remote.url);
		remote.plant({ "bad\u001b[31m.txt": { bytes: "x" } });
		await doctor(io);
		expect(line()).not.toContain("\u001b");
		expect(line()).toMatch(/^warn records melian\/state holds a file/);
	});

	it("reads a relative origin from the checkout, not from the store's own repository", async () => {
		origin(relative(repo, remote.path));
		remote.plant({ "notes.txt": { bytes: "hello" } });
		await doctor(io);
		expect(line()).toBe(
			`warn records melian/state holds a file Melian did not write, which a writer must remove: notes.txt; ${writersTrusted("main", trusted)}`,
		);
	});

	it("passes a URL, an scp-style remote and an absolute path on unchanged, and resolves a relative path", async () => {
		const open = vi.spyOn(GitRecordStore, "open").mockRejectedValue(new Error("stopped"));
		origin("https://example.invalid/x.git");
		const top = realpathSync(repo);
		const remotes = {
			"https://example.invalid/x.git": "https://example.invalid/x.git",
			"git@example.invalid:x/y.git": "git@example.invalid:x/y.git",
			"host:y.git": "host:y.git",
			[remote.path]: remote.path,
			"./up:stream.git": join(top, "up:stream.git"),
			"../upstream.git": join(dirname(top), "upstream.git"),
		};
		for (const url of Object.keys(remotes)) {
			execFileSync("git", ["remote", "set-url", "origin", url], { cwd: repo });
			await doctor(io);
		}
		expect(open.mock.calls.map(([options]) => options.remote)).toEqual(Object.values(remotes));
	});

	it("warns when the remote cannot be read", async () => {
		origin(`file://${join(directory, "absent.git")}`);
		expect(await doctor(io)).toBe(0);
		expect(line()).toMatch(/^warn records /);
	});

	it("says the branch's writers are trusted as the repository's when trust.writers is on", async () => {
		origin(remote.url);
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(`ok records ${clean}; ${writersTrusted("main", trusted)}`);
	});

	it("warns that only the trusted host may write the branch when trust.writers is off", async () => {
		origin(remote.url);
		const off = policy(false);
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; trust.writers in main (${off}) is off, so only the trusted host may write melian/state; doctor cannot check who may push to it`,
		);
	});

	it("reads the policy from the same base as the trust line", async () => {
		origin(remote.url);
		const off = policy(false);
		execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repo });
		execFileSync("git", ["reset", "--quiet", "--hard", "HEAD~1"], { cwd: repo });
		await doctor(io);
		expect(output).toMatch(new RegExp(`^warn\\s+trust\\s+writers trusted: no; policy origin/main \\(${off}\\)`, "m"));
		expect(line()).toBe(
			`warn records ${clean}; trust.writers in origin/main (${off}) is off, so only the trusted host may write melian/state; doctor cannot check who may push to it`,
		);
	});

	it("warns that who may write the branch is unknown when no policy is committed", async () => {
		rmSync(repo, { recursive: true, force: true });
		execFileSync("git", ["init", "--quiet", repo]);
		origin(remote.url);
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; who may write it is unknown, since the trust policy cannot be read: no committed root policy is available`,
		);
	});
});

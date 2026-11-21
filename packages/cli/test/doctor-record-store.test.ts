import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ProcessTable } from "@melian-agent/core";
import * as pipeline from "@melian-agent/pipeline";
import { GitRecordStore, TipSize } from "@melian-agent/state-git";
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
// Commits a root policy that sets trust.writers, points origin/main at it, and returns the commit's short name.
function policy(writers: boolean): string {
	writeFileSync(join(repo, "melian.yaml"), `trust: { writers: ${writers} }\n`);
	execFileSync("git", ["add", "melian.yaml"], { cwd: repo });
	execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", `writers ${writers}`], { cwd: repo });
	execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repo });
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
			`warn records melian/state holds a file Melian did not write, which a writer must remove: notes.txt; ${writersTrusted("origin/main", trusted)}`,
		);
	});

	it("names five files and counts the rest", async () => {
		origin(remote.url);
		remote.plant(Object.fromEntries(Array.from({ length: 7 }, (_, n) => [`stray-${n}.txt`, { bytes: `${n}` }])));
		await doctor(io);
		expect(line()).toBe(
			`warn records melian/state holds 7 files Melian did not write, which a writer must remove: stray-0.txt, stray-1.txt, stray-2.txt, stray-3.txt, stray-4.txt, and 2 more; ${writersTrusted("origin/main", trusted)}`,
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
			`warn records melian/state holds a file Melian did not write, which a writer must remove: notes.txt; ${writersTrusted("origin/main", trusted)}`,
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
		expect(line()).toBe(`ok records ${clean}; ${writersTrusted("origin/main", trusted)}`);
	});

	it("warns that only the trusted host may write the branch when trust.writers is off", async () => {
		origin(remote.url);
		const off = policy(false);
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; trust.writers in origin/main (${off}) is off, so only the trusted host may write melian/state; doctor cannot check who may push to it`,
		);
	});

	it("reads the policy from the same base as the trust line", async () => {
		origin(remote.url);
		const off = policy(false);
		execFileSync("git", ["reset", "--quiet", "--hard", "HEAD~1"], { cwd: repo });
		await doctor(io);
		expect(output).toMatch(new RegExp(`^warn\\s+trust\\s+writers trusted: no; policy origin/main \\(${off}\\)`, "m"));
		expect(line()).toBe(
			`warn records ${clean}; trust.writers in origin/main (${off}) is off, so only the trusted host may write melian/state; doctor cannot check who may push to it`,
		);
	});

	it("warns that the policy may be stale when it comes from local main", async () => {
		origin(remote.url);
		execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: repo });
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; ${writersTrusted("main", trusted)}; base policy may be stale; using local main`,
		);
	});

	it("warns that the base policy is unknown when it comes from HEAD", async () => {
		origin(remote.url);
		execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: repo });
		execFileSync("git", ["checkout", "--quiet", "--detach"], { cwd: repo });
		execFileSync("git", ["branch", "--quiet", "-D", "main"], { cwd: repo });
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; ${writersTrusted("HEAD", trusted)}; base policy is unknown; using committed HEAD`,
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
	it("names a leftover the sweep kept because its name records no maker it can check", async () => {
		origin(remote.url);
		const state = await stateDirectory(repo, io.env);
		mkdirSync(join(state, "records.git.not-an-owner"), { recursive: true });
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; the state directory keeps a leftover whose maker Melian cannot tell is gone, which a person may remove once no Melian uses the directory: records.git.not-an-owner; ${writersTrusted("origin/main", trusted)}`,
		);
	});

	it("names five kept leftovers, counts the rest, and shows a control character as visible text", async () => {
		origin(remote.url);
		const state = await stateDirectory(repo, io.env);
		for (const n of [0, 1, 2, 3, 4, 5]) mkdirSync(join(state, `records.git.kept-${n}`), { recursive: true });
		mkdirSync(join(state, "records.git.bad\u001b[31m"), { recursive: true });
		await doctor(io);
		expect(line()).not.toContain("\u001b");
		expect(line()).toMatch(
			/^warn records .*; the state directory keeps 7 leftovers whose maker Melian cannot tell is gone, which a person may remove once no Melian uses the directory: records\.git\.bad.*, records\.git\.kept-0, records\.git\.kept-1, records\.git\.kept-2, records\.git\.kept-3, and 2 more; its writers/,
		);
	});

	it("names what the sweep kept when the branch then cannot be read", async () => {
		origin(`file://${join(directory, "absent.git")}`);
		const state = await stateDirectory(repo, io.env);
		mkdirSync(join(state, "records.git.not-an-owner"), { recursive: true });
		expect(await doctor(io)).toBe(0);
		expect(line()).toMatch(
			/^warn records fetching melian\/state from the clone's origin failed, git exit \d+; run `git ls-remote origin refs\/heads\/melian\/state` in the clone to see git's own words; the state directory keeps a leftover whose maker Melian cannot tell is gone, which a person may remove once no Melian uses the directory: records\.git\.not-an-owner; its writers /,
		);
	});

	it("says the sweep removed nothing when the process table cannot be read, and names what it kept", async () => {
		origin(remote.url);
		const state = await stateDirectory(repo, io.env);
		mkdirSync(join(state, "records.git.not-an-owner"), { recursive: true });
		vi.spyOn(ProcessTable.prototype, "list").mockImplementation(() => {
			throw new Error("ps failed: no ps here");
		});
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; the state directory was not swept, since the process table cannot be read: ps failed: no ps here; the state directory keeps a leftover whose maker Melian cannot tell is gone, which a person may remove once no Melian uses the directory: records.git.not-an-owner; ${writersTrusted("origin/main", trusted)}`,
		);
	});

	it("names a leftover the sweep could not remove", async () => {
		origin(remote.url);
		vi.spyOn(GitRecordStore, "open").mockResolvedValue({
			strays: async () => [],
			sweep: { removed: ["records.git.gone"], kept: [], failed: ["refs/melian/fetch/held"] },
			close: async () => {},
		} as unknown as GitRecordStore);
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; the state directory holds a leftover of an exited call that Melian could not remove: refs/melian/fetch/held; ${writersTrusted("origin/main", trusted)}`,
		);
	});

	it("counts the leftovers the sweep left when its deadline ran out", async () => {
		origin(remote.url);
		vi.spyOn(GitRecordStore, "open").mockResolvedValue({
			strays: async () => [],
			sweep: { removed: [], kept: [], failed: [], unswept: 3 },
			close: async () => {},
		} as unknown as GitRecordStore);
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; the state directory holds 3 leftovers of exited calls that the sweep ran out of time to remove, which the next open removes; ${writersTrusted("origin/main", trusted)}`,
		);
	});

	it("says the sweep removed nothing when time ran out before it listed every leftover", async () => {
		origin(remote.url);
		vi.spyOn(GitRecordStore, "open").mockResolvedValue({
			strays: async () => [],
			sweep: { removed: [], kept: [], failed: [], unswept: 2, unlisted: true },
			close: async () => {},
		} as unknown as GitRecordStore);
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; the state directory holds 2 leftovers of exited calls that the sweep left, since it could not list them all, which the next open removes; ${writersTrusted("origin/main", trusted)}`,
		);
	});

	it("says the sweep removed nothing when it could not list its leftovers", async () => {
		origin(remote.url);
		vi.spyOn(GitRecordStore, "open").mockResolvedValue({
			strays: async () => [],
			sweep: { removed: [], kept: [], failed: [], unlisted: true },
			close: async () => {},
		} as unknown as GitRecordStore);
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; the state directory was not swept, since the sweep could not list its leftovers, which the next open retries; ${writersTrusted("origin/main", trusted)}`,
		);
	});

	it("says the sweep stopped listing at its bound", async () => {
		origin(remote.url);
		vi.spyOn(GitRecordStore, "open").mockResolvedValue({
			strays: async () => [],
			sweep: { removed: ["records.git.gone"], kept: [], failed: [], bounded: true },
			close: async () => {},
		} as unknown as GitRecordStore);
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; the sweep stopped listing at its bound of 1000 leftovers, so the state directory may hold more, which a later open lists once fewer are left; ${writersTrusted("origin/main", trusted)}`,
		);
	});

	it("says one leftover was left when the deadline ran out", async () => {
		origin(remote.url);
		vi.spyOn(GitRecordStore, "open").mockResolvedValue({
			strays: async () => [],
			sweep: { removed: [], kept: [], failed: [], unswept: 1 },
			close: async () => {},
		} as unknown as GitRecordStore);
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(
			`warn records ${clean}; the state directory holds a leftover of an exited call that the sweep ran out of time to remove, which the next open removes; ${writersTrusted("origin/main", trusted)}`,
		);
	});

	it("says nothing of a sweep that removed what it found", async () => {
		origin(remote.url);
		vi.spyOn(GitRecordStore, "open").mockResolvedValue({
			strays: async () => [],
			sweep: { removed: ["records.git.gone"], kept: [], failed: [] },
			close: async () => {},
		} as unknown as GitRecordStore);
		expect(await doctor(io)).toBe(0);
		expect(line()).toBe(`ok records ${clean}; ${writersTrusted("origin/main", trusted)}`);
	});
});

const sizeLine = () =>
	output
		.split("\n")
		.find((row) => /^\S+\s+tip size\s/.test(row))
		?.replace(/^(\S+)\s+tip size\s+/, "$1 tip size ");
// Empty files outside every changeset's folder, which count as entries and hold no record bytes.
const noise = (count: number) =>
	Object.fromEntries(Array.from({ length: count }, (_, n) => [`noise/${n}`, { bytes: "" }] as const));

describe("doctor's tip size line", { timeout: 300_000 }, () => {
	it("leaves the line out with no origin", async () => {
		await doctor(io);
		expect(sizeLine()).toBeUndefined();
	});

	it("prints the tip's size beside each limit below half of every one, after the records line", async () => {
		origin(remote.url);
		await (await remote.open()).add([check("a")]);
		expect(await doctor(io)).toBe(0);
		expect(sizeLine()).toBe(
			"ok tip size melian/state: 1 of 65,536 entries, 0 MiB of 256 MiB, listing 0 MiB of 64 MiB",
		);
		const rows = output.split("\n");
		expect(rows.findIndex((row) => /^\S+\s+tip size\s/.test(row))).toBe(
			rows.findIndex((row) => /^\S+\s+records\s/.test(row)) + 1,
		);
	});

	it("warns of none at exactly half the entry limit, and names the entries one past it", async () => {
		origin(remote.url);
		remote.plant(noise(32_768));
		await doctor(io);
		expect(sizeLine()).toMatch(/^ok tip size melian\/state: 32,768 of 65,536 entries, /);
		remote.plant({ late: { bytes: "" } });
		output = "";
		expect(await doctor(io)).toBe(0);
		expect(sizeLine()).toMatch(
			/^warn tip size melian\/state: 32,769 of 65,536 entries, \d+ MiB of 256 MiB, listing \d+ MiB of 64 MiB; melian\/state is past half its entry limit: 32,769 of 65,536\. Nothing removes records from melian\/state yet; https:\/\/github\.com\/melian-agent\/melian\/issues\/617 adds the prune\.$/,
		);
	});

	it("prints the totals beside the records line's refusal on a tip past a limit", async () => {
		origin(remote.url);
		remote.plant(noise(65_537));
		expect(await doctor(io)).toBe(0);
		expect(line()).toMatch(
			/^warn records melian\/state holds 65537 entries at its tip, past the store's limit of 65536; /,
		);
		expect(sizeLine()).toMatch(
			/^warn tip size melian\/state: 65,537 of 65,536 entries, .*; melian\/state is past its entry limit: 65,537 of 65,536\. /,
		);
	});

	it("warns, and says why nothing is counted, on a tip whose listing is too large to read", async () => {
		origin(remote.url);
		vi.spyOn(GitRecordStore.prototype, "size").mockResolvedValue(TipSize.unlisted());
		expect(await doctor(io)).toBe(0);
		expect(sizeLine()).toBe(
			"warn tip size melian/state: listing more than 64 MiB of 64 MiB, so its entries and bytes are not counted; melian/state's listing was too large to read, past 67,108,864 bytes, so the store is past its listing limit. Nothing removes records from melian/state yet; https://github.com/melian-agent/melian/issues/617 adds the prune.",
		);
	});

	it("warns that the size could not be read when the remote cannot be", async () => {
		origin(`file://${join(directory, "absent.git")}`);
		expect(await doctor(io)).toBe(0);
		expect(sizeLine()).toMatch(
			/^warn tip size melian\/state's size could not be read: fetching melian\/state from the clone's origin failed, git exit \d+; /,
		);
	});

	it("warns that the size could not be read when the store's own repository cannot be opened", async () => {
		origin(remote.url);
		const state = await stateDirectory(repo, io.env);
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "records.git"), "");
		await doctor(io);
		expect(sizeLine()).toMatch(
			/^warn tip size melian\/state's size could not be read: .*records\.git is not a directory/,
		);
	});

	it("reads the size when the strays cannot be read, and the strays when the size cannot", async () => {
		origin(remote.url);
		const strays = vi.spyOn(GitRecordStore.prototype, "strays").mockRejectedValue(new Error("strays failed"));
		await doctor(io);
		expect(line()).toMatch(/^warn records strays failed; /);
		expect(sizeLine()).toMatch(/^ok tip size melian\/state: 0 of 65,536 entries/);
		strays.mockRestore();
		vi.spyOn(GitRecordStore.prototype, "size").mockRejectedValue(new Error("size failed"));
		output = "";
		await doctor(io);
		expect(line()).toMatch(/^ok records /);
		expect(sizeLine()).toBe("warn tip size melian/state's size could not be read: size failed");
	});
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TipSize } from "@melian-agent/state-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { check, Remote } from "../../state-git/test/fixtures/remote.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";

let directory: string;
let repo: string;
let remote: Remote;
let out: string;
let err: string;
let io: Io;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	directory = mkdtempSync(join(tmpdir(), "melian-records-size-"));
	repo = join(directory, "repo");
	execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
	remote = await Remote.create();
	out = "";
	err = "";
	io = {
		cwd: repo,
		env: { PATH: process.env.PATH, XDG_CONFIG_HOME: directory, MELIAN_STATE_DIR: join(directory, "state") },
		stdout: (text) => {
			out += text;
		},
		stderr: (text) => {
			err += text;
		},
		color: false,
	};
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await remote.close();
	rmSync(directory, { recursive: true, force: true });
});

const origin = (url: string) => execFileSync("git", ["remote", "add", "origin", url], { cwd: repo });
const strays = (count: number) =>
	Object.fromEntries(Array.from({ length: count }, (_, n) => [`noise/${n}`, { bytes: "" }] as const));

describe("melian records size", { timeout: 120_000 }, () => {
	it("prints the size line alone below half of every limit", async () => {
		origin(remote.url);
		await (await remote.open()).add([check("a")]);
		const size = await (await remote.open()).size();
		expect(await main(["records", "size"], io)).toBe(0);
		expect(out).toBe(`${size.line()}\n`);
		expect(out).toMatch(/^melian\/state: 1 of 65,536 entries, 0 MiB of 256 MiB, listing 0 MiB of 64 MiB\n$/);
	});

	it("prints the warning on a line of its own one entry past half the entry limit", async () => {
		origin(remote.url);
		remote.plant(strays(32_769));
		expect(await main(["records", "size"], io)).toBe(0);
		const [line, warning, rest] = out.split("\n");
		expect([line, rest]).toEqual([expect.stringMatching(/^melian\/state: 32,769 of 65,536 entries, /), ""]);
		expect(warning).toMatch(/^melian\/state is past half its entry limit: 32,769 of 65,536\. The daily prune /);
	});

	it("prints the counts alone as JSON, which a size reads back", async () => {
		origin(remote.url);
		remote.plant(strays(3));
		expect(await main(["records", "size", "--json"], io)).toBe(0);
		const listing = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", remote.tip()!], {
			cwd: remote.path,
		}).length;
		expect(JSON.parse(out)).toEqual({ entries: 3, recordBytes: 0, listingBytes: listing });
		expect(TipSize.parse(JSON.parse(out)).counted).toEqual({ entries: 3, recordBytes: 0, listingBytes: listing });
	});

	it("counts nothing on a branch not there yet", async () => {
		origin(remote.url);
		expect(await main(["records", "size", "--json"], io)).toBe(0);
		expect(out).toBe('{"entries":0,"recordBytes":0,"listingBytes":0}\n');
	});

	it("fails without quoting git when the remote cannot be read", async () => {
		origin("https://melian:FAKESECRET@127.0.0.1:9/x.git?token=QUERYSECRET");
		expect(await main(["records", "size", "--json"], io)).toBe(1);
		expect(out).toBe("");
		expect(err).toBe("melian: melian/state's size could not be read (unreachable); melian doctor says why\n");
	});

	it("passes on an error that is not the store's in its own words", async () => {
		expect(await main(["records", "size"], io)).toBe(1);
		expect(err).toMatch(/^melian: git remote failed: /);
	});

	it.each([
		[["records", "size", "#7"]],
		[["records", "size", "--check"]],
		[["records", "size", "--from", "dir:x"]],
		[["records", "size", "--expect-base", "a", "--expect-head", "b"]],
	])("refuses %j as usage", async (args) => {
		expect(await main(args, io)).toBe(64);
		expect(err).toContain("records size takes no target and no option but --json");
		expect(out).toBe("");
	});
});

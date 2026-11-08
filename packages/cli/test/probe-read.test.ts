import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pipeline from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { probe } from "../src/probe.ts";

// What `melian probe` asks of each file's descriptor. A file that grows after its listing is read only to one byte past
// the bound, which no file on disk can show without a race, so the test reads the request itself.
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof files>();
	return { ...actual, open: vi.fn(actual.open) };
});

let repo: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-read-")));
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	mkdirSync(join(repo, "probe"));
	writeFileSync(join(repo, "probe", "probe.mjs"), "");
	writeFileSync(join(repo, "probe", "data"), "inside");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(repo, { recursive: true, force: true });
});

it("reads each file only to one byte past the bound", async () => {
	const streams: unknown[] = [];
	const actual = vi.mocked(files.open).getMockImplementation()!;
	vi.mocked(files.open).mockImplementation(async (...args) => {
		const handle: FileHandle = await actual(...args);
		const stream = handle.createReadStream.bind(handle);
		handle.createReadStream = (options) => {
			streams.push(options);
			return stream(options);
		};
		return handle;
	});
	vi.spyOn(pipeline.Probe, "open").mockRejectedValue(new pipeline.ProbeError("invalidProbe", "stop"));
	const io = { cwd: repo, env: process.env, stdout: () => {}, stderr: () => {}, color: false };
	await probe(io, "probe", { trustHead: true, json: false });
	expect(streams).toEqual([
		{ end: pipeline.probeLimits.fileBytes, autoClose: false },
		{ end: pipeline.probeLimits.fileBytes, autoClose: false },
	]);
});

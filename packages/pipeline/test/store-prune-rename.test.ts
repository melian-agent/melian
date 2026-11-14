import * as files from "node:fs/promises";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolManifest } from "@melian-agent/core";
import { StorePrune } from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commit, createRepository, removeRepository } from "./fixtures/repo.ts";

vi.mock("node:fs/promises", { spy: true });

const manifest = ToolManifest.parse(JSON.stringify({ format_version: 1, tools: {}, misses: [] }));
let repo: string;
let state: string;

beforeEach(async () => {
	repo = createRepository();
	commit(repo, { "a.ts": "export const a = 1;\n" });
	state = await realpath(await mkdtemp(join(tmpdir(), "melian-prune-rename-")));
});
afterEach(async () => {
	vi.mocked(files.rename).mockReset();
	removeRepository(repo);
	await rm(state, { recursive: true, force: true });
});

// A rename that fails while a forced rm of the new name succeeds, as an immutable entry's does.
it("stops at a rename that fails for a reason other than the path being gone, and counts nothing removed", async () => {
	await mkdir(join(state, "tools", "other"), { recursive: true });
	await writeFile(join(state, "tools", "other", "enola"), "12345");
	const prune = await StorePrune.open(repo, { root: state, manifest });
	expect(prune.entries).toEqual([{ kind: "unpinned tool", paths: ["tools/other"], bytes: 5 }]);
	vi.mocked(files.rename).mockRejectedValueOnce(
		Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
	);
	await expect(prune.apply()).rejects.toMatchObject({ code: "EPERM" });
	expect((await lstat(join(state, "tools", "other", "enola"))).size).toBe(5);
});

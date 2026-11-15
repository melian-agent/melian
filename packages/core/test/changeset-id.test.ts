import { Changeset, isChangesetId, pullRequestChangesetId } from "@melian-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("isChangesetId", () => {
	it("accepts the ID each builder returns", async () => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		const pull = pullRequestChangesetId("github", { owner: "Owner", name: "Repo" }, 7);
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "-q", "-b", "main");
			writeFiles(repo, { "a.txt": "a\n" });
			gitIn(repo, "add", "a.txt");
			gitIn(repo, "commit", "-q", "-m", "base");
			gitIn(repo, "branch", "base");
			writeFiles(repo, { "a.txt": "b\n" });
			gitIn(repo, "commit", "-q", "-am", "head");
			const range = await Changeset.resolve(repo, "base...main");
			expect([pull, range.id].map(isChangesetId)).toEqual([true, true]);
			expect([pull.slice(0, 5), range.id.slice(0, 6)]).toEqual(["pull-", "range-"]);
		} finally {
			removeDirectory(repo);
		}
	});

	it.each([
		["one hex digit short", "pull-0123456789abcde"],
		["one hex digit too many", "pull-0123456789abcdef0"],
		["uppercase hex", "range-0123456789ABCDEF"],
		["another prefix", "push-0123456789abcdef"],
		["a suffix after the digits", "range-0123456789abcdef.sqlite"],
		["text before the prefix", "xpull-0123456789abcdef"],
		["a trailing newline", "pull-0123456789abcdef\n"],
	])("refuses %s", (_, id) => {
		expect(isChangesetId(id)).toBe(false);
	});

	it("accepts both prefixes at exactly sixteen hex digits", () => {
		expect(["pull-0123456789abcdef", "range-fedcba9876543210"].map(isChangesetId)).toEqual([true, true]);
	});
});

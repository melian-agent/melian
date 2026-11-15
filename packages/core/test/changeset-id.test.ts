import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, isChangesetId, pullRequestChangesetId } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

describe("isChangesetId", () => {
	it("accepts the ID each builder returns", async () => {
		const pull = pullRequestChangesetId("github", { owner: "Owner", name: "Repo" }, 7);
		const repo = mkdtempSync(join(tmpdir(), "melian-changeset-id-"));
		try {
			const run = (...args: string[]) =>
				execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_CONFIG_COUNT: "0" } });
			run("init", "-q", "-b", "main");
			run("config", "user.email", "test@example.com");
			run("config", "user.name", "Test");
			writeFileSync(join(repo, "a.txt"), "a\n");
			run("add", "a.txt");
			run("commit", "-q", "-m", "base");
			run("branch", "base");
			writeFileSync(join(repo, "a.txt"), "b\n");
			run("commit", "-q", "-am", "head");
			const range = await Changeset.resolve(repo, "base...main");
			expect([pull, range.id].map(isChangesetId)).toEqual([true, true]);
			expect([pull.slice(0, 5), range.id.slice(0, 6)]).toEqual(["pull-", "range-"]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
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

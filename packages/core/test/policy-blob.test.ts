import { execFileSync } from "node:child_process";
import { Changeset, evaluateGuardrails } from "@melian-agent/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

let repo: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, { "AGENTS.md": "Old guidance.\n" });
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", "base");
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	writeFiles(repo, { "AGENTS.md": "New guidance.\n" });
	gitIn(repo, "commit", "--quiet", "-am", "head");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

it.each(["policy", "unrelated"])("does not mistake a non-UTF-8 %s name for an absent policy blob", async (kind) => {
	const options = { cwd: repo, env: process.env };
	const root = execFileSync("git", ["ls-tree", "-z", "HEAD"], options);
	const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
		...options,
		input: "Changed content.\n",
		encoding: "utf8",
	}).trim();
	const name = kind === "policy" ? "AGENTS.md" : "notes.txt";
	const subtree = execFileSync("git", ["mktree", "-z"], {
		...options,
		input: Buffer.from(`100644 blob ${blob}\t${name}\0`),
		encoding: "utf8",
	}).trim();
	// Git writes the raw name into its tree; the sandbox cannot create that name on disk.
	const tree = execFileSync("git", ["mktree", "-z"], {
		...options,
		input: Buffer.concat([root, Buffer.from(`040000 tree ${subtree}\tdocs`), Buffer.from([255, 0])]),
		encoding: "utf8",
	}).trim();
	const head = execFileSync("git", ["commit-tree", tree, "-p", "HEAD", "-m", "raw name"], {
		...options,
		encoding: "utf8",
	}).trim();
	gitIn(repo, "update-ref", "refs/heads/feature", head);
	const { revision } = await Changeset.resolve(repo, "main...feature");
	expect(revision.files.find((file) => file.path.startsWith("docs%FF/"))?.percentEncoded).toBe(true);
	const report = evaluateGuardrails({ repoRoot: repo, revision, source: { kind: "revision", commit: revision.base } });
	if (kind === "policy") {
		await expect(report).rejects.toMatchObject({
			code: "unreadable",
			check: "guardrails",
			message: expect.stringContaining("not UTF-8"),
		});
	} else {
		expect((await report).findings.map((finding) => finding.properties.path)).toEqual(["AGENTS.md"]);
	}
});

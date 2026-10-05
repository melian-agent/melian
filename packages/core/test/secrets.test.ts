import { chmodSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadSecrets } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	gitIn,
	isolatedGitEnv,
	lines,
	rejection as rejectionOf,
	removeDirectory,
	temporaryDirectory,
	writeFiles,
} from "./fixtures/repo.ts";

let repo: string;
let home: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	home = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
	removeDirectory(home);
});

const rejection = (promise: Promise<unknown>) => rejectionOf(promise, ConfigError);

// Writes a secrets file as Pi writes its store, readable by its owner alone.
function secrets(root: string, file: string, ...content: string[]): string {
	writeFiles(root, { [file]: lines(...content) });
	chmodSync(join(root, file), 0o600);
	return join(root, file);
}

describe("loadSecrets", () => {
	it("reads the per-clone file, then the user-level one, each source kind named and nothing resolved", async () => {
		const clone = secrets(
			repo,
			"melian.secrets.yaml",
			"credentials:",
			"  work-anthropic: { provider: anthropic, type: api_key, env: WORK_ANTHROPIC_KEY }",
			"  pinned: { provider: openai, key: sk-literal }",
		);
		const user = secrets(
			home,
			"secrets.yaml",
			"credentials:",
			'  vault-openai: { provider: openai, command: "op read op://dev/openai/key" }',
		);

		const loaded = await loadSecrets(repo, user);

		expect(loaded.warnings).toEqual([]);
		expect(loaded.credentials).toEqual([
			{
				name: "work-anthropic",
				provider: "anthropic",
				type: "api_key",
				value: { kind: "env", variable: "WORK_ANTHROPIC_KEY" },
				file: clone,
			},
			{
				name: "pinned",
				provider: "openai",
				type: "api_key",
				value: { kind: "literal", key: "sk-literal" },
				file: clone,
			},
			{
				name: "vault-openai",
				provider: "openai",
				type: "api_key",
				value: { kind: "command", command: "op read op://dev/openai/key" },
				file: user,
			},
		]);
	});

	it("holds nothing when neither file exists", async () => {
		expect(await loadSecrets(repo, join(home, "secrets.yaml"))).toEqual({ credentials: [], warnings: [] });
	});

	it("refuses a per-clone file git tracks, since a head could supply it", async () => {
		secrets(repo, "melian.secrets.yaml", "credentials:", "  a: { provider: openai, env: OPENAI_API_KEY }");
		gitIn(repo, "add", "--force", "melian.secrets.yaml");
		const error = await rejection(loadSecrets(repo));
		expect(error.code).toBe("tracked");
		expect(error.message).toContain("git rm --cached melian.secrets.yaml");
	});

	it("runs a command only from a file no one else can write", async () => {
		const user = secrets(home, "secrets.yaml", "credentials:", "  a: { provider: openai, command: cat key }");
		chmodSync(user, 0o620);
		const error = await rejection(loadSecrets(repo, user));
		expect(error).toMatchObject({ code: "notUserOwned", key: "credentials.a.command", file: user });
	});

	it("reads an environment or literal source from a file others can read, and warns", async () => {
		const user = secrets(home, "secrets.yaml", "credentials:", "  a: { provider: openai, env: OPENAI_API_KEY }");
		chmodSync(user, 0o644);
		const loaded = await loadSecrets(repo, user);
		expect(loaded.credentials).toHaveLength(1);
		expect(loaded.warnings).toEqual([`${user} is readable by others (mode 644); chmod 600 ${user}`]);
	});

	it.each([
		["no source", "  a: { provider: openai }"],
		["two sources", "  a: { provider: openai, env: A, key: b }"],
	])("refuses a credential with %s", async (_, entry) => {
		secrets(repo, "melian.secrets.yaml", "credentials:", entry);
		const error = await rejection(loadSecrets(repo));
		expect(error).toMatchObject({ code: "invalidValue", key: "credentials.a" });
		expect(error.message).toContain("exactly one of key, env, and command");
	});

	it("refuses an unknown key or a type other than api_key, naming the file", async () => {
		const file = secrets(repo, "melian.secrets.yaml", "credentials:", "  a: { provider: openai, env: A, pool: x }");
		expect(await rejection(loadSecrets(repo))).toMatchObject({ code: "unknownKey", file });
		secrets(repo, "melian.secrets.yaml", "credentials:", "  a: { provider: openai, type: oauth, env: A }");
		expect(await rejection(loadSecrets(repo))).toMatchObject({ code: "invalidValue", key: "credentials.a.type" });
	});

	it("never quotes a literal key in an error", async () => {
		secrets(repo, "melian.secrets.yaml", "credentials:", "  a: { provider: openai, key: sk-secret, env: A }");
		const error = await rejection(loadSecrets(repo));
		expect(error.message).not.toContain("sk-secret");
	});
});

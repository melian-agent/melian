import { chmodSync, chownSync, mkdirSync, symlinkSync } from "node:fs";
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

	it("refuses a per-clone file git tracks under another case of its name", async () => {
		secrets(repo, "melian.secrets.yaml", "credentials:", "  a: { provider: openai, command: cat key }");
		// The index holds the head's MELIAN.SECRETS.YAML, which a case-insensitive filesystem opens under the lower-case
		// name; the entry is made directly, so the test means the same on a case-sensitive one.
		const blob = gitIn(repo, "hash-object", "-w", "melian.secrets.yaml");
		gitIn(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},MELIAN.SECRETS.YAML`);
		const error = await rejection(loadSecrets(repo));
		expect(error.code).toBe("tracked");
		expect(error.message).toContain("git tracks MELIAN.SECRETS.YAML");
	});

	it("runs a per-clone command only when git ignores the file, and never when git cannot say", async () => {
		const command = ["credentials:", "  a: { provider: openai, command: cat key }"];
		secrets(repo, "melian.secrets.yaml", ...command);
		const unignored = await rejection(loadSecrets(repo));
		expect(unignored).toMatchObject({ code: "notIgnored", key: "credentials.a.command" });
		expect(unignored.message).toContain("git does not ignore melian.secrets.yaml");

		writeFiles(repo, { ".gitignore": lines("/melian.secrets.yaml") });
		expect((await loadSecrets(repo)).credentials).toHaveLength(1);

		const outside = temporaryDirectory();
		try {
			secrets(outside, "melian.secrets.yaml", ...command);
			const unknown = await rejection(loadSecrets(outside));
			expect(unknown.code).toBe("notIgnored");
			expect(unknown.message).toMatch(/git could not say whether it tracks melian\.secrets\.yaml \(exit \d+\)/);
			secrets(outside, "melian.secrets.yaml", "credentials:", "  a: { provider: openai, env: OPENAI_API_KEY }");
			expect((await loadSecrets(outside)).credentials).toHaveLength(1);
		} finally {
			removeDirectory(outside);
		}
	});

	it("runs a command only from a file no one else can write", async () => {
		const user = secrets(home, "secrets.yaml", "credentials:", "  a: { provider: openai, command: cat key }");
		chmodSync(user, 0o620);
		const error = await rejection(loadSecrets(repo, user));
		expect(error).toMatchObject({ code: "notUserOwned", key: "credentials.a.command", file: user });
	});

	it("never reads the per-clone file through a symlink, and follows the user's own", async () => {
		const target = secrets(home, "real.yaml", "credentials:", "  a: { provider: openai, env: OPENAI_API_KEY }");
		symlinkSync(target, join(repo, "melian.secrets.yaml"));
		symlinkSync(target, join(home, "secrets.yaml"));
		expect(await rejection(loadSecrets(repo))).toMatchObject({ code: "symlink" });
		removeDirectory(join(repo, "melian.secrets.yaml"));
		expect((await loadSecrets(repo, join(home, "secrets.yaml"))).credentials).toHaveLength(1);
	});

	it("refuses a command in a file others can read, as git leaves a file it checks out", async () => {
		writeFiles(repo, { ".gitignore": lines("/melian.secrets.yaml") });
		const file = secrets(repo, "melian.secrets.yaml", "credentials:", "  a: { provider: openai, command: cat key }");
		chmodSync(file, 0o644);
		const error = await rejection(loadSecrets(repo));
		expect(error).toMatchObject({ code: "notUserOwned", key: "credentials.a.command" });
		expect(error.message).toContain(`${file} has mode 644; chmod 600 ${file}`);
	});

	it("refuses a command in a file whose directory others can write, unless the directory is sticky", async () => {
		const shared = join(home, "shared");
		mkdirSync(shared);
		const file = secrets(shared, "secrets.yaml", "credentials:", "  a: { provider: openai, command: cat key }");
		chmodSync(shared, 0o777);
		const error = await rejection(loadSecrets(repo, file));
		expect(error.code).toBe("notUserOwned");
		expect(error.message).toContain(`others can replace files in ${shared}; chmod go-w ${shared}`);
		chmodSync(shared, 0o1777);
		expect((await loadSecrets(repo, file)).credentials).toHaveLength(1);
		chmodSync(shared, 0o700);
	});

	// Only root can give a file away, so elsewhere the owner check is left to the mode and directory cases above.
	it.skipIf(process.getuid?.() !== 0)("refuses a command in a file another user owns, advising chown", async () => {
		const file = secrets(home, "secrets.yaml", "credentials:", "  a: { provider: openai, command: cat key }");
		chownSync(file, 65534, 65534);
		const error = await rejection(loadSecrets(repo, file));
		expect(error.message).toContain(`another user owns ${file}; chown it to yourself`);
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

	it.each([
		["an unclosed flow mapping", "  a: { provider: openai, key: sk-SENTINEL-never-printed"],
		["a nested mapping", "  a: sk-SENTINEL-never-printed: x"],
	])("names only the code, line, and column of a YAML error in %s, never the line", async (_, entry) => {
		const file = secrets(repo, "melian.secrets.yaml", "credentials:", entry);
		const error = await rejection(loadSecrets(repo));
		expect(error).toMatchObject({ code: "invalidYaml", file });
		expect(error.message).toMatch(/: YAML error [A-Z_]+ at line \d+, column \d+$/);
		expect(error.message).not.toContain("SENTINEL");
		expect(error.cause).toBeUndefined();
	});

	it("never quotes a literal key in an error", async () => {
		secrets(repo, "melian.secrets.yaml", "credentials:", "  a: { provider: openai, key: sk-secret, env: A }");
		const error = await rejection(loadSecrets(repo));
		expect(error.message).not.toContain("sk-secret");
	});
});

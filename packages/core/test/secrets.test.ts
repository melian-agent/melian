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

	it("never runs a command from the per-clone file, ignored and mode 600 or not, and says where it belongs", async () => {
		writeFiles(repo, { ".gitignore": lines("/melian.secrets.yaml") });
		secrets(repo, "melian.secrets.yaml", "credentials:", "  a: { provider: openai, command: cat key }");
		const user = join(home, "secrets.yaml");
		const error = await rejection(loadSecrets(repo, user));
		expect(error).toMatchObject({ code: "cloneCommand", key: undefined });
		expect(error.message).toContain(
			`the credential at line 2, column 3 runs a command, which Melian runs only from your own secrets file, ${user}; move it there, or use key or env here`,
		);
	});

	it("reads the per-clone file when git cannot say whether it tracks it, since it holds no command", async () => {
		const outside = temporaryDirectory();
		try {
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
		expect(error).toMatchObject({ code: "notUserOwned", file: user });
	});

	it("never reads the per-clone file through a symlink, and follows the user's own", async () => {
		const target = secrets(home, "real.yaml", "credentials:", "  a: { provider: openai, env: OPENAI_API_KEY }");
		symlinkSync(target, join(repo, "melian.secrets.yaml"));
		symlinkSync(target, join(home, "secrets.yaml"));
		expect(await rejection(loadSecrets(repo))).toMatchObject({ code: "symlink" });
		removeDirectory(join(repo, "melian.secrets.yaml"));
		expect((await loadSecrets(repo, join(home, "secrets.yaml"))).credentials).toHaveLength(1);
	});

	it("refuses a command when the user-level file's directory is a symlink into the repository", async () => {
		secrets(repo, "config/secrets.yaml", "credentials:", "  a: { provider: openai, command: cat key }");
		const link = join(home, "melian");
		symlinkSync(join(repo, "config"), link);
		const error = await rejection(loadSecrets(repo, join(link, "secrets.yaml")));
		expect(error).toMatchObject({ code: "userFileInRepository", file: join(link, "secrets.yaml") });
		expect(error.message).toContain(`${link} is a symlink`);
	});

	it("refuses a command when the user-level file's real path lies inside the repository", async () => {
		const file = secrets(repo, "secrets.yaml", "credentials:", "  a: { provider: openai, command: cat key }");
		const error = await rejection(loadSecrets(repo, file));
		expect(error.code).toBe("userFileInRepository");
		expect(error.message).toContain("inside the repository under review");
	});

	it("accepts a command in a plain user-level file outside the repository", async () => {
		const file = secrets(home, "secrets.yaml", "credentials:", "  a: { provider: openai, command: cat key }");
		expect((await loadSecrets(repo, file)).credentials).toHaveLength(1);
	});

	it("refuses a command in a user-level file others can read", async () => {
		const file = secrets(home, "secrets.yaml", "credentials:", "  a: { provider: openai, command: cat key }");
		chmodSync(file, 0o644);
		const error = await rejection(loadSecrets(repo, file));
		expect(error.code).toBe("notUserOwned");
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
		expect(error).toMatchObject({ code: "invalidValue" });
		expect(error.message).toContain(
			"the credential at line 2, column 3 must take its value from exactly one of key, env, and command",
		);
	});

	it("refuses an unknown key or a type other than api_key, naming the file", async () => {
		const file = secrets(repo, "melian.secrets.yaml", "credentials:", "  a: { provider: openai, env: A, pool: x }");
		expect(await rejection(loadSecrets(repo))).toMatchObject({ code: "unknownKey", file });
		secrets(repo, "melian.secrets.yaml", "credentials:", "  a: { provider: openai, type: oauth, env: A }");
		const type = await rejection(loadSecrets(repo));
		expect(type).toMatchObject({ code: "invalidValue" });
		expect(type.message).toMatch(/an invalid value at line 2, column \d+$/);
	});

	// Every error the loader raises for a secrets file names the file, a code, and a position, and none of what is there:
	// a key may be a pasted secret, and a line missing its colon makes one key of a field and its value.
	it.each([
		["an unknown key, a field missing its colon", "unknownKey", ["  a: { provider: openai, key sk-SENTINEL }"]],
		["an unknown key, a secret as a field name", "unknownKey", ["  a: { provider: openai, sk-SENTINEL: x }"]],
		["a wrong type", "invalidValue", ["  a: { provider: [sk-SENTINEL], env: A }"]],
		["a missing field, under a secret as the credential's name", "invalidValue", ["  sk-SENTINEL: { env: A }"]],
		["a bad source type", "invalidValue", ["  a: { provider: openai, type: sk-SENTINEL, env: A }"]],
		["a credential with no source, named by a secret", "invalidValue", ["  sk-SENTINEL: { provider: openai }"]],
		["a reserved key", "reservedKey", ["  __proto__: { provider: sk-SENTINEL, env: A }"]],
		["a list where credentials belong", "invalidValue", ["  - sk-SENTINEL"]],
	])("names only the position of %s", async (_, code, entry) => {
		const file = secrets(repo, "melian.secrets.yaml", "credentials:", ...entry);
		const error = await rejection(loadSecrets(repo));
		expect(error).toMatchObject({ code, file, key: undefined });
		expect(error.message).toMatch(/ at line \d+, column \d+/);
		expect(`${error.message} ${String(error.cause ?? "")}`).not.toContain("SENTINEL");
	});

	it("names a credential a command source refuses by position, never by its name", async () => {
		const file = secrets(
			repo,
			"melian.secrets.yaml",
			"credentials:",
			"  sk-SENTINEL: { provider: openai, command: cat key }",
		);
		const error = await rejection(loadSecrets(repo));
		expect(error).toMatchObject({ code: "cloneCommand", file });
		expect(error.message).not.toContain("SENTINEL");
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

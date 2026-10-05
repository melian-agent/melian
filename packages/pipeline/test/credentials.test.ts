import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { NamedCredential } from "@melian-agent/core";
import {
	CredentialError,
	createReviewModels,
	MelianCredentialStore,
	PiCredentialStore,
	PiCredentialsError,
	piAuthPath,
	piCredentialStore,
	planInputs,
	unlockCredentials,
} from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelsOf } from "../src/models.ts";

let dir: string;
let authPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "melian-credentials-"));
	authPath = join(dir, "auth.json");
	vi.stubEnv("ANTHROPIC_API_KEY", undefined);
	vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", undefined);
	vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
	vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
	vi.stubEnv("OPENAI_API_KEY", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

function store(credentials: unknown): void {
	writeFileSync(authPath, JSON.stringify(credentials));
}

describe("piAuthPath", () => {
	it("follows PI_CODING_AGENT_DIR, expanding a leading tilde, and defaults to ~/.pi/agent", () => {
		expect(piAuthPath({})).toBe(join(homedir(), ".pi", "agent", "auth.json"));
		expect(piAuthPath({ PI_CODING_AGENT_DIR: "/srv/pi" })).toBe("/srv/pi/auth.json");
		expect(piAuthPath({ PI_CODING_AGENT_DIR: "~/agents/pi" })).toBe(join(homedir(), "agents", "pi", "auth.json"));
	});
});

describe("piCredentialStore", () => {
	it("reads what pi /login saved, afresh on every call", async () => {
		const credentials = piCredentialStore(authPath);
		expect(await credentials.read("anthropic")).toBeUndefined();
		store({ anthropic: { type: "api_key", key: "sk-ant-stored" } });
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "sk-ant-stored" });
		expect(await credentials.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
	});

	it("treats a key Pi would run or expand as absent", async () => {
		store({ anthropic: { type: "api_key", key: "!op read secret" }, openai: { type: "api_key", key: "$OPENAI" } });
		const credentials = piCredentialStore(authPath);
		expect(await credentials.read("anthropic")).toBeUndefined();
		expect(await credentials.read("openai")).toBeUndefined();
	});

	it("never writes", async () => {
		store({});
		const credentials = piCredentialStore(authPath);
		const error = await credentials
			.modify("anthropic", async () => ({ type: "api_key", key: "new" }))
			.catch((e) => e);
		expect(error).toBeInstanceOf(PiCredentialsError);
		expect(error).toMatchObject({ code: "readOnly", path: authPath });
		await expect(credentials.delete("anthropic")).rejects.toThrow(PiCredentialsError);
	});

	it("names the file when it is not a credential store", async () => {
		writeFileSync(authPath, "{not json");
		await expect(piCredentialStore(authPath).read("anthropic")).rejects.toMatchObject({ code: "invalid" });
		store({ anthropic: { type: "password", value: "x" } });
		await expect(piCredentialStore(authPath).read("anthropic")).rejects.toMatchObject({
			code: "invalid",
			path: authPath,
		});
	});
});

describe("createReviewModels", () => {
	it("authenticates a provider from Pi's store with no environment variable set", async () => {
		const models = modelsOf(createReviewModels({ authPath }));
		expect(await models.checkAuth("anthropic")).toBeUndefined();
		store({ anthropic: { type: "api_key", key: "sk-ant-stored" } });
		expect(await models.checkAuth("anthropic")).toMatchObject({ type: "api_key" });
	});

	it("falls back to the environment when the store has nothing for a provider", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-env");
		expect(await modelsOf(createReviewModels({ authPath })).checkAuth("openai")).toMatchObject({ type: "api_key" });
	});

	it("takes CLAUDE_CODE_OAUTH_TOKEN for an unset ANTHROPIC_OAUTH_TOKEN, ahead of ANTHROPIC_API_KEY", async () => {
		const apiKey = async () => (await modelsOf(createReviewModels({ authPath })).getAuth("anthropic"))?.auth.apiKey;
		vi.stubEnv("ANTHROPIC_API_KEY", "fake-api-key");
		expect(await apiKey()).toBe("fake-api-key");
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-claude-code-token");
		expect(await apiKey()).toBe("fake-claude-code-token");
		vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "fake-anthropic-token");
		expect(await apiKey()).toBe("fake-anthropic-token");
		store({ anthropic: { type: "api_key", key: "fake-stored-key" } });
		expect(await apiKey()).toBe("fake-stored-key");
	});

	it("treats an expired login as absent, so the environment or the next model applies", async () => {
		store({ anthropic: { type: "oauth", access: "old", refresh: "rotating", expires: 0 } });
		expect(await piCredentialStore(authPath).read("anthropic")).toBeUndefined();
		expect(await modelsOf(createReviewModels({ authPath })).checkAuth("anthropic")).toBeUndefined();
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
		expect(await modelsOf(createReviewModels({ authPath })).checkAuth("anthropic")).toMatchObject({
			type: "api_key",
		});
	});

	it("treats a login inside pi-ai's refresh window as absent, since using it would need a refresh", async () => {
		store({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 4 * 60_000 } });
		expect(await piCredentialStore(authPath).read("anthropic")).toBeUndefined();
		expect(await modelsOf(createReviewModels({ authPath })).checkAuth("anthropic")).toBeUndefined();
		store({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 6 * 60_000 } });
		expect(await piCredentialStore(authPath).read("anthropic")).toBeUndefined();
	});

	it("serves a login that has not expired", async () => {
		const live = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
		store({ anthropic: live });
		expect(await piCredentialStore(authPath).read("anthropic")).toEqual(live);
	});

	it("keeps the credential file's text out of a parse error", async () => {
		writeFileSync(authPath, '{"anthropic": {"type": "api_key", "key": "sk-ant-secret" oops}}');
		const error = (await piCredentialStore(authPath)
			.read("anthropic")
			.catch((e: unknown) => e)) as Error;
		expect(error).toBeInstanceOf(PiCredentialsError);
		expect(JSON.stringify({ message: error.message, cause: String(error.cause) })).not.toContain("sk-ant");
	});
});

describe("MelianCredentialStore", () => {
	const named = (
		name: string,
		provider: string,
		value: NamedCredential["value"],
		file = "/home/me/.config/melian/secrets.yaml",
	): NamedCredential => ({ name, provider, type: "api_key", value, file });

	it("reads a named credential before Pi's store, and Pi's store when the named one's variable is unset", async () => {
		store({ anthropic: { type: "api_key", key: "sk-ant-stored" } });
		const credentials = new MelianCredentialStore(
			[named("work", "anthropic", { kind: "env", variable: "WORK_ANTHROPIC_KEY" })],
			new PiCredentialStore(authPath),
			{},
		);
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "sk-ant-stored" });
		expect(await credentials.describe("anthropic")).toBe(`Pi's login in ${authPath}`);

		const set = new MelianCredentialStore(credentials.named, new PiCredentialStore(authPath), {
			WORK_ANTHROPIC_KEY: "sk-ant-work",
		});
		expect(await set.read("anthropic")).toEqual({ type: "api_key", key: "sk-ant-work" });
		expect(await set.describe("anthropic")).toBe("work in /home/me/.config/melian/secrets.yaml");
		expect(await set.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
	});

	it("takes the first named credential of a provider that is present, in file order", async () => {
		const credentials = new MelianCredentialStore(
			[
				named("unset", "openai", { kind: "env", variable: "UNSET_KEY" }),
				named("pinned", "openai", { kind: "literal", key: "sk-literal" }),
			],
			new PiCredentialStore(authPath),
			{},
		);
		expect(await credentials.read("openai")).toEqual({ type: "api_key", key: "sk-literal" });
	});

	it("runs a command source once, at first use, and never when only asked where a credential comes from", async () => {
		const counter = join(dir, "runs");
		const credentials = new MelianCredentialStore(
			[named("vault", "openai", { kind: "command", command: `echo run >> ${counter}; printf ' sk-from-vault\\n'` })],
			new PiCredentialStore(authPath),
			{},
		);
		expect(await credentials.describe("openai")).toBe("vault in /home/me/.config/melian/secrets.yaml");
		expect(existsSync(counter)).toBe(false);
		expect(await credentials.read("openai")).toEqual({ type: "api_key", key: "sk-from-vault" });
		expect(await credentials.read("openai")).toEqual({ type: "api_key", key: "sk-from-vault" });
		expect(readFileSync(counter, "utf8")).toBe("run\n");
	});

	it("names the credential and its file when a command fails or prints nothing, and never what it printed", async () => {
		const failing = new MelianCredentialStore(
			[
				named(
					"vault",
					"openai",
					{ kind: "command", command: "echo sk-leaked; exit 3" },
					"/clone/melian.secrets.yaml",
				),
			],
			new PiCredentialStore(authPath),
			{},
		);
		const error = await failing.read("openai").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CredentialError);
		expect(error).toMatchObject({ code: "commandFailed", credential: "vault", file: "/clone/melian.secrets.yaml" });
		expect((error as Error).message).toBe("credential vault in /clone/melian.secrets.yaml: its command failed (3)");
		const empty = new MelianCredentialStore(
			[named("vault", "openai", { kind: "command", command: "true" })],
			new PiCredentialStore(authPath),
			{},
		);
		expect(await empty.read("openai").catch((e: unknown) => e)).toMatchObject({ code: "noValue" });
	});

	it("says a command that prints more than any key would is too large, not slow", async () => {
		const credentials = new MelianCredentialStore(
			[
				named(
					"vault",
					"openai",
					{ kind: "command", command: "head -c 100000 /dev/zero" },
					"/clone/melian.secrets.yaml",
				),
			],
			new PiCredentialStore(authPath),
			{},
		);
		const error = await credentials.read("openai").catch((e: unknown) => e);
		expect((error as Error).message).toBe(
			"credential vault in /clone/melian.secrets.yaml: its command printed more than 64 KiB",
		);
	});

	it("refuses a named credential for a provider the catalogue does not know", () => {
		expect(() =>
			createReviewModels({ authPath, credentials: [named("typo", "antropic", { kind: "literal", key: "k" })] }),
		).toThrow(
			expect.objectContaining({
				code: "unknownProvider",
				message:
					"credential typo in /home/me/.config/melian/secrets.yaml names the provider antropic, which Melian's model catalogue does not know",
			}),
		);
	});

	it("resolves a review's models from a named credential before the provider's environment variable", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-env");
		const models = createReviewModels({
			authPath,
			credentials: [named("pinned", "openai", { kind: "literal", key: "sk-named" })],
		});
		const { credentials } = await planInputs(models);
		expect(credentials.openai).toBe("pinned in /home/me/.config/melian/secrets.yaml");
		expect(await modelsOf(models).getAuth("openai")).toMatchObject({ auth: { apiKey: "sk-named" } });
		await unlockCredentials(models, ["openai", "anthropic"]);
	});

	it("names an environment variable pi-ai found as the source, and lists catalogue models", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-env");
		const { catalogue, credentials } = await planInputs(createReviewModels({ authPath }));
		expect(credentials.openai).toBe("OPENAI_API_KEY");
		expect(credentials.anthropic).toBeUndefined();
		expect(catalogue.find((model) => model.provider === "openai" && model.id === "gpt-5.5")).toMatchObject({
			name: "GPT-5.5",
			reasoning: true,
		});
	});
});

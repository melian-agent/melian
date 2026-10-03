import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewModels, PiCredentialsError, piAuthPath, piCredentialStore } from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let authPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "melian-credentials-"));
	authPath = join(dir, "auth.json");
	vi.stubEnv("ANTHROPIC_API_KEY", undefined);
	vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", undefined);
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
		const models = createReviewModels({ authPath });
		expect(await models.checkAuth("anthropic")).toBeUndefined();
		store({ anthropic: { type: "api_key", key: "sk-ant-stored" } });
		expect(await models.checkAuth("anthropic")).toMatchObject({ type: "api_key" });
	});

	it("falls back to the environment when the store has nothing for a provider", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-env");
		expect(await createReviewModels({ authPath }).checkAuth("openai")).toMatchObject({ type: "api_key" });
	});

	it("asks for Pi to be run rather than refreshing an expired login", async () => {
		store({ anthropic: { type: "oauth", access: "old", refresh: "rotating", expires: 0 } });
		const error = await createReviewModels({ authPath })
			.getAuth("anthropic")
			.catch((e: unknown) => e);
		expect(String((error as Error).message)).toContain("run pi to refresh the anthropic login");
	});
});

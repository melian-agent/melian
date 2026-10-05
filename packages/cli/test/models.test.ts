import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type LoadedConfig, type MelianConfig, userFiles } from "@melian-agent/core";
import { buildGoldenRepository, loadGoldens } from "@melian-agent/evals";
import * as pipeline from "@melian-agent/pipeline";
import { createFakeModels, type FakeModels } from "@melian-agent/pipeline/testing";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/main.ts";
import { reviewModels } from "../src/models.ts";
import * as repository from "../src/repository.ts";

const models: MelianConfig["models"] = {
	light: { model: "anthropic/claude-sonnet-5-5" },
	heavy: { model: "anthropic/claude-opus-5-5", fallbacks: ["openai/gpt"] },
	verifier: { model: "openai/gpt-5.5" },
};
const routed: LoadedConfig = {
	config: { ...defaultConfig, models },
	sources: ["melian.yaml"],
	routes: { committed: models, overridden: {}, lensTiers: {}, retiered: {} },
};
const setup = { checks: ["lens.correctness"], credentials: [] };

describe("--model", () => {
	it("routes every lens tier to the model named, over the routes melian.yaml sets and their fallbacks", async () => {
		const { plan } = await reviewModels({}, routed, [], { ...setup, model: "amazon-bedrock/claude-opus" });
		expect(plan.routes()).toMatchObject({
			light: { model: "amazon-bedrock/claude-opus", fallbacks: [] },
			medium: { model: "amazon-bedrock/claude-opus", fallbacks: [] },
			heavy: { model: "amazon-bedrock/claude-opus", fallbacks: [] },
		});
		expect(plan.tier("heavy").by).toBe("--model");
		expect(plan.tier("verifier").by).not.toBe("--model");
	});

	// Which credentials this machine holds decides where heavy lands, so the test asks only what the flag decides.
	it("leaves the routes to the plan when absent", async () => {
		const { plan } = await reviewModels({}, routed, [], setup);
		expect(plan.tier("heavy").wanted).toBe("anthropic/claude-opus-5-5");
		expect(plan.tier("heavy").by).not.toBe("--model");
	});
});

describe("userFiles", () => {
	it("keeps the user's own files in XDG_CONFIG_HOME/melian, or ~/.config/melian", () => {
		expect(userFiles({ XDG_CONFIG_HOME: "/xdg" })).toEqual({
			config: "/xdg/melian/config.yaml",
			secrets: "/xdg/melian/secrets.yaml",
		});
		expect(userFiles({}).config).toBe(join(homedir(), ".config", "melian", "config.yaml"));
	});
});

describe("command bearer validation", () => {
	it("fails review before opening storage or calling a model when a command bearer expired, despite a usable Pi login", async () => {
		const golden = loadGoldens().find((entry) => entry.name === "clean-rename")!;
		const { repo } = buildGoldenRepository(golden);
		const xdg = mkdtempSync(join(tmpdir(), "melian-bearer-xdg-"));
		let fake: FakeModels | undefined;
		const opened = vi.spyOn(repository, "openStorage");
		try {
			const file = join(xdg, "melian", "secrets.yaml");
			const marker = join(xdg, "ran");
			const token = `e30.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
			mkdirSync(join(xdg, "melian"));
			writeFileSync(
				file,
				`credentials:\n  login: { provider: fake-oauth, command: "echo run >> ${marker}; printf '${token}'" }\n`,
				{ mode: 0o600 },
			);
			writeFileSync(join(repo, "melian.yaml"), "models:\n  heavy:\n    model: fake-oauth/heavy\n");
			const authPath = join(xdg, "auth.json");
			writeFileSync(
				authPath,
				JSON.stringify({
					"fake-oauth": {
						type: "oauth",
						access: "pi-token",
						refresh: "pi-refresh",
						expires: Date.now() + 3_600_000,
					},
				}),
			);
			vi.spyOn(pipeline, "createReviewModels").mockImplementation((options) => {
				fake = createFakeModels({
					provider: "fake-oauth",
					auth: "oauth",
					models: [{ id: "heavy" }],
					credentials: options?.credentials ?? [],
					authPath,
				});
				return fake.review;
			});
			const stdout = vi.fn();
			const stderr = vi.fn();
			const status = await main(["review", "main"], {
				cwd: repo,
				env: { XDG_CONFIG_HOME: xdg },
				color: false,
				stdout,
				stderr,
			});
			expect(status).toBe(2);
			expect(stderr).toHaveBeenCalledWith(
				`melian: credential login in ${file}: its token has expired; refresh it with the tool that owns it\n`,
			);
			expect(stdout).not.toHaveBeenCalled();
			expect(existsSync(marker)).toBe(true);
			expect(opened).not.toHaveBeenCalled();
			expect(fake!.provider.state.callCount).toBe(0);
		} finally {
			vi.restoreAllMocks();
			rmSync(repo, { recursive: true, force: true });
			rmSync(xdg, { recursive: true, force: true });
		}
	});
});

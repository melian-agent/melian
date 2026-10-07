import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Decider, defaultConfig, Lens, type LoadedConfig, type MelianConfig, userFiles } from "@melian-agent/core";
import { buildGoldenRepository, loadGoldens } from "@melian-agent/evals";
import * as pipeline from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.ts";
import { decisionProviderRefusal, fallbackDecider, reviewModels, Triage, triageProviders } from "../src/models.ts";
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

// A configuration as the loader returns it, every route committed.
function loadedOf(models: MelianConfig["models"]): LoadedConfig {
	return {
		config: { ...defaultConfig, models },
		sources: ["melian.yaml"],
		routes: { committed: models, overridden: {}, lensTiers: {}, retiered: {} },
	};
}

describe("reviewModels triage", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("triages on the plan's routes, which --model rewrites", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent-melian-test");
		vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

		const { models: collection, plan } = await reviewModels({}, loadedOf({}), [], {
			...setup,
			model: "anthropic/claude-sonnet-4-5",
		});
		const triage = await fallbackDecider({ ...defaultConfig, models: plan.routes() }, collection);

		expect(triage).toMatchObject({ model: "anthropic/claude-sonnet-4-5" });
	});
});

describe("decisionProviderRefusal", () => {
	it("prints the provider's control characters as visible text", () => {
		const config = {
			...defaultConfig,
			decisions: { ...defaultConfig.decisions, provider: "evil\u001b[31m\nforged" },
		};

		const refusal = decisionProviderRefusal(config);

		expect(refusal).toContain("decisions.provider to evil\\u001b[31m\\u000aforged,");
		expect(refusal).not.toMatch(/[\u001b\n]/);
	});
});

describe("triageProviders", () => {
	it("names the providers of every routed lens tier, which the fallback may ask", async () => {
		const routedTiers = loadedOf({
			light: { model: "openai/gpt-5.5" },
			heavy: { model: "anthropic/claude-opus-5-5" },
		});
		const { plan } = await reviewModels({}, routedTiers, [], {
			...setup,
			credentials: [
				{ name: "o", provider: "openai", type: "api_key", value: { kind: "literal", key: "sk-o" }, file: "f" },
				{
					name: "a",
					provider: "anthropic",
					type: "api_key",
					value: { kind: "literal", key: "sk-a" },
					file: "f",
				},
			],
		});
		expect(triageProviders(plan)).toEqual(["openai", "anthropic"]);
	});
});

describe("the triage model", () => {
	const fake = createFakeModels({ models: [{ id: "light" }, { id: "medium" }, { id: "heavy" }] });
	const route = (id: string) => ({ model: `${fake.ref(id).provider}/${id}` });
	const choose = (models: MelianConfig["models"]) => fallbackDecider({ ...defaultConfig, models }, fake.review);

	it("triages on the cheapest routed tier with credentials, passing over unrouted and uncredentialed ones", async () => {
		const model = (id: string) => `${fake.ref(id).provider}/${id}`;
		const all = { light: route("light"), medium: route("medium"), heavy: route("heavy") };
		expect(await choose(all)).toMatchObject({ model: model("light") });
		expect(await choose({ medium: route("medium"), heavy: route("heavy") })).toMatchObject({
			model: model("medium"),
		});
		// A model the collection does not know is passed over, as one it knows without credentials is.
		expect(await choose({ light: { model: "nowhere/light" }, heavy: route("heavy") })).toMatchObject({
			model: model("heavy"),
		});
		const locked = fake.withoutCredentials("locked-light");
		expect(
			await choose({ light: { model: `${locked.provider}/${locked.modelId}` }, heavy: route("heavy") }),
		).toMatchObject({
			model: model("heavy"),
		});
	});

	it("passes over a tier whose route cannot be read, rather than stop the review", async () => {
		const chosen = await choose({ light: { model: "claude-haiku" }, medium: route("medium") });
		expect(chosen).toMatchObject({ model: `${fake.ref("medium").provider}/medium` });
	});

	it("passes over a tier whose provider has no named credential when Pi's store is corrupt, for one that has", async () => {
		const dir = mkdtempSync(join(tmpdir(), "melian-corrupt-store-"));
		try {
			const authPath = join(dir, "auth.json");
			writeFileSync(authPath, "{");
			const named = createFakeModels({
				provider: "fake-key",
				models: [{ id: "heavy" }],
				credentials: [
					{
						name: "vault",
						provider: "fake-key",
						type: "api_key",
						value: { kind: "literal", key: "k" },
						file: "f",
					},
				],
				authPath,
			});
			const locked = named.withoutCredentials("locked-light");
			const chosen = await fallbackDecider(
				{
					...defaultConfig,
					models: {
						light: { model: `${locked.provider}/${locked.modelId}` },
						heavy: { model: `${named.ref("heavy").provider}/heavy` },
					},
				},
				named.review,
			);
			expect(chosen).toMatchObject({ model: `${named.ref("heavy").provider}/heavy` });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("says why no decider runs when no tier reaches a model", async () => {
		const chosen = await choose({ light: { model: "claude-haiku" }, medium: { model: "nowhere/medium" } });
		expect(chosen).toEqual({
			skipped:
				'no lens tier reaches a model for the LLM fallback: models.light: "claude-haiku" is not provider/model-id; no model of medium has credentials; heavy is not routed',
		});
	});
});

describe("Triage", () => {
	const decider: Decider = { name: "fake", calibrated: false, decide: async () => ({ answers: [] }) };
	let dir: string | undefined;
	afterEach(() => {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	async function opened(options: { scripted: boolean; decide: typeof fallbackDecider }) {
		dir = mkdtempSync(join(tmpdir(), "melian-triage-"));
		const marker = join(dir, "unlocked");
		const lensMarker = join(dir, "lens-unlocked");
		const loaded = loadedOf({
			light: { model: "openai/gpt-5.5" },
			heavy: { model: "anthropic/claude-opus-5-5" },
		});
		const lenses = (await Lens.load(process.cwd(), { kind: "worktree" }, ["src/user.ts"])).filter(
			(lens) => lens.name === "correctness",
		);
		const { models, plan } = await reviewModels({}, loaded, lenses, {
			...setup,
			credentials: [
				{
					name: "vault",
					provider: "openai",
					type: "api_key",
					value: { kind: "command", command: `touch ${marker}; echo sk-key` },
					file: "f",
				},
				{
					name: "lens-vault",
					provider: "anthropic",
					type: "api_key",
					value: { kind: "command", command: `touch ${lensMarker}; echo sk-key` },
					file: "f",
				},
			],
		});
		const triage = await Triage.create({ ...options, config: loaded.config, plan, models });
		return { triage, marker, lensMarker, plan };
	}

	it("hands the decider to the harness and the review, and unlocks the providers triage may ask on demand", async () => {
		const configs: MelianConfig[] = [];
		const { triage, marker, plan } = await opened({
			scripted: false,
			decide: async (config) => {
				configs.push(config);
				return { decider, model: "fake" };
			},
		});

		expect(triage.harnessOptions()).toEqual({ decider });
		expect(triage.reviewOptions()).toEqual({ decider, unlockModels: expect.any(Function) });
		expect(existsSync(marker)).toBe(false);
		await triage.reviewOptions().unlockModels();
		expect(existsSync(marker)).toBe(true);
		expect(configs[0]!.models).toEqual(plan.routes());
	});

	it("runs the providers' commands once, however often a review and its walkthrough unlock", async () => {
		const { triage, marker } = await opened({ scripted: false, decide: async () => ({ decider, model: "fake" }) });

		const first = triage.unlockModels();
		expect(triage.unlockModels()).toBe(first);
		await first;
		expect(existsSync(marker)).toBe(true);
	});

	it("says why triage did not run to the review, and gives the harness no decider", async () => {
		const { triage } = await opened({ scripted: false, decide: async () => ({ skipped: "no model" }) });

		expect(triage.harnessOptions()).toEqual({});
		expect(triage.reviewOptions()).toEqual({ triageSkipped: "no model", unlockModels: expect.any(Function) });
	});

	it("triages nothing and unlocks the lens and verifier providers under a script", async () => {
		const decide = vi.fn(async () => ({ decider, model: "fake" }));
		const { triage, marker, lensMarker, plan } = await opened({ scripted: true, decide });

		expect(plan.lenses).toHaveLength(1);
		expect(plan.providers()).toEqual(["anthropic", "openai"]);
		expect(triage.harnessOptions()).toEqual({});
		expect(triage.reviewOptions()).toEqual({ unlockModels: expect.any(Function) });
		expect(existsSync(lensMarker)).toBe(false);
		expect(existsSync(marker)).toBe(false);
		await triage.unlockModels();
		expect(existsSync(lensMarker)).toBe(true);
		expect(existsSync(marker)).toBe(true);
		expect(decide).not.toHaveBeenCalled();
	});
});

describe("command bearer validation", { timeout: 60_000 }, () => {
	it.each(["disabled", "no paths"])("accepts a script naming a lens with %s", async (skipped) => {
		const golden = loadGoldens().find((entry) => entry.name === "clean-rename")!;
		const { repo } = buildGoldenRepository(golden);
		const xdg = mkdtempSync(join(tmpdir(), "melian-script-lenses-"));
		try {
			const script = join(xdg, "script.json");
			writeFileSync(script, JSON.stringify({ correctness: [{ text: "Done." }] }));
			writeFileSync(
				join(repo, "melian.yaml"),
				`tiers:\n  full: [guardrails, lens.correctness]\nchecks:\n  allowSkip: [lens.correctness]\nlenses:\n  correctness: ${skipped === "disabled" ? "{ enabled: false }" : '{ paths: ["never/**"] }'}\n`,
			);
			const stdout = vi.fn();
			const stderr = vi.fn();
			const status = await main(["review", "main"], {
				cwd: repo,
				env: { XDG_CONFIG_HOME: xdg, MELIAN_STATE_DIR: xdg, MELIAN_TEST_SCRIPT: script },
				color: false,
				stdout,
				stderr,
			});
			expect(status, stderr.mock.calls.flat().join("")).toBe(0);
			expect(stdout.mock.calls.flat().join("")).toContain("passed");
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(xdg, { recursive: true, force: true });
		}
	});

	it.each(["disabled", "no paths"])(
		"reviews with every lens %s without unlocking a failing credential",
		async (skipped) => {
			const golden = loadGoldens().find((entry) => entry.name === "clean-rename")!;
			const { repo } = buildGoldenRepository(golden);
			const xdg = mkdtempSync(join(tmpdir(), "melian-no-lenses-"));
			let fake: FakeModels | undefined;
			try {
				const marker = join(xdg, "ran");
				mkdirSync(join(xdg, "melian"));
				writeFileSync(
					join(xdg, "melian", "secrets.yaml"),
					`credentials:\n  vault: { provider: fake-idle, command: "touch ${marker}; exit 1" }\n`,
					{ mode: 0o600 },
				);
				writeFileSync(
					join(repo, "melian.yaml"),
					`models:\n  heavy: { model: fake-idle/heavy }\ntiers:\n  full: [guardrails, lens.correctness]\nchecks:\n  allowSkip: [lens.correctness]\nlenses:\n  correctness: ${skipped === "disabled" ? "{ enabled: false }" : '{ paths: ["never/**"] }'}\n`,
				);
				vi.spyOn(pipeline, "createReviewModels").mockImplementation((options) => {
					fake = createFakeModels({
						provider: "fake-idle",
						models: [{ id: "heavy" }],
						credentials: options?.credentials ?? [],
					});
					return fake.review;
				});
				const stdout = vi.fn();
				const stderr = vi.fn();
				const status = await main(["review", "main"], {
					cwd: repo,
					env: { XDG_CONFIG_HOME: xdg, MELIAN_STATE_DIR: xdg },
					color: false,
					stdout,
					stderr,
				});
				expect(status, stderr.mock.calls.flat().join("")).toBe(0);
				expect(existsSync(marker)).toBe(false);
				expect(fake!.provider.state.callCount).toBe(0);
				expect(stdout).toHaveBeenCalled();
			} finally {
				vi.restoreAllMocks();
				rmSync(repo, { recursive: true, force: true });
				rmSync(xdg, { recursive: true, force: true });
			}
		},
	);

	it("runs a command credential for a review that asks a model, and not for a repeat that asks none", async () => {
		const golden = loadGoldens().find((entry) => entry.name === "clean-rename")!;
		const { repo } = buildGoldenRepository(golden);
		const xdg = mkdtempSync(join(tmpdir(), "melian-repeat-"));
		const fakes: FakeModels[] = [];
		try {
			const marker = join(xdg, "ran");
			mkdirSync(join(xdg, "melian"));
			writeFileSync(
				join(xdg, "melian", "secrets.yaml"),
				`credentials:\n  vault: { provider: fake-repeat, command: "echo run >> ${marker}; echo sk-key" }\n`,
				{ mode: 0o600 },
			);
			writeFileSync(
				join(repo, "melian.yaml"),
				`models:\n  heavy: { model: fake-repeat/heavy }\ntiers:\n  full: [guardrails, lens.correctness]\nchecks:\n  allowSkip: [lens.correctness]\n`,
			);
			vi.spyOn(pipeline, "createReviewModels").mockImplementation((options) => {
				const fake = createFakeModels({
					provider: "fake-repeat",
					models: [{ id: "heavy" }],
					credentials: options?.credentials ?? [],
				});
				scriptConversations(fake, [
					{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
				]);
				fakes.push(fake);
				return fake.review;
			});
			const review = async () => {
				const stderr = vi.fn();
				const status = await main(["review", "main"], {
					cwd: repo,
					env: { XDG_CONFIG_HOME: xdg, MELIAN_STATE_DIR: xdg },
					color: false,
					stdout: vi.fn(),
					stderr,
					decide: async () => ({ skipped: "not under test" }),
				});
				expect(status, stderr.mock.calls.flat().join("")).toBe(0);
			};

			await review();
			expect(fakes[0]!.provider.state.callCount).toBeGreaterThan(0);
			expect(readFileSync(marker, "utf8")).toBe("run\n");

			await review();
			expect(fakes[1]!.provider.state.callCount).toBe(0);
			expect(readFileSync(marker, "utf8")).toBe("run\n");
		} finally {
			vi.restoreAllMocks();
			rmSync(repo, { recursive: true, force: true });
			rmSync(xdg, { recursive: true, force: true });
		}
	});

	it.each([
		["a crashed task would resume", true],
		["no task would resume", false],
	])("runs a command credential before the checks run only when %s", async (_, resumes) => {
		const golden = loadGoldens().find((entry) => entry.name === "clean-rename")!;
		const { repo } = buildGoldenRepository(golden);
		const xdg = mkdtempSync(join(tmpdir(), "melian-resume-"));
		try {
			const marker = join(xdg, "ran");
			mkdirSync(join(xdg, "melian"));
			writeFileSync(
				join(xdg, "melian", "secrets.yaml"),
				`credentials:\n  vault: { provider: fake-resume, command: "echo run >> ${marker}; echo sk-key" }\n`,
				{ mode: 0o600 },
			);
			writeFileSync(
				join(repo, "melian.yaml"),
				`models:\n  heavy: { model: fake-resume/heavy }\ntiers:\n  full: [guardrails, lens.correctness]\nchecks:\n  allowSkip: [lens.correctness]\n`,
			);
			vi.spyOn(pipeline, "createReviewModels").mockImplementation((options) => {
				const fake = createFakeModels({
					provider: "fake-resume",
					models: [{ id: "heavy" }],
					credentials: options?.credentials ?? [],
				});
				scriptConversations(fake, [
					{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
				]);
				return fake.review;
			});
			if (resumes) vi.spyOn(pipeline.ReviewHarness.prototype, "resumesModels").mockResolvedValue(true);
			const ranBeforeChecks: boolean[] = [];
			const runChecks = pipeline.runChecks;
			vi.spyOn(pipeline, "runChecks").mockImplementation((...args) => {
				ranBeforeChecks.push(existsSync(marker));
				return runChecks(...args);
			});
			const stderr = vi.fn();
			const status = await main(["review", "main"], {
				cwd: repo,
				env: { XDG_CONFIG_HOME: xdg, MELIAN_STATE_DIR: xdg },
				color: false,
				stdout: vi.fn(),
				stderr,
				decide: async () => ({ skipped: "not under test" }),
			});

			expect(status, stderr.mock.calls.flat().join("")).toBe(0);
			expect(ranBeforeChecks).toEqual([resumes]);
			expect(readFileSync(marker, "utf8")).toBe("run\n");
		} finally {
			vi.restoreAllMocks();
			rmSync(repo, { recursive: true, force: true });
			rmSync(xdg, { recursive: true, force: true });
		}
	});

	it("fails review before calling a model when a command bearer expired, despite a usable Pi login", async () => {
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
			expect(opened).toHaveBeenCalled();
			expect(fake!.provider.state.callCount).toBe(0);
		} finally {
			vi.restoreAllMocks();
			rmSync(repo, { recursive: true, force: true });
			rmSync(xdg, { recursive: true, force: true });
		}
	});
});

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, defaultConfig, loadConfig, OutsideRepositoryError } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lines, rejection as rejectionOf, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

let repo: string;

beforeEach(() => {
	repo = temporaryDirectory();
});

afterEach(() => {
	removeDirectory(repo);
});

const rejection = (promise: Promise<unknown>) => rejectionOf(promise, ConfigError);

describe("loadConfig", () => {
	it("returns the design's defaults when no melian.yaml exists", async () => {
		const loaded = await loadConfig(repo, "src/index.ts");
		expect(loaded).toEqual({ config: defaultConfig, sources: [] });
		expect(loaded.config.stages).toEqual({
			"pre-commit": "fast",
			"pre-push": "standard",
			"pull-request": "full",
			comment: "standard",
		});
		expect(loaded.config.resolution).toEqual({
			P0: "block",
			P1: "block",
			P2: "acknowledge",
			P3: "advisory",
			nit: "silent",
		});
	});

	// The precedence example in docs/guidelines/core.md.
	describe("with a root file and a service file", () => {
		beforeEach(() => {
			writeFiles(repo, {
				"melian.yaml": lines(
					"resolution:",
					"  P2: block",
					"lenses:",
					"  security:",
					"    tier: medium",
					"    paths: [src/**]",
					"models:",
					"  heavy:",
					"    model: anthropic/opus",
					"    fallbacks: [openai/gpt]",
				),
				"services/payments/melian.yaml": lines(
					"resolution:",
					"  P3: block",
					"lenses:",
					"  security:",
					"    tier: heavy",
					"    paths: [api/**, /webhooks/**]",
					"models:",
					"  heavy:",
					"    model: anthropic/sonnet",
				),
			});
		});

		it("lets the nearest file win per key, merging objects and replacing arrays", async () => {
			const { config, sources } = await loadConfig(repo, "services/payments/api/charge.ts");

			expect(sources).toEqual([join(repo, "services/payments/melian.yaml"), join(repo, "melian.yaml")]);
			expect(config.resolution).toEqual({ P0: "block", P1: "block", P2: "block", P3: "block", nit: "silent" });
			expect(config.lenses).toEqual({
				security: { tier: "heavy", paths: ["services/payments/api/**", "services/payments/webhooks/**"] },
			});
			expect(config.models).toEqual({ heavy: { model: "anthropic/sonnet", fallbacks: ["openai/gpt"] } });
			expect(config.stages).toEqual(defaultConfig.stages);
		});

		it("applies only the root file outside the service", async () => {
			const { config, sources } = await loadConfig(repo, "docs/readme.md");

			expect(sources).toEqual([join(repo, "melian.yaml")]);
			expect(config.resolution.P3).toBe("advisory");
			expect(config.lenses).toEqual({ security: { tier: "medium", paths: ["src/**"] } });
		});

		it("treats a directory path as the directory itself", async () => {
			const { sources } = await loadConfig(repo, join(repo, "services/payments"));
			expect(sources).toHaveLength(2);
		});
	});

	it("anchors lens paths at their file, keeping negations and dropping a leading slash", async () => {
		writeFiles(repo, {
			"melian.yaml": lines("lenses:", "  security:", "    paths: [/src/**, '!src/generated/**']"),
			"services/melian.yaml": lines("lenses:", "  contracts:", "    paths: [/api/**, '!api/generated/**']"),
		});
		const { config } = await loadConfig(repo, "services/a.ts");
		expect(config.lenses).toEqual({
			security: { paths: ["src/**", "!src/generated/**"] },
			contracts: { paths: ["services/api/**", "!services/api/generated/**"] },
		});
	});

	it("names a melian.yaml it cannot read", async () => {
		mkdirSync(join(repo, "melian.yaml"));
		expect(await rejection(loadConfig(repo, "a.ts"))).toMatchObject({
			code: "unreadable",
			file: join(repo, "melian.yaml"),
		});
	});

	it("replaces a tier's checks rather than appending to them", async () => {
		writeFiles(repo, { "melian.yaml": lines("tiers:", "  fast: [guardrails]") });
		const { config } = await loadConfig(repo, "a.ts");
		expect(config.tiers).toEqual({ ...defaultConfig.tiers, fast: ["guardrails"] });
	});

	it("reads an empty file as contributing nothing", async () => {
		writeFiles(repo, { "melian.yaml": "" });
		const { config, sources } = await loadConfig(repo, "a.ts");
		expect(config).toEqual(defaultConfig);
		expect(sources).toEqual([join(repo, "melian.yaml")]);
	});

	it.each([
		["tier: fast", "tier"],
		["resolution:\n  P4: block", "resolution.P4"],
		["lenses:\n  security:\n    enable: true", "lenses.security.enable"],
		["models:\n  heavy:\n    model: a\n    fallback: [b]", "models.heavy.fallback"],
	])("rejects an unknown key in %j, naming it and the file", async (yaml, key) => {
		writeFiles(repo, { "services/melian.yaml": yaml });
		const error = await rejection(loadConfig(repo, "services/a.ts"));
		expect(error).toMatchObject({ code: "unknownKey", key, file: join(repo, "services/melian.yaml") });
		expect(error.message).toContain(key);
	});

	it("rejects a value outside its set, listing the allowed values", async () => {
		writeFiles(repo, { "melian.yaml": lines("resolution:", "  P0: blocker") });
		const error = await rejection(loadConfig(repo, "a.ts"));
		expect(error).toMatchObject({ code: "invalidValue", key: "resolution.P0" });
		expect(error.message).toContain("block, acknowledge, advisory, silent");
	});

	it.each([
		["tiers: [", "unclosed flow sequence"],
		["knowledge:\n  writeBack: true\nknowledge:\n  writeBack: false", "duplicate key"],
	])("rejects invalid YAML: %j (%s)", async (yaml) => {
		writeFiles(repo, { "melian.yaml": yaml });
		expect(await rejection(loadConfig(repo, "a.ts"))).toMatchObject({ code: "invalidYaml" });
	});

	it("lets a nearer file restate one end of a threshold band", async () => {
		writeFiles(repo, {
			"melian.yaml": lines("decisions:", "  thresholds:", "    real:", "      drop: 0.2", "      accept: 0.8"),
			"services/melian.yaml": lines("decisions:", "  thresholds:", "    real:", "      drop: 0.3"),
		});
		const { config } = await loadConfig(repo, "services/a.ts");
		expect(config.decisions.thresholds).toEqual({ real: { drop: 0.3, accept: 0.8 } });
	});

	it("rejects a threshold band whose merge drops above where it accepts, naming the nearer file", async () => {
		writeFiles(repo, {
			"melian.yaml": lines("decisions:", "  thresholds:", "    real:", "      drop: 0.2", "      accept: 0.8"),
			"services/melian.yaml": lines("decisions:", "  thresholds:", "    real:", "      drop: 0.9"),
		});
		const error = await rejection(loadConfig(repo, "services/a.ts"));
		expect(error).toMatchObject({
			code: "invalidValue",
			key: "decisions.thresholds.real",
			file: join(repo, "services/melian.yaml"),
		});
		expect(error.message).toContain("drop must not exceed accept");
	});

	it("rejects a threshold band that no file completes", async () => {
		writeFiles(repo, { "melian.yaml": lines("decisions:", "  thresholds:", "    real:", "      drop: 0.2") });
		const error = await rejection(loadConfig(repo, "a.ts"));
		expect(error).toMatchObject({ code: "invalidValue", key: "decisions.thresholds.real.accept" });
	});

	it("refuses a path outside the repository", async () => {
		await expect(loadConfig(repo, "../elsewhere/a.ts")).rejects.toBeInstanceOf(OutsideRepositoryError);
	});
});

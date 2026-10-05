import { symlinkSync } from "node:fs";
import { join } from "node:path";
import {
	Changeset,
	ConfigError,
	defaultConfig,
	loadConfig,
	maxConfigBytes,
	OutsideRepositoryError,
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	gitIn,
	isolatedGitEnv,
	lines,
	rejection as rejectionOf,
	removeDirectory,
	sourceFor,
	sourceKinds,
	temporaryDirectory,
	writeFiles,
} from "./fixtures/repo.ts";

let repo: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

const rejection = (promise: Promise<unknown>) => rejectionOf(promise, ConfigError);

describe.each(sourceKinds)("loadConfig from the %s", (kind) => {
	const load = (path: string) => loadConfig(repo, sourceFor(repo, kind), path);

	it("returns the design's defaults when no melian.yaml exists", async () => {
		const loaded = await load("src/index.ts");
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
			const { config, sources } = await load("services/payments/api/charge.ts");

			expect(sources).toEqual(["services/payments/melian.yaml", "melian.yaml"]);
			expect(config.resolution).toEqual({ P0: "block", P1: "block", P2: "block", P3: "block", nit: "silent" });
			expect(config.lenses).toEqual({
				security: { tier: "heavy", paths: ["services/payments/api/**", "services/payments/webhooks/**"] },
			});
			expect(config.models).toEqual({ heavy: { model: "anthropic/sonnet", fallbacks: ["openai/gpt"] } });
			expect(config.stages).toEqual(defaultConfig.stages);
		});

		it("applies only the root file outside the service", async () => {
			const { config, sources } = await load("docs/readme.md");

			expect(sources).toEqual(["melian.yaml"]);
			expect(config.resolution.P3).toBe("advisory");
			expect(config.lenses).toEqual({ security: { tier: "medium", paths: ["src/**"] } });
		});

		it("treats a directory path as the directory itself", async () => {
			const { sources } = await load(join(repo, "services/payments"));
			expect(sources).toHaveLength(2);
		});
	});

	it("anchors lens paths at their file, keeping negations and dropping a leading slash", async () => {
		writeFiles(repo, {
			"melian.yaml": lines("lenses:", "  security:", "    paths: [/src/**, '!src/generated/**']"),
			"services/melian.yaml": lines("lenses:", "  contracts:", "    paths: [/api/**, '!api/generated/**']"),
		});
		const { config } = await load("services/a.ts");
		expect(config.lenses).toEqual({
			security: { paths: ["src/**", "!src/generated/**"] },
			contracts: { paths: ["services/api/**", "!services/api/generated/**"] },
		});
	});

	it("layers a lens's level band end by end, and reads the severity that escalates a quick lens", async () => {
		writeFiles(repo, {
			"melian.yaml": lines(
				"lenses:",
				"  trust-boundary:",
				"    level: { floor: careful, ceiling: deep }",
				"triage:",
				"  escalateAt: P2",
			),
			"services/melian.yaml": lines("lenses:", "  trust-boundary:", "    level: { ceiling: careful }"),
		});
		const nested = (await load("services/a.ts")).config;
		expect(nested.lenses["trust-boundary"]).toEqual({ level: { floor: "careful", ceiling: "careful" } });
		expect(nested.triage).toEqual({ escalateAt: "P2" });
		const root = (await load("src/a.ts")).config;
		expect(root.lenses["trust-boundary"]).toEqual({ level: { floor: "careful", ceiling: "deep" } });
		expect(defaultConfig.triage).toEqual({ escalateAt: "P1" });
	});

	it("refuses a ceiling of skip, which would let triage switch a lens off past its floor", async () => {
		writeFiles(repo, { "melian.yaml": lines("lenses:", "  tests:", "    level: { ceiling: skip }") });
		const error = await rejection(load("."));
		expect(error).toMatchObject({ code: "invalidValue", key: "lenses.tests.level.ceiling" });
	});

	it("normalises lens paths in the root file the same way as in a nested one", async () => {
		writeFiles(repo, {
			"melian.yaml": lines("lenses:", "  security:", "    paths: [./src/**, 'lib/../api/**']"),
			"services/melian.yaml": lines("lenses:", "  contracts:", "    paths: [./api/**, '../shared/**']"),
		});
		const { config } = await load("services/a.ts");
		expect(config.lenses).toEqual({
			security: { paths: ["src/**", "api/**"] },
			contracts: { paths: ["services/api/**", "shared/**"] },
		});
	});

	it.each([
		["melian.yaml", "../outside/**"],
		["melian.yaml", "!../outside/**"],
		["services/melian.yaml", "../../outside/**"],
	])("rejects a lens path in %s that climbs out of the repository: %j", async (file, pattern) => {
		writeFiles(repo, { [file]: lines("lenses:", "  security:", `    paths: ['${pattern}']`) });
		expect(await rejection(load("services/a.ts"))).toMatchObject({
			code: "invalidValue",
			file,
			key: "lenses.security.paths",
		});
	});

	it.each([
		["lenses:", "  security:", "    paths: ['*.{ts,js}']", "lenses.security.paths"],
		[
			"guardrails:",
			"  forbidden-paths:",
			"    rules: { keys: { paths: ['[ab].pem'], message: m } }",
			"guardrails.forbidden-paths.rules.keys.paths",
		],
	])("refuses a brace or class in a glob, which would match nothing: %s %s", async (...rows) => {
		const key = rows.pop()!;
		writeFiles(repo, { "services/melian.yaml": lines(...rows) });
		const error = await rejection(load("services/a.ts"));
		expect(error).toMatchObject({ code: "invalidValue", file: "services/melian.yaml", key });
		expect(error.message).toMatch(/do not support braces or character classes/);
	});

	it("refuses a glob ending in a slash, suggesting the glob that matches the directory's files", async () => {
		writeFiles(repo, { "melian.yaml": lines("lenses:", "  security:", "    paths: [secrets/]") });
		const error = await rejection(load("a.ts"));
		expect(error).toMatchObject({ code: "invalidValue", key: "lenses.security.paths" });
		expect(error.message).toMatch(/matches no file; write secrets\/\*\*/);
	});

	it("compiles every glob when it reads the file, refusing one too long to run", async () => {
		writeFiles(repo, { "melian.yaml": lines("lenses:", "  security:", `    paths: ['${"a".repeat(2_001)}']`) });
		const error = await rejection(load("a.ts"));
		expect(error).toMatchObject({ code: "invalidValue", file: "melian.yaml", key: "lenses.security.paths" });
		expect(error.message).toMatch(/not a safe glob: the pattern compiles to more than 2000 steps/);
	});

	it("names a melian.yaml it cannot read", async () => {
		writeFiles(repo, { "melian.yaml/inside": "" });
		expect(await rejection(load("a.ts"))).toMatchObject({ code: "unreadable", file: "melian.yaml" });
	});

	it("refuses a symlinked melian.yaml rather than following it", async () => {
		writeFiles(repo, { "elsewhere.yaml": lines("knowledge:", "  writeBack: true") });
		symlinkSync("elsewhere.yaml", join(repo, "melian.yaml"));
		expect(await rejection(load("a.ts"))).toMatchObject({ code: "symlink", file: "melian.yaml" });
	});

	it("ignores a melian.yaml beneath a symlinked directory", async () => {
		writeFiles(repo, { "real/melian.yaml": lines("knowledge:", "  writeBack: true") });
		symlinkSync("real", join(repo, "linked"));
		expect(await load("linked/a.ts")).toEqual({ config: defaultConfig, sources: [] });
	});

	it("refuses a melian.yaml over the size limit instead of truncating it", async () => {
		writeFiles(repo, { "melian.yaml": `# ${"x".repeat(maxConfigBytes)}\n` });
		expect(await rejection(load("a.ts"))).toMatchObject({ code: "tooLarge", file: "melian.yaml" });
	});

	it("replaces a tier's checks rather than appending to them", async () => {
		writeFiles(repo, { "melian.yaml": lines("tiers:", "  fast: [guardrails]") });
		const { config } = await load("a.ts");
		expect(config.tiers).toEqual({ ...defaultConfig.tiers, fast: ["guardrails"] });
	});

	it("reads a rule alias as a list of the owner's other names, or as rules marked distinct", async () => {
		writeFiles(repo, {
			"melian.yaml": lines(
				"ruleAliases:",
				"  broken-caller: [unhandled-error]",
				"  null-dereference:",
				"    rules: [unhandled-error]",
				"    distinct: true",
			),
		});
		const { config } = await load("a.ts");
		expect(config.ruleAliases).toEqual({
			"broken-caller": ["unhandled-error"],
			"null-dereference": { rules: ["unhandled-error"], distinct: true },
		});
	});

	it("reads the checks a tier may skip, a nearer file's list replacing a farther one's", async () => {
		writeFiles(repo, {
			"melian.yaml": lines("checks:", "  allowSkip: [static.tsc, static.biome]"),
			"services/melian.yaml": lines("checks:", "  allowSkip: [lens.contracts]"),
		});
		expect((await load("a.ts")).config.checks).toEqual({ allowSkip: ["static.tsc", "static.biome"] });
		expect((await load("services/a.ts")).config.checks).toEqual({ allowSkip: ["lens.contracts"] });
	});

	it("reads an empty file as contributing nothing", async () => {
		writeFiles(repo, { "melian.yaml": "" });
		const { config, sources } = await load("a.ts");
		expect(config).toEqual(defaultConfig);
		expect(sources).toEqual(["melian.yaml"]);
	});

	it.each([
		["tier: fast", "tier"],
		["resolution:\n  P4: block", "resolution.P4"],
		["lenses:\n  security:\n    enable: true", "lenses.security.enable"],
		["models:\n  heavy:\n    model: a\n    fallback: [b]", "models.heavy.fallback"],
	])("rejects an unknown key in %j, naming it and the file", async (yaml, key) => {
		writeFiles(repo, { "services/melian.yaml": yaml });
		const error = await rejection(load("services/a.ts"));
		expect(error).toMatchObject({ code: "unknownKey", key, file: "services/melian.yaml" });
		expect(error.message).toContain(key);
		expect(error.message).toContain("services/melian.yaml");
	});

	it.each([
		["lenses:\n  __proto__:\n    tier: heavy", "lenses.__proto__"],
		["decisions:\n  thresholds:\n    __proto__:\n      drop: 0.1", "decisions.thresholds.__proto__"],
		["__proto__:\n  polluted: true", "__proto__"],
	])("rejects __proto__ as a key in %j", async (yaml, key) => {
		writeFiles(repo, { "melian.yaml": yaml });
		expect(await rejection(load("a.ts"))).toMatchObject({ code: "reservedKey", key });
	});

	it("looks up a lens named like an Object method as any other lens", async () => {
		const { config: defaults } = await load("a.ts");
		expect(defaults.lenses.toString).toBeUndefined();
		writeFiles(repo, {
			"melian.yaml": lines("lenses:", "  constructor:", "    tier: heavy", "  toString:", "    enabled: false"),
		});
		const { config } = await load("a.ts");
		expect(config.lenses.constructor).toEqual({ tier: "heavy" });
		expect(config.lenses.toString).toEqual({ enabled: false });
		expect(config.stages.hasOwnProperty).toBeUndefined();
	});

	it("rejects a value outside its set, listing the allowed values", async () => {
		writeFiles(repo, { "melian.yaml": lines("resolution:", "  P0: blocker") });
		const error = await rejection(load("a.ts"));
		expect(error).toMatchObject({ code: "invalidValue", key: "resolution.P0" });
		expect(error.message).toContain("block, acknowledge, advisory, silent");
	});

	it.each([
		["tiers: [", "unclosed flow sequence"],
		["knowledge:\n  writeBack: true\nknowledge:\n  writeBack: false", "duplicate key"],
	])("rejects invalid YAML: %j (%s)", async (yaml) => {
		writeFiles(repo, { "melian.yaml": yaml });
		expect(await rejection(load("a.ts"))).toMatchObject({ code: "invalidYaml" });
	});

	it("rejects a YAML alias bomb as invalid YAML naming the file", async () => {
		const bomb = ["a: &a [x, x, x, x, x, x, x, x, x]"];
		for (const [name, previous] of ["ba", "cb", "dc", "ed", "fe", "gf"].map((pair) => [pair[0], pair[1]])) {
			bomb.push(`${name}: &${name} [${Array(9).fill(`*${previous}`).join(", ")}]`);
		}
		writeFiles(repo, { "melian.yaml": lines(...bomb) });
		expect(await rejection(load("a.ts"))).toMatchObject({ code: "invalidYaml", file: "melian.yaml" });
	});

	it("lets a nearer file restate one end of a threshold band", async () => {
		writeFiles(repo, {
			"melian.yaml": lines("decisions:", "  thresholds:", "    real:", "      drop: 0.2", "      accept: 0.8"),
			"services/melian.yaml": lines("decisions:", "  thresholds:", "    real:", "      drop: 0.3"),
		});
		const { config } = await load("services/a.ts");
		expect(config.decisions.thresholds).toEqual({ real: { drop: 0.3, accept: 0.8 } });
	});

	it("rejects a threshold band whose merge drops above where it accepts, naming the nearer file", async () => {
		writeFiles(repo, {
			"melian.yaml": lines("decisions:", "  thresholds:", "    real:", "      drop: 0.2", "      accept: 0.8"),
			"services/melian.yaml": lines("decisions:", "  thresholds:", "    real:", "      drop: 0.9"),
		});
		const error = await rejection(load("services/a.ts"));
		expect(error).toMatchObject({
			code: "invalidValue",
			key: "decisions.thresholds.real",
			file: "services/melian.yaml",
		});
		expect(error.message).toContain("drop must not exceed accept");
	});

	it("rejects a threshold band that no file completes", async () => {
		writeFiles(repo, { "melian.yaml": lines("decisions:", "  thresholds:", "    real:", "      drop: 0.2") });
		const error = await rejection(load("a.ts"));
		expect(error).toMatchObject({ code: "invalidValue", key: "decisions.thresholds.real.accept" });
	});

	it("refuses a path outside the repository", async () => {
		const error = await rejectionOf(load("../elsewhere/a.ts"), OutsideRepositoryError);
		expect(error).toMatchObject({ code: "outsideRepository", path: "../elsewhere/a.ts" });
	});

	it.each([".", "a.ts"])("refuses a repository root that does not exist, given %j", async (path) => {
		const missing = join(repo, "missing");
		const source = kind === "worktree" ? { kind } : { kind, commit: "HEAD" };
		expect(await rejection(loadConfig(missing, source, path))).toMatchObject({ code: "missingRoot", file: missing });
	});
});

describe("loadConfig from a revision", () => {
	beforeEach(() => {
		writeFiles(repo, { "melian.yaml": lines("resolution:", "  P2: block") });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "base policy");
		gitIn(repo, "checkout", "--quiet", "-b", "feature");
		writeFiles(repo, { "melian.yaml": lines("resolution:", "  P0: silent", "  P1: silent", "  P2: silent") });
		gitIn(repo, "commit", "--quiet", "-am", "the head relaxes its own review");
	});

	it("reads the base's policy for a pull request whose head rewrites it", async () => {
		const { revision } = await Changeset.resolve(repo, "main...feature");
		const { config } = await loadConfig(repo, { kind: "revision", commit: revision.base }, "src/a.ts");
		expect(config.resolution).toMatchObject({ P0: "block", P1: "block", P2: "block" });
	});

	it("is unaffected by the branch checked out or by uncommitted edits", async () => {
		const base = gitIn(repo, "rev-parse", "main");
		writeFiles(repo, { "melian.yaml": lines("tier: not even valid") });
		const { config } = await loadConfig(repo, { kind: "revision", commit: base }, "src/a.ts");
		expect(config.resolution.P2).toBe("block");
		await expect(loadConfig(repo, { kind: "worktree" }, "src/a.ts")).rejects.toBeInstanceOf(ConfigError);
	});

	it("names the commit in a message about one of its files", async () => {
		writeFiles(repo, { "melian.yaml": lines("tier: fast") });
		gitIn(repo, "commit", "--quiet", "-am", "bad key");
		const error = await rejection(loadConfig(repo, { kind: "revision", commit: "feature" }, "a.ts"));
		expect(error.file).toBe("melian.yaml");
		expect(error.message).toContain(`${gitIn(repo, "rev-parse", "feature").slice(0, 12)}:melian.yaml`);
	});

	it.each(["no-such-ref", "--output=x"])("refuses a commit that does not resolve: %j", async (commit) => {
		expect(await rejection(loadConfig(repo, { kind: "revision", commit }, "a.ts"))).toMatchObject({
			code: "unknownCommit",
		});
	});

	it("passes on git's own complaint rather than guessing it means no repository", async () => {
		writeFiles(repo, { ".git/config": lines("[core", "not valid") });
		const error = await rejection(loadConfig(repo, { kind: "revision", commit: "main" }, "a.ts"));
		expect(error.code).toBe("unreadable");
		expect(error.message).toMatch(/bad config/);
	});

	it("refuses a root that is not the top of a repository", async () => {
		writeFiles(repo, { "src/a.ts": "" });
		const error = await rejection(loadConfig(join(repo, "src"), { kind: "revision", commit: "HEAD" }, "a.ts"));
		expect(error.code).toBe("notARepository");
	});
});

describe("melian.local.yaml", () => {
	beforeEach(() => {
		writeFiles(repo, {
			"melian.yaml": lines("models:", "  heavy:", "    model: root/heavy", "    fallbacks: [root/fallback]"),
			"services/pay/melian.yaml": lines("models:", "  heavy:", "    model: service/heavy"),
		});
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "policy");
	});

	const commitLocalFile = () => {
		writeFiles(repo, { "melian.local.yaml": lines("resolution:", "  P0: silent") });
		gitIn(repo, "add", "--force", "melian.local.yaml");
		gitIn(repo, "commit", "--quiet", "-m", "the head supplies a local file");
	};

	it("applies from the working tree over every melian.yaml, a nested one included", async () => {
		writeFiles(repo, { "melian.local.yaml": lines("models:", "  heavy:", "    model: mine/heavy") });
		const { config, sources } = await loadConfig(repo, { kind: "worktree" }, "services/pay/a.ts");
		expect(config.models.heavy).toEqual({ model: "mine/heavy", fallbacks: ["root/fallback"] });
		expect(sources).toEqual(["melian.local.yaml", "services/pay/melian.yaml", "melian.yaml"]);
	});

	it("is never read from a revision, even one that commits it", async () => {
		commitLocalFile();
		const { config, sources } = await loadConfig(repo, { kind: "revision", commit: "HEAD" }, "a.ts");
		expect(config.resolution.P0).toBe("block");
		expect(sources).toEqual(["melian.yaml"]);
	});

	it("is a policy file, so a change that commits one is reviewed as policy", async () => {
		commitLocalFile();
		const { revision } = await Changeset.resolve(repo, "HEAD~1..HEAD");
		expect(revision.policyFiles).toEqual(["melian.local.yaml"]);
	});

	it("names itself in an error", async () => {
		writeFiles(repo, { "melian.local.yaml": lines("tier: fast") });
		const error = await rejection(loadConfig(repo, { kind: "worktree" }, "a.ts"));
		expect(error).toMatchObject({ code: "unknownKey", file: "melian.local.yaml" });
	});
});

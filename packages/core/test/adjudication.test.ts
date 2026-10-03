import {
	applyResolutions,
	createFinding,
	dedupeFindings,
	defaultConfig,
	type FindingInput,
	loadConfig,
	type MelianConfig,
	parseFinding,
	resolveFinding,
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalInput } from "./fixtures/findings.ts";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

const finding = (input: Partial<FindingInput>) => createFinding({ ...evalInput, trigger: undefined, ...input });

describe("resolveFinding", () => {
	it("takes the resolution configured for the severity of an introduced finding", () => {
		expect(resolveFinding(finding({ severity: "P0" }), defaultConfig)).toBe("block");
		expect(resolveFinding(finding({ severity: "P2" }), defaultConfig)).toBe("acknowledge");
		expect(resolveFinding(finding({ severity: "nit" }), defaultConfig)).toBe("silent");
	});

	it("keeps the configured resolution of an affected finding, which carries evidence", () => {
		const affected = finding({ severity: "P1", cause: { evidence: "src/api.ts:3 renames id to userId" } });
		expect(resolveFinding(affected, defaultConfig)).toBe("block");
	});

	it("caps a pre-existing finding at advisory, whatever its severity", () => {
		const strict: MelianConfig = {
			...defaultConfig,
			resolution: { P0: "block", P1: "block", P2: "block", P3: "block", nit: "silent" },
		};
		for (const severity of ["P0", "P1", "P2", "P3"] as const) {
			expect(resolveFinding(finding({ severity, cause: "pre-existing" }), strict)).toBe("advisory");
		}
		expect(resolveFinding(finding({ severity: "nit", cause: "pre-existing" }), strict)).toBe("silent");
	});
});

describe("applyResolutions under layered configuration", () => {
	let repo: string;

	beforeEach(() => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		repo = temporaryDirectory();
		gitIn(repo, "init", "--quiet", "--initial-branch=main");
		writeFiles(repo, {
			"melian.yaml": lines("resolution:", "  P3: acknowledge"),
			"docs/melian.yaml": lines("resolution:", "  P2: advisory"),
		});
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "policy");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		removeDirectory(repo);
	});

	it("resolves each finding under the configuration for its own path", async () => {
		const source = { kind: "revision", commit: gitIn(repo, "rev-parse", "HEAD") } as const;
		const findings = [
			finding({ file: "src/run.ts", severity: "P2" }),
			finding({ file: "docs/guide/setup.md", severity: "P2" }),
			finding({ file: "docs/guide/setup.md", severity: "P3", rule: "stale-link" }),
			finding({ file: "docs/guide/setup.md", severity: "P1", rule: "leaked-key" }),
		];
		const configs = new Map<string, MelianConfig>();
		for (const { properties } of findings) {
			configs.set(properties.path, (await loadConfig(repo, source, properties.path)).config);
		}

		const resolved = applyResolutions(findings, (path) => configs.get(path)!);

		expect(resolved.map((each) => each.properties.resolution)).toEqual([
			"acknowledge",
			"advisory",
			"acknowledge",
			"block",
		]);
		expect(findings[1]!.properties.resolution).toBe("block");
	});
});

describe("dedupeFindings", () => {
	const lens = finding({ severity: "P1" });
	const eslintInput: Partial<FindingInput> = {
		rule: "security/detect-eval-with-expression",
		severity: "P2",
		message: "eval with a non-literal argument",
		source: { check: "static.eslint" },
	};
	const eslint = finding(eslintInput);
	const aliases = { ruleAliases: { "no-eval": ["security/detect-eval-with-expression"] } };

	it("keeps the higher-severity finding when a static tool and a lens report one problem under aliased rules", () => {
		const [kept, ...rest] = dedupeFindings([eslint, lens], () => aliases);

		expect(rest).toEqual([]);
		expect(kept!.properties.id).toBe(lens.properties.id);
		expect(kept!.properties.alsoReportedAs).toEqual([
			{ id: eslint.properties.id, ruleId: "security/detect-eval-with-expression", check: "static.eslint" },
		]);
		expect(parseFinding(kept)).toEqual(kept);
	});

	it("keeps the static tool's finding when it is the more severe", () => {
		const severe = finding({ ...eslintInput, severity: "P0" });
		const deduped = dedupeFindings([lens, severe], () => aliases);
		expect(deduped.map((each) => each.properties.source.check)).toEqual(["static.eslint"]);
		expect(deduped[0]!.properties.alsoReportedAs).toEqual([
			{ id: lens.properties.id, ruleId: "no-eval", check: "lens.security" },
		]);
	});

	it("keeps both without an alias, at another occurrence, or from the same check", () => {
		expect(dedupeFindings([eslint, lens], () => defaultConfig)).toHaveLength(2);
		const second = finding({ ...eslintInput, occurrence: 1 });
		expect(dedupeFindings([second, lens], () => aliases)).toHaveLength(2);
		const sameCheck = finding({ ...eslintInput, source: { check: "lens.security" } });
		expect(dedupeFindings([sameCheck, lens], () => aliases)).toHaveLength(2);
	});
});

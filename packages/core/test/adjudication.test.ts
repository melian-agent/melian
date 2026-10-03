import {
	applyResolutions,
	createFinding,
	defaultConfig,
	type FindingInput,
	loadConfig,
	type MelianConfig,
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

import { Changeset, ConfigError, configLookup, loadConfig, snippetHash } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateGuardrails } from "../src/guardrails.ts";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

let repo: string;
const file = "services/pay/melian.yaml";
const quiet = lines("guardrails:", "  policy-change-review: { enabled: false }");

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

function commit(files: Record<string, string>, message: string): string {
	writeFiles(repo, files);
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "--allow-empty", "-m", message);
	return gitIn(repo, "rev-parse", "HEAD");
}

async function review(baseFiles: Record<string, string>, headFiles: Record<string, string>, removed: string[] = []) {
	const base = commit(baseFiles, "base");
	for (const path of removed) gitIn(repo, "rm", "--quiet", path);
	const head = commit(headFiles, "head");
	const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
	const source = { kind: "revision", commit: base } as const;
	const report = await evaluateGuardrails({ repoRoot: repo, revision, source });
	return { ...report, source, head };
}

const changes = [
	{
		key: "guardrails.forbidden-paths.severity",
		base: "guardrails: { forbidden-paths: { severity: P1 } }\n",
		head: "guardrails: { forbidden-paths: { severity: P3 } }\n",
		oldValue: '"P1"',
		newValue: '"P3"',
	},
	{
		key: "guardrails.policy-change-review.enabled",
		base: "guardrails: { policy-change-review: { enabled: true } }\n",
		head: "guardrails: { policy-change-review: { enabled: false } }\n",
		oldValue: "true",
		newValue: "false",
	},
	{
		key: "lenses.correctness.enabled",
		base: "lenses: { correctness: { enabled: true } }\n",
		head: "lenses: { correctness: { enabled: false } }\n",
		oldValue: "true",
		newValue: "false",
	},
	{
		key: "lenses.correctness.paths",
		base: 'lenses: { correctness: { paths: ["**"] } }\n',
		head: 'lenses: { correctness: { paths: ["src/**"] } }\n',
		oldValue: '["services/pay/**"]',
		newValue: '["services/pay/src/**"]',
	},
	{
		key: "lenses.correctness.level.floor",
		base: "lenses: { correctness: { level: { floor: careful } } }\n",
		head: "lenses: { correctness: { level: { floor: skip } } }\n",
		oldValue: '"careful"',
		newValue: '"skip"',
	},
	{
		key: "lenses.correctness.level.ceiling",
		base: "lenses: { correctness: { level: { ceiling: deep } } }\n",
		head: "lenses: { correctness: { level: { ceiling: quick } } }\n",
		oldValue: '"deep"',
		newValue: '"quick"',
	},
	{
		key: "static.biome.enabled",
		base: "static: { biome: { enabled: true } }\n",
		head: "static: { biome: { enabled: false } }\n",
		oldValue: "true",
		newValue: "false",
	},
	{
		key: "static.tsc.project",
		base: "static: { tsc: { project: tsconfig.json } }\n",
		head: "static: { tsc: { project: tsconfig.docs.json } }\n",
		oldValue: '"tsconfig.json"',
		newValue: '"tsconfig.docs.json"',
	},
	{
		key: "static.tsc.severity.tsc/TS2322",
		base: "static: { tsc: { severity: { tsc/TS2322: P1 } } }\n",
		head: "static: { tsc: { severity: { tsc/TS2322: P3 } } }\n",
		oldValue: '"P1"',
		newValue: '"P3"',
	},
	{
		key: "static.enola.timeout",
		base: "static: { enola: { timeout: 300 } }\n",
		head: "static: { enola: { timeout: 1 } }\n",
		oldValue: "300",
		newValue: "1",
	},
	{
		key: "static.mutation.maxLines",
		base: "static: { mutation: { maxLines: 2000 } }\n",
		head: "static: { mutation: { maxLines: 1 } }\n",
		oldValue: "2000",
		newValue: "1",
	},
	{
		key: "tiers.full",
		base: "tiers: { full: [guardrails, lens.correctness] }\n",
		head: "tiers: { full: [guardrails] }\n",
		oldValue: '["guardrails","lens.correctness"]',
		newValue: '["guardrails"]',
	},
	{
		key: "stages.pull-request",
		base: "stages: { pull-request: full }\n",
		head: "stages: { pull-request: fast }\n",
		oldValue: '"full"',
		newValue: '"fast"',
	},
	{
		key: "checks.allowSkip",
		base: "checks: { allowSkip: [] }\n",
		head: "checks: { allowSkip: [static.tsc] }\n",
		oldValue: "[]",
		newValue: '["static.tsc"]',
	},
	{
		key: "lenses.correctness.tier",
		base: "lenses: { correctness: { tier: heavy } }\n",
		head: "lenses: { correctness: { tier: light } }\n",
		oldValue: '"heavy"',
		newValue: '"light"',
	},
	{
		key: "decisions.thresholds.approval.accept",
		base: "decisions: { thresholds: { approval: { drop: 0.1, accept: 0.9 } } }\n",
		head: "decisions: { thresholds: { approval: { drop: 0.1, accept: 0.2 } } }\n",
		oldValue: "0.9",
		newValue: "0.2",
	},
	{
		key: "ruleAliases.owned",
		base: "ruleAliases: { owned: [other] }\n",
		head: "ruleAliases: { owned: [] }\n",
		oldValue: '["other"]',
		newValue: "[]",
	},
] as const;

describe("nested blocking policy, step 30 phase 1", () => {
	it.each(changes)("forces $key despite the parent's off switch, naming both parsed values", async (change) => {
		const { findings, source, head } = await review(
			{ "melian.yaml": quiet, [file]: change.base },
			{ [file]: change.head },
		);
		await expect(
			loadConfig(repo, { kind: "revision", commit: head }, "services/pay/subject.ts"),
		).resolves.toHaveProperty("config");
		const judged = await configLookup(repo, source).policyReview(file);
		expect(judged.config.guardrails["policy-change-review"].enabled).toBe(false);
		expect(findings.map((finding) => finding.properties.path)).toEqual([file]);
		const finding = findings[0]!;
		expect(finding.properties.guardrail).toMatchObject({ notice: "policy", blocking: true });
		expect(finding.properties.explanation.what).toContain(
			`${file}: ${change.key}: ${change.oldValue} -> ${change.newValue}`,
		);
		expect(finding.resolve({ resolution: judged.config.resolution, layers: judged.resolutionLayers })).toBe(
			"acknowledge",
		);
		expect(finding.properties.trigger?.hash).toBe(snippetHash(`blob:${gitIn(repo, "rev-parse", `${head}:${file}`)}`));
	});

	it("keeps a parent's P1 block when a guardrails entry silences the new class", async () => {
		const root = lines(
			"guardrails:",
			"  policy-change-review: { enabled: true, severity: P1 }",
			"resolution:",
			"  P1: block",
			"  checks:",
			"    guardrails:",
			"      ceiling: silent",
			"      rules:",
			"        guardrail/policy-change-review/blocking: { ceiling: silent }",
		);
		const { findings, source } = await review(
			{ "melian.yaml": root, [file]: changes[0].base },
			{ [file]: changes[0].head },
		);
		expect(findings).toHaveLength(1);
		const judged = await configLookup(repo, source).policyReview(file);
		expect(findings[0]!.resolve({ resolution: judged.config.resolution, layers: judged.resolutionLayers })).toBe(
			"block",
		);
	});

	it("compares declarations when moving an inherited key leaves the effective value unchanged", async () => {
		const parent = "services/melian.yaml";
		const base = commit({ "melian.yaml": quiet, [parent]: changes[2].head, [file]: "{}\n" }, "base");
		const head = commit({ [parent]: "{}\n", [file]: changes[2].head }, "head");
		const baseConfig = await loadConfig(repo, { kind: "revision", commit: base }, "services/pay/subject.ts");
		const headConfig = await loadConfig(repo, { kind: "revision", commit: head }, "services/pay/subject.ts");
		expect(baseConfig.config.lenses.correctness).toEqual(headConfig.config.lenses.correctness);
		const { revision } = await Changeset.resolve(repo, `${base}..${head}`);
		const { findings } = await evaluateGuardrails({
			repoRoot: repo,
			revision,
			source: { kind: "revision", commit: base },
		});
		expect(findings.map((finding) => finding.properties.path)).toEqual([parent, file]);
	});

	it("reports adding a declaration equal to the inherited value", async () => {
		const root = lines(quiet, changes[2].head);
		const { findings } = await review({ "melian.yaml": root, [file]: "{}\n" }, { [file]: changes[2].head });
		expect(findings).toHaveLength(1);
		expect(findings[0]!.properties.explanation.what).toContain(
			`${file}: lenses.correctness.enabled: <absent> -> false`,
		);
	});

	it("reports removal of a protected file with the absent-blob trigger", async () => {
		const { findings } = await review({ "melian.yaml": quiet, [file]: changes[2].base }, {}, [file]);
		expect(findings).toHaveLength(1);
		expect(findings[0]!.properties.explanation.what).toContain(
			`${file}: lenses.correctness.enabled: true -> <absent>`,
		);
		expect(findings[0]!.properties.trigger?.hash).toBe(snippetHash("blob:"));
	});

	it("reports an unparseable head as unknown policy instead of claiming its keys stand", async () => {
		const { findings } = await review(
			{ "melian.yaml": quiet, [file]: changes[0].base },
			{ [file]: "guardrails: [\n" },
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]!.properties.explanation.what).toContain(`${file}: $: <parsed> -> <unparseable>`);
		expect(findings[0]!.properties.guardrail).toMatchObject({ notice: "policy", blocking: true });
	});

	it("keeps an invalid base policy as a check failure", async () => {
		await expect(
			review({ "melian.yaml": quiet, [file]: "guardrails: [\n" }, { [file]: changes[0].head }),
		).rejects.toBeInstanceOf(ConfigError);
	});

	it("does not force unchanged protected keys after comments, mapping order or equivalent glob spelling change", async () => {
		const { findings } = await review(
			{ "melian.yaml": quiet, [file]: 'lenses: { correctness: { enabled: true, paths: ["./src/**"] } }\n' },
			{ [file]: '# reformatted\nlenses:\n  correctness:\n    paths: ["src/**"]\n    enabled: true\n' },
		);
		expect(findings).toEqual([]);
	});

	it.each([
		["publish.walkthrough.enabled", "publish: { walkthrough: { enabled: false } }\n"],
		["models.heavy.model", "models: { heavy: { model: fixture/heavy } }\n"],
		["knowledge.writeBack", "knowledge: { writeBack: true }\n"],
	])("leaves the exact exemption %s under the parent's switch", async (_key, head) => {
		const { findings } = await review({ "melian.yaml": quiet, [file]: "{}\n" }, { [file]: head });
		expect(findings).toEqual([]);
	});

	it("still reports exempt-only edits when the parent leaves the notice on", async () => {
		const { findings } = await review(
			{ [file]: "publish: { walkthrough: { enabled: true } }\n" },
			{ [file]: "publish: { walkthrough: { enabled: false } }\n" },
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]!.properties.guardrail).toEqual({ notice: "policy" });
	});
});

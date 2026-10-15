import { Adjudication, Finding, type FindingInput, Lens, loadConfig } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configsFor } from "../src/configurations.ts";
import { commit, createRepository, lines, removeRepository, writeFiles } from "./fixtures/repo.ts";

const lensFile = (name: string, ...frontMatter: string[]) =>
	lines(
		"---",
		`name: ${name}`,
		"description: Reuse and simplification.",
		"tier: medium",
		"rules:",
		"  - id: reuse",
		"    description: Code that repeats a helper the repository already has.",
		...frontMatter,
		"---",
		"Find what repeats.",
	);

const finding = (input: Partial<FindingInput> = {}) =>
	Finding.create({
		rule: "reuse",
		message: "formatPrice repeats format().",
		file: "services/payments/src/ledger.ts",
		startLine: 3,
		snippet: "return amount.toFixed(2);",
		occurrence: 0,
		cause: "introduced",
		severity: "P2",
		explanation: { what: "It repeats format().", whyHere: "This change adds it.", whatToDo: "Call format()." },
		source: { check: "lens.cleanup", version: "1" },
		...input,
	});

let repo: string;
beforeEach(() => {
	repo = createRepository();
});
afterEach(() => {
	vi.restoreAllMocks();
	removeRepository(repo);
});

// Each test builds a repository and loads its lenses from git several times.
describe("configsFor", { timeout: 60_000 }, () => {
	it("gives each finding its path's own layers, nearest first, and the merged cap", async () => {
		const base = commit(repo, {
			"melian.yaml": lines(
				"resolution:",
				"  P2: acknowledge",
				"  preExisting: { P0: acknowledge }",
				"  checks:",
				"    lens.cleanup: { ceiling: advisory }",
			),
			"services/payments/melian.yaml": lines("resolution:", "  P1: block"),
		});
		const findings = [finding(), finding({ severity: "P1" }), finding({ file: "docs/guide.md" })];
		const configFor = await configsFor(repo, { kind: "revision", commit: base }, findings);
		const at = configFor("services/payments/src/ledger.ts", "reuse");
		expect(at.layers?.map((layer) => layer.file)).toEqual(["services/payments/melian.yaml", "melian.yaml"]);
		expect(at.resolution.preExisting?.P0).toBe("acknowledge");
		expect(configFor("docs/guide.md", "reuse").layers?.map((layer) => layer.file)).toEqual(["melian.yaml"]);
		const verdict = new Adjudication({ findings, manifest: [], checks: [], config: configFor }).adjudicate();
		expect(
			verdict.all().map(({ properties }) => [properties.path, properties.severity, properties.resolution]),
		).toEqual([
			["services/payments/src/ledger.ts", "P1", "block"],
			["docs/guide.md", "P2", "advisory"],
			["services/payments/src/ledger.ts", "P2", "advisory"],
		]);
	});

	it("reads a lens's declared default as the lens applies at the finding's path, from the policy source", async () => {
		const base = commit(repo, {
			".melian/lenses/cleanup/LENS.md": lensFile("cleanup", "resolution: { ceiling: advisory }"),
			".melian/lenses/plain/LENS.md": lensFile("plain"),
			"services/.melian/lenses/cleanup/LENS.md": lensFile("cleanup", "resolution: { ceiling: silent }"),
		});
		commit(repo, { ".melian/lenses/cleanup/LENS.md": lensFile("cleanup", "resolution: { ceiling: block }") });
		const findings = [finding(), finding({ file: "docs/guide.md" })];
		const configFor = await configsFor(repo, { kind: "revision", commit: base }, findings);
		expect(configFor("docs/guide.md", "reuse").lensDefaults).toStrictEqual(
			Object.assign(Object.create(null), { cleanup: { ceiling: "advisory" } }),
		);
		expect(configFor("services/payments/src/ledger.ts", "reuse").lensDefaults?.cleanup).toEqual({
			ceiling: "silent",
		});
		const verdict = new Adjudication({ findings, manifest: [], checks: [], config: configFor }).adjudicate();
		expect(verdict.findings.advisory.map(({ properties }) => properties.decidedBy)).toEqual([
			{
				lens: "cleanup",
				check: "lens.cleanup",
				rule: "reuse",
				requirement: { entry: "built-in" },
				ceiling: { entry: "lens-default", key: "resolution.ceiling" },
			},
		]);
		expect(verdict.findings.silent.map(({ properties }) => properties.path)).toEqual([
			"services/payments/src/ledger.ts",
		]);
	});

	it("resolves a report under the variant that made it, for a file a nearer variant also covers", async () => {
		// A moved file is reviewed by the lens of the folder it left, so the root's cleanup can report under services.
		const base = commit(repo, {
			"melian.yaml": lines("lenses:", "  tuned: { tier: heavy }"),
			".melian/lenses/cleanup/LENS.md": lensFile("cleanup", "resolution: { P1: block }"),
			".melian/lenses/tuned/LENS.md": lensFile("tuned", "resolution: { P1: block }"),
			".melian/lenses/bare/LENS.md": lensFile("bare"),
			"services/.melian/lenses/cleanup/LENS.md": lensFile("cleanup", "resolution: { P1: silent }"),
			"services/.melian/lenses/tuned/LENS.md": lensFile("tuned", "resolution: { P1: silent }"),
			"services/.melian/lenses/bare/LENS.md": lensFile("bare", "resolution: { P1: silent }"),
			".melian/lenses/plain/LENS.md": lensFile("plain", "resolution: { P1: silent }"),
			// A sibling folder's variant, which reviews a file moved out of that folder into services.
			"docs/.melian/lenses/cleanup/LENS.md": lensFile("cleanup", "resolution: { P1: acknowledge }"),
			"services/.melian/lenses/plain/LENS.md": lensFile("plain"),
		});
		const policy = { kind: "revision", commit: base } as const;
		const { config } = await loadConfig(repo, policy, ".");
		const versionOf = async (name: string, at: string, tuned = false) => {
			const lens = (await Lens.load(repo, policy, [at])).find((each) => each.name === name)!;
			return (tuned ? lens.configured(config.lenses[name]) : lens).version;
		};
		const path = "services/payments/src/ledger.ts";
		const reported = (name: string, version?: string) =>
			finding({
				severity: "P1",
				rule: `${name}-rule`,
				source: { check: `lens.${name}`, ...(version ? { version } : {}) },
			});
		const findings = [
			reported("cleanup", `${await versionOf("cleanup", ".")}@careful`),
			reported("cleanup", `${await versionOf("cleanup", "services")}@deep`),
			reported("tuned", `${await versionOf("tuned", ".", true)}@quick`),
			reported("tuned", await versionOf("tuned", "services", true)),
			reported("bare", `${await versionOf("bare", ".")}@careful`),
			reported("cleanup", "0123456789ab@careful"),
			reported("cleanup"),
			reported("plain"),
			reported("tuned", await versionOf("tuned", ".")),
			reported("cleanup", `${await versionOf("cleanup", "docs")}@careful`),
		];
		expect(await versionOf("tuned", ".", true)).not.toBe(await versionOf("tuned", "."));
		const configFor = await configsFor(repo, policy, findings);
		const at = configFor(path, "cleanup-rule");
		expect(findings.map((each) => each.resolve(at))).toEqual([
			"block",
			"silent",
			"block",
			"silent",
			// The root's bare lens declares nothing, so the built-in table decides, not the nearer variant's default.
			"block",
			// A version no variant along the path has, or none at all, takes the nearest lens's default.
			"silent",
			"silent",
			// The nearest plain lens declares nothing, so the root's default does not reach an unknown variant.
			"block",
			// The root's version as it loaded, with no level.
			"block",
			"acknowledge",
		]);
		const listed = Object.keys(at.lensVariants ?? {}).filter((key) => /^(cleanup|tuned|bare)@/.test(key));
		expect(listed.every((key) => /@[0-9a-f]{12}(@(quick|careful|deep))?$/.test(key))).toBe(true);
	});

	it("loads no lens for findings no lens reported", async () => {
		const base = commit(repo, {
			".melian/lenses/cleanup/LENS.md": lensFile("cleanup", "resolution: { ceiling: silent }"),
		});
		const load = vi.spyOn(Lens, "load");
		const tool = finding({ rule: "biome/x", source: { check: "static.biome" } });
		const configFor = await configsFor(repo, { kind: "revision", commit: base }, [tool]);
		expect(load).not.toHaveBeenCalled();
		expect(configFor(tool.properties.path, tool.ruleId).lensDefaults).toEqual({});
		const twice = Finding.from({
			...tool.toJSON(),
			properties: { ...tool.properties, reportedBy: [{ check: "static.biome" }, { check: "lens.cleanup" }] },
		});
		await configsFor(repo, { kind: "revision", commit: base }, [twice]);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("fingerprints the layers and lens defaults the findings resolve under, whatever their order", async () => {
		const policy = { kind: "worktree" } as const;
		const root = (ceiling: string) =>
			lines("resolution:", "  P2: acknowledge", "  checks:", `    lens.cleanup: { ceiling: ${ceiling} }`);
		commit(repo, {
			"melian.yaml": root("advisory"),
			".melian/lenses/cleanup/LENS.md": lensFile("cleanup", "resolution: { P3: silent }"),
		});
		const findings = [finding(), finding({ file: "docs/guide.md" })];
		const read = async (order = findings) => (await configsFor(repo, policy, order)).fingerprint;
		const first = await read();
		expect(first).toMatch(/^2:[0-9a-f]{16}$/);
		expect(await read()).toBe(first);
		const legacy = (await configsFor(repo, policy, findings)).legacyFingerprint;
		expect(legacy).toMatch(/^[0-9a-f]{16}$/);
		writeFiles(repo, { "melian.yaml": root("block") });
		expect((await configsFor(repo, policy, findings)).legacyFingerprint).not.toBe(legacy);
		writeFiles(repo, { "melian.yaml": root("advisory") });
		expect(await read([...findings].reverse())).toBe(first);
		// Only a check entry changes: the merged table, which holds no checks, reads the same.
		writeFiles(repo, { "melian.yaml": root("block") });
		const edited = await read();
		expect(edited).not.toBe(first);
		// Only a lens's declared default changes.
		writeFiles(repo, { ".melian/lenses/cleanup/LENS.md": lensFile("cleanup", "resolution: { P3: block }") });
		const declared = await read();
		expect(declared).not.toBe(edited);
		// Only a nested folder's ruleAliases change, which decide what merges as one defect.
		writeFiles(repo, { "docs/melian.yaml": lines("ruleAliases:", "  reuse: { rules: [altitude], distinct: true }") });
		expect(await read()).not.toBe(declared);
	});

	it("judges a policy-change notice on a nested melian.yaml under the layers of the directory above", async () => {
		const base = commit(repo, {
			"melian.yaml": lines("resolution:", "  P2: block"),
			"services/melian.yaml": lines("resolution:", "  P2: silent"),
		});
		const notice = finding({
			rule: "guardrail/policy-change-review",
			file: "services/melian.yaml",
			snippet: undefined,
			occurrence: undefined,
			discriminator: "policy",
			source: { check: "guardrails" },
		});
		const configFor = await configsFor(repo, { kind: "revision", commit: base }, [notice]);
		expect(configFor("services/melian.yaml", notice.ruleId).layers?.map((layer) => layer.file)).toEqual([
			"melian.yaml",
		]);
		expect(configFor("services/melian.yaml").layers?.map((layer) => layer.file)).toEqual([
			"services/melian.yaml",
			"melian.yaml",
		]);
		expect(notice.resolve(configFor("services/melian.yaml", notice.ruleId))).toBe("block");
	});
});

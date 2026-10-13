import { Adjudication, Finding, type FindingInput, Lens } from "@melian-agent/core";
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

describe("configsFor", () => {
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
		expect(first).toMatch(/^[0-9a-f]{16}$/);
		expect(await read()).toBe(first);
		expect(await read([...findings].reverse())).toBe(first);
		// Only a check entry changes: the merged table, which holds no checks, reads the same.
		writeFiles(repo, { "melian.yaml": root("block") });
		const edited = await read();
		expect(edited).not.toBe(first);
		// Only a lens's declared default changes.
		writeFiles(repo, { ".melian/lenses/cleanup/LENS.md": lensFile("cleanup", "resolution: { P3: block }") });
		expect(await read()).not.toBe(edited);
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

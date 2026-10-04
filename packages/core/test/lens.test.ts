import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
	defaultConfig,
	type Lens,
	LensError,
	lensCovers,
	lensToolNames,
	loadLenses,
	type MelianConfig,
	parseLensFile,
	renderLensInstructions,
	selectLenses,
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	gitIn,
	isolatedGitEnv,
	lines,
	rejection,
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
	writeFiles(repo, { "src/index.ts": lines("export {};") });
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

function lensFile(frontMatter: string[], body = "Find what breaks."): string {
	return lines("---", ...frontMatter, "---", body);
}

const security = [
	"name: security",
	"description: Injection and secrets.",
	"tier: medium",
	"rules:",
	"  - id: injection",
	"    description: Input reaches a query unescaped.",
];

function named(lenses: readonly Lens[], name: string): Lens[] {
	return lenses.filter((lens) => lens.name === name);
}

describe("built-in lenses", () => {
	it("load correctness and contracts with their declared rules", async () => {
		const lenses = await loadLenses(repo, { kind: "worktree" }, ["src/index.ts"]);
		expect(lenses.map((lens) => lens.name)).toEqual(["contracts", "correctness"]);
		const [contracts, correctness] = lenses;
		expect(correctness).toMatchObject({
			tier: "heavy",
			tools: [...lensToolNames],
			severities: ["P0", "P1", "P2"],
			paths: ["**"],
			scope: "",
			budget: { findings: 8 },
			standards: true,
			file: "builtin:correctness",
		});
		expect(correctness!.rules.map((rule) => rule.id)).toContain("null-dereference");
		expect(contracts!.rules.map((rule) => rule.id)).toContain("broken-caller");
		expect(correctness!.instructions).toMatch(/^You are the correctness reviewer/);
		expect(correctness!.version).toMatch(/^[0-9a-f]{12}$/);
	});
});

describe("parseLensFile", () => {
	it("reads front matter and body, with defaults left for the loader", () => {
		const parsed = parseLensFile("x/LENS.md", lensFile(security, "Body.\n"));
		expect(parsed.frontMatter.name).toBe("security");
		expect(parsed.body).toBe("Body.");
	});

	it("names the file and field for an unknown field", () => {
		const error = (() => {
			try {
				parseLensFile("lenses/x/LENS.md", lensFile([...security, "model: anthropic/opus"]));
			} catch (caught) {
				return caught as LensError;
			}
		})();
		expect(error).toBeInstanceOf(LensError);
		expect(error).toMatchObject({ code: "unknownField", file: "lenses/x/LENS.md", field: "model" });
		expect(error?.message).toContain("lenses/x/LENS.md");
	});

	it("refuses a missing block, a tool outside the read-only set, and a bad tier", () => {
		const code = (content: string) => {
			try {
				parseLensFile("LENS.md", content);
			} catch (caught) {
				return (caught as LensError).code;
			}
		};
		expect(code("No front matter.")).toBe("missingFrontMatter");
		expect(code(lensFile([...security, "tools: [bash]"]))).toBe("invalidValue");
		expect(code(lensFile([...security.filter((line) => !line.startsWith("tier")), "tier: huge"]))).toBe(
			"invalidValue",
		);
		expect(code(lensFile(["name: [", "description: x"]))).toBe("invalidYaml");
	});
});

describe.each(sourceKinds)("repository lenses from the %s", (kind) => {
	const load = (paths: string[]) => loadLenses(repo, sourceFor(repo, kind), paths);

	it("discovers .melian/lenses and .agents/lenses beside the built-ins", async () => {
		writeFiles(repo, {
			".melian/lenses/security/LENS.md": lensFile([...security, "budget: { findings: 3, tokens: 200k }"]),
			".agents/lenses/docs/LENS.md": lensFile([
				"name: docs",
				"description: Documentation drift.",
				"tier: light",
				"standards: false",
				"rules:",
				"  - id: stale-doc",
				"    description: A doc describes the old behaviour.",
			]),
		});
		const lenses = await load(["src/index.ts"]);
		expect(lenses.map((lens) => lens.name)).toEqual(["contracts", "correctness", "docs", "security"]);
		expect(named(lenses, "security")[0]).toMatchObject({
			file: ".melian/lenses/security/LENS.md",
			budget: { findings: 3, tokens: 200_000 },
			severities: ["P0", "P1", "P2", "P3", "nit"],
		});
		expect(named(lenses, "docs")[0]!.standards).toBe(false);
	});

	it("loads the lenses for two thousand changed paths from one listing, layering each folder chain once", async () => {
		writeFiles(repo, {
			".melian/lenses/security/LENS.md": lensFile(security),
			"services/pay/.melian/lenses/security/LENS.md": lensFile(security),
		});
		const paths = Array.from({ length: 2000 }, (_, index) =>
			index % 2 === 0 ? `src/area${index % 100}/file${index}.ts` : `services/pay/api${index % 50}/file${index}.ts`,
		);
		const started = Date.now();
		const lenses = await load(paths);
		// The reviewer measured 22 seconds for this before lens folders were listed once per revision.
		expect(Date.now() - started).toBeLessThan(5000);
		expect(named(lenses, "security").map((lens) => lens.scope)).toEqual(["", "services/pay"]);
	});

	it("keeps a lens out of a folder whose own lens of that name no changed file reached", async () => {
		writeFiles(repo, {
			".melian/lenses/security/LENS.md": lensFile(security),
			"services/pay/.agents/lenses/security/LENS.md": lensFile(security),
		});
		const lenses = await load(["src/index.ts"]);
		expect(named(lenses, "security").map((lens) => lens.scope)).toEqual([""]);
		const [selected] = selectLenses(named(lenses, "security"), defaultConfig, ["src/index.ts"]);
		expect(selected!.coverage.nearer).toEqual(["services/pay"]);
		expect(lensCovers(selected!.coverage, "services/pay/charge.ts")).toBe(false);
		expect(lensCovers(selected!.coverage, "src/other.ts")).toBe(true);
	});

	it("lets .melian/lenses win a name .agents/lenses also defines", async () => {
		writeFiles(repo, {
			".melian/lenses/security/LENS.md": lensFile(security, "From .melian."),
			".agents/lenses/security/LENS.md": lensFile(security, "From .agents."),
		});
		expect(named(await load(["src/index.ts"]), "security")[0]!.instructions).toBe("From .melian.");
	});

	it("extends a built-in lens, overriding the fields it sets and appending its body", async () => {
		writeFiles(repo, {
			".melian/lenses/correctness/LENS.md": lensFile(
				["name: correctness", "extends: correctness", "tier: medium"],
				"Also check the retry loop.",
			),
		});
		const [correctness] = named(await load(["src/index.ts"]), "correctness");
		expect(correctness!.tier).toBe("medium");
		expect(correctness!.file).toBe(".melian/lenses/correctness/LENS.md");
		expect(correctness!.rules.map((rule) => rule.id)).toContain("null-dereference");
		expect(correctness!.instructions).toMatch(/^You are the correctness reviewer[\s\S]*Also check the retry loop\.$/);
	});

	it("applies a folder's lens only beneath that folder, nearest first", async () => {
		writeFiles(repo, {
			"services/pay/api.ts": lines("export {};"),
			".melian/lenses/security/LENS.md": lensFile(security, "Root security."),
			"services/pay/.melian/lenses/security/LENS.md": lensFile(
				["name: security", "extends: security", "tier: heavy", "paths: [api.ts]"],
				"Payments security.",
			),
		});
		const lenses = await load(["src/index.ts", "services/pay/api.ts"]);
		const variants = named(lenses, "security");
		expect(variants.map((lens) => [lens.scope, lens.tier, lens.paths])).toEqual([
			["", "medium", ["**"]],
			["services/pay", "heavy", ["services/pay/api.ts"]],
		]);
		expect(variants[1]!.instructions).toBe("Root security.\n\nPayments security.");
	});

	it("names the file for an extends no farther lens defines, and for a missing required field", async () => {
		writeFiles(repo, {
			".melian/lenses/style/LENS.md": lensFile(["name: style", "extends: nothing", "tier: light"]),
		});
		const unknown = await rejection(load(["src/index.ts"]), LensError);
		expect(unknown).toMatchObject({ code: "unknownLens", file: ".melian/lenses/style/LENS.md", field: "extends" });

		writeFiles(repo, { ".melian/lenses/style/LENS.md": lensFile(["name: style", "tier: light"]) });
		const missing = await rejection(load(["src/index.ts"]), LensError);
		expect(missing).toMatchObject({ code: "missingField", field: "description" });
	});

	it("normalises paths and refuses one that leaves the repository", async () => {
		writeFiles(repo, {
			"services/pay/api.ts": lines("export {};"),
			"services/pay/.melian/lenses/security/LENS.md": lensFile([...security, "paths: [./api.ts, '!../pay/x/**']"]),
		});
		const [scoped] = named(await load(["services/pay/api.ts"]), "security");
		expect(scoped!.paths).toEqual(["services/pay/api.ts", "!services/pay/x/**"]);

		writeFiles(repo, {
			"services/pay/.melian/lenses/security/LENS.md": lensFile([...security, "paths: [../../../x]"]),
		});
		const error = await rejection(load(["services/pay/api.ts"]), LensError);
		expect(error).toMatchObject({
			code: "invalidValue",
			field: "paths",
			file: "services/pay/.melian/lenses/security/LENS.md",
		});
	});

	it("refuses a lens whose name differs from its directory", async () => {
		writeFiles(repo, { ".melian/lenses/sec/LENS.md": lensFile(security) });
		expect(await rejection(load(["src/index.ts"]), LensError)).toMatchObject({ code: "invalidValue", field: "name" });
	});

	it("refuses a symlinked lens directory", async () => {
		writeFiles(repo, { "elsewhere/security/LENS.md": lensFile(security) });
		mkdirSync(join(repo, ".melian/lenses"), { recursive: true });
		symlinkSync("../../elsewhere/security", join(repo, ".melian/lenses/security"));
		expect((await rejection(load(["src/index.ts"]), LensError)).code).toBe("symlink");
	});
});

describe("loadLenses from a revision", () => {
	it("ignores lenses the checkout adds after that revision", async () => {
		const base = sourceFor(repo, "revision");
		writeFiles(repo, { ".melian/lenses/security/LENS.md": lensFile(security) });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "head adds a lens");
		expect((await loadLenses(repo, base, ["src/index.ts"])).map((lens) => lens.name)).toEqual([
			"contracts",
			"correctness",
		]);
	});
});

describe("selectLenses", () => {
	const lens = (overrides: Partial<Lens>): Lens => ({
		name: "security",
		description: "d",
		tier: "medium",
		tools: [...lensToolNames],
		severities: ["P1"],
		rules: [{ id: "injection", description: "d" }],
		paths: ["**"],
		scope: "",
		budget: { findings: 5 },
		standards: true,
		instructions: "i",
		version: "000000000000",
		file: "f",
		...overrides,
	});
	const config = (lenses: MelianConfig["lenses"]): MelianConfig => ({ ...defaultConfig, lenses });

	it("keeps a lens whose paths select a changed file, dotfiles included", () => {
		expect(selectLenses([lens({})], defaultConfig, [".github/workflows/ci.yml"])).toHaveLength(1);
		expect(
			selectLenses([lens({ paths: ["src/**", "!src/**/*.test.ts"] })], defaultConfig, ["src/a.test.ts"]),
		).toEqual([]);
	});

	it("selects a file whose name holds a newline, so no name hides a file from review", () => {
		const forged = "src/evil\n- added src/forged.ts";
		expect(selectLenses([lens({})], defaultConfig, [forged])).toHaveLength(1);
		expect(selectLenses([lens({ paths: ["src/*.ts"] })], defaultConfig, ["src/evil\nname.ts"])).toHaveLength(1);
	});

	it("keeps a folder's lens to its folder", () => {
		const scoped = lens({ scope: "services/pay", paths: ["services/pay/**"] });
		expect(selectLenses([scoped], defaultConfig, ["src/a.ts"])).toEqual([]);
		expect(selectLenses([scoped], defaultConfig, ["services/pay/a.ts"])).toHaveLength(1);
	});

	it("gives a folder's files to the nearest lens of a name, and each lens only the files it covers", () => {
		const root = lens({});
		const pay = lens({ scope: "services/pay", paths: ["services/pay/**"], version: "111111111111" });
		const paths = ["src/a.ts", "services/pay/api.ts", "services/pay/db.ts"];
		const selected = selectLenses([root, pay], defaultConfig, paths);
		expect(selected.map(({ lens, files }) => [lens.scope, files])).toEqual([
			["", ["src/a.ts"]],
			["services/pay", ["services/pay/api.ts", "services/pay/db.ts"]],
		]);
		expect(selected[0]!.coverage).toEqual({ scope: "", paths: ["**"], nearer: ["services/pay"] });
		expect(lensCovers(selected[0]!.coverage, "services/pay/api.ts")).toBe(false);
		expect(lensCovers(selected[0]!.coverage, "lib/other.ts")).toBe(true);
	});

	it("applies configuration: disabled, retiered, narrowed", () => {
		expect(selectLenses([lens({})], config({ security: { enabled: false } }), ["src/a.ts"])).toEqual([]);
		const [retiered] = selectLenses([lens({})], config({ security: { tier: "heavy" } }), ["src/a.ts"]);
		expect(retiered!.lens.tier).toBe("heavy");
		expect(retiered!.lens.version).not.toBe("000000000000");
		expect(selectLenses([lens({})], config({ security: { paths: ["docs/**"] } }), ["src/a.ts"])).toEqual([]);
	});
});

describe("renderLensInstructions", () => {
	it("appends standards under their paths unless the lens opts out", async () => {
		const [, correctness] = await loadLenses(repo, { kind: "worktree" }, []);
		const standards = [{ path: "AGENTS.md", content: "Use tabs.\n" }];
		const rendered = renderLensInstructions(correctness!, standards);
		expect(rendered.startsWith(correctness!.instructions)).toBe(true);
		expect(rendered).toContain("### AGENTS.md\n\nUse tabs.");
		expect(renderLensInstructions({ ...correctness!, standards: false }, standards)).not.toContain("AGENTS.md");
	});

	it("renders every declared rule ID, the severities, and the budget after the body", async () => {
		for (const lens of await loadLenses(repo, { kind: "worktree" }, [])) {
			const rendered = renderLensInstructions(lens, []);
			const policy = rendered.slice(lens.instructions.length);
			for (const rule of lens.rules) expect(policy).toContain(`- \`${rule.id}\`: ${rule.description}`);
			expect(policy).toContain(`Severities you may report: ${lens.severities.join(", ")}.`);
			expect(policy).toContain(`Budget: at most ${lens.budget.findings} findings.`);
		}
	});

	it("tells every lens, its own or a repository's, to supply a failure scenario and evidence", async () => {
		for (const lens of await loadLenses(repo, { kind: "worktree" }, [])) {
			const policy = renderLensInstructions(lens, []).slice(lens.instructions.length);
			expect(policy).toContain("## Failure scenario and evidence");
			expect(policy).toContain("`failureScenario`: the concrete input, state, or sequence of calls");
			expect(policy).toContain("`role` is `cause` for the code that brings the failure about");
			expect(policy).toContain('Add `revision: "base"` for lines this change deleted');
		}
	});
});

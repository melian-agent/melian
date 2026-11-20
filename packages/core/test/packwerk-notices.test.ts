import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Changeset, EnolaFacts, type Finding, loadConfig } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateGuardrails, packwerkNotices } from "../src/guardrails.ts";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

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

function commit(
	files: Record<string, string>,
	message: string,
	remove: string[] = [],
	links: Record<string, string> = {},
): string {
	writeFiles(repo, files);
	for (const path of remove) gitIn(repo, "rm", "--quiet", path);
	for (const [path, target] of Object.entries(links)) {
		rmSync(join(repo, path), { recursive: true, force: true });
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		symlinkSync(target, join(repo, path));
	}
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "--allow-empty", "-m", message);
	return gitIn(repo, "rev-parse", "HEAD");
}

const packwerk = lines('include: ["**/*.rb"]', 'package_paths: ["packs/*"]');
const enforcing = lines("enforce_dependencies: true");
const packages = {
	"packwerk.yml": packwerk,
	"packs/a/package.yml": enforcing,
	"packs/b/package.yml": enforcing,
	"packs/a/app/models/alpha.rb": lines("class Alpha", "end"),
};
// What Enola's facts name for `packages`: each package's package.yml and package_todo.yml, and packwerk.yml beside them.
const read = [
	"packs/a/package.yml",
	"packs/a/package_todo.yml",
	"packs/b/package.yml",
	"packs/b/package_todo.yml",
	"packwerk.yml",
];
const enola = { check: "static.enola", version: "0.4.40" };

async function notices(
	base: Record<string, string>,
	head: Record<string, string>,
	options: {
		read?: string[];
		remove?: string[];
		source?: Parameters<typeof packwerkNotices>[2];
		baseLinks?: Record<string, string>;
		headLinks?: Record<string, string>;
	} = {},
) {
	const baseCommit = commit(base, "base", [], options.baseLinks);
	const headCommit = commit(head, "head", options.remove, options.headLinks);
	const { revision } = await Changeset.resolve(repo, `${baseCommit}..${headCommit}`);
	const input = { repoRoot: repo, revision, source: { kind: "revision", commit: baseCommit } as const };
	return { input, findings: await packwerkNotices(input, options.read ?? read, options.source ?? enola) };
}

function summary(findings: readonly Finding[]) {
	return findings.map((finding) => [
		finding.properties.path,
		finding.properties.severity,
		finding.properties.source,
		finding.message.text,
		finding.properties.explanation.what,
	]);
}

async function resolveAt(finding: Finding, path: string, base: string) {
	const { config, resolutionLayers } = await loadConfig(repo, { kind: "revision", commit: base }, path);
	return finding.resolve({ resolution: config.resolution, layers: resolutionLayers });
}

describe("packwerkNotices", () => {
	it("notices a head that turns enforce_dependencies off, at acknowledge under Melian's own table", async () => {
		const { findings, input } = await notices(packages, {
			"packs/a/package.yml": lines("enforce_dependencies: false"),
		});
		expect(summary(findings)).toEqual([
			[
				"packs/a/package.yml",
				"P2",
				enola,
				"Review the change to packs/a/package.yml, which configures Enola's Packwerk check.",
				"This revision changes packs/a/package.yml, which configures Enola's Packwerk check.",
			],
		]);
		expect(findings[0]!.properties.guardrail).toEqual({ notice: "analyser" });
		expect(findings[0]!.ruleId).toBe("guardrail/policy-change-review");
		expect(await resolveAt(findings[0]!, "packs/a/package.yml", input.revision.base)).toBe("acknowledge");
	});

	it("notices a head that deletes packwerk.yml", async () => {
		const { findings } = await notices(packages, {}, { remove: ["packwerk.yml"] });
		expect(summary(findings)).toEqual([
			[
				"packwerk.yml",
				"P2",
				enola,
				"Review the change to packwerk.yml, which configures Enola's Packwerk check.",
				"This revision changes packwerk.yml, which configures Enola's Packwerk check. The head deletes packwerk.yml.",
			],
		]);
	});

	it("notices a head that moves package_paths", async () => {
		const { findings } = await notices(packages, {
			"packwerk.yml": lines('include: ["**/*.rb"]', 'package_paths: ["components/*"]'),
		});
		expect(findings.map((finding) => [finding.properties.path, finding.properties.severity])).toEqual([
			["packwerk.yml", "P2"],
		]);
	});

	it("notices each changed file once, in path order, whatever order Enola's facts gave", async () => {
		const { findings } = await notices(
			packages,
			{
				"packwerk.yml": lines('package_paths: ["components/*"]'),
				"packs/b/package.yml": lines("enforce_dependencies: false"),
			},
			{ read: ["packwerk.yml", "packs/b/package.yml", "packwerk.yml"] },
		);
		expect(findings.map((finding) => finding.properties.path)).toEqual(["packs/b/package.yml", "packwerk.yml"]);
	});

	it("draws nothing in a repository with no Packwerk module, or for a file Enola did not read", async () => {
		const none = await notices(
			packages,
			{ "packs/a/package.yml": lines("enforce_dependencies: false") },
			{ read: [] },
		);
		expect(none.findings).toEqual([]);
		const unread = await notices(
			{ ...packages, "lib/c/package.yml": enforcing },
			{ "lib/c/package.yml": lines("enforce_dependencies: false"), "packs/a/app/models/alpha.rb": lines("class A") },
		);
		expect(unread.findings).toEqual([]);
	});

	it("follows the folder's policy-change-review switch and its severity", async () => {
		const off = await notices(
			{ ...packages, "melian.yaml": lines("guardrails:", "  policy-change-review:", "    enabled: false") },
			{ "packs/a/package.yml": lines("enforce_dependencies: false") },
		);
		expect(off.findings).toEqual([]);
		const strict = await notices(
			{
				...packages,
				"melian.yaml": lines(
					"guardrails:",
					"  policy-change-review:",
					"    severity: P1",
					"    analyserSeverity: P3",
				),
			},
			{ "packs/a/package.yml": lines("enforce_dependencies: false") },
		);
		expect(strict.findings.map((finding) => finding.properties.severity)).toEqual(["P1"]);
	});

	it("resolves, and keys its ID, as the guardrails check's own notice does, not by the check that raised it", async () => {
		const keyed = lines(
			"resolution:",
			"  checks:",
			"    guardrails:",
			"      rules:",
			"        guardrail/policy-change-review/analyser: { P2: block }",
			"    static.enola: { ceiling: silent }",
		);
		const head = { "packs/a/package.yml": lines("enforce_dependencies: false") };
		const { findings, input } = await notices({ ...packages, "melian.yaml": keyed }, head);
		const raised = findings[0]!;
		const guardrailSourced = await packwerkNotices(input, read, { check: "guardrails" });
		expect(raised.id).toBe(guardrailSourced[0]!.id);
		expect(await resolveAt(raised, "packs/a/package.yml", input.revision.base)).toBe("block");
		expect(await resolveAt(guardrailSourced[0]!, "packs/a/package.yml", input.revision.base)).toBe("block");
		// The guardrails check does not raise it: it never sees Enola's facts.
		const { findings: own } = await evaluateGuardrails(input);
		expect(own.filter((finding) => finding.properties.path === "packs/a/package.yml")).toEqual([]);
	});

	it.each([
		["Enola's table blocks while the guardrails table quietens", "static.enola", "guardrails"],
		["the guardrails table blocks while Enola's quietens", "guardrails", "static.enola"],
	])("resolves under its own check and the guardrail's both, the stricter standing: %s", async (_, blocks, quiet) => {
		const policy = lines("resolution:", "  checks:", `    ${blocks}: { P2: block }`, `    ${quiet}: { P2: silent }`);
		const head = { "packs/a/package.yml": lines("enforce_dependencies: false") };
		const { findings, input } = await notices({ ...packages, "melian.yaml": policy }, head);
		expect(await resolveAt(findings[0]!, "packs/a/package.yml", input.revision.base)).toBe("block");
	});

	it("lets the class entry decide a notice the guardrails check raised itself, over its whole guardrail's", async () => {
		const policy = lines(
			"resolution:",
			"  checks:",
			"    guardrails:",
			"      rules:",
			"        guardrail/policy-change-review: { P2: block }",
			"        guardrail/policy-change-review/analyser: { P2: silent }",
		);
		const head = { "packs/a/package.yml": lines("enforce_dependencies: false") };
		const { findings, input } = await notices({ ...packages, "melian.yaml": policy }, head, {
			source: { check: "guardrails" },
		});
		expect(await resolveAt(findings[0]!, "packs/a/package.yml", input.revision.base)).toBe("silent");
	});

	it("notices a head that records its own new violation in package_todo.yml", async () => {
		const todo = lines("---", "packs/b:", '  "::Beta":', "    violations:", "    - dependency", "    files:");
		const { findings } = await notices(packages, {
			"packs/a/package_todo.yml": lines(todo, "    - packs/a/app/models/alpha.rb"),
			"packs/a/app/models/alpha.rb": lines("class Alpha", "  def f = Beta.new", "end"),
		});
		expect(summary(findings)).toEqual([
			[
				"packs/a/package_todo.yml",
				"P2",
				enola,
				"Review the change to packs/a/package_todo.yml, which configures Enola's Packwerk check.",
				"This revision changes packs/a/package_todo.yml, which configures Enola's Packwerk check.",
			],
		]);
	});

	const shared = { "lib/c/package.yml": enforcing, "lib/shared.yml": enforcing };
	const linkedRead = [...read, "packs/c/package.yml", "packs/c/package_todo.yml"];
	const linkNote = (path: string) =>
		`${path} reaches Enola through a symbolic link, so Melian cannot tell whether this change altered it.`;
	it.each([
		[
			"a head that makes a Packwerk file a link",
			{
				head: { "lib/shared.yml": lines("enforce_dependencies: false") },
				headLinks: { "packs/b/package.yml": "../../lib/shared.yml" },
			},
			["packs/b/package.yml"],
		],
		[
			"a head that adds a directory link to a package",
			{ head: { "lib/c/package.yml": lines("enforce_dependencies: false") }, headLinks: { "packs/c": "../lib/c" } },
			["packs/c/package.yml", "packs/c/package_todo.yml"],
		],
		[
			"a head that edits the target of a directory link the base holds",
			{
				head: { "lib/c/package.yml": lines("enforce_dependencies: false") },
				baseLinks: { "packs/c": "../lib/c" },
			},
			["packs/c/package.yml", "packs/c/package_todo.yml"],
		],
		[
			"a head that edits the target of a file link the base holds",
			{
				head: { "lib/shared.yml": lines("enforce_dependencies: false") },
				baseLinks: { "packs/b/package.yml": "../../lib/shared.yml" },
			},
			["packs/b/package.yml"],
		],
	])("notices %s, saying it cannot tell what changed", async (_, shape, paths) => {
		const { findings } = await notices({ ...packages, ...shared }, shape.head, {
			read: linkedRead,
			...("baseLinks" in shape ? { baseLinks: shape.baseLinks } : {}),
			...("headLinks" in shape ? { headLinks: shape.headLinks } : {}),
		});
		expect(findings.map((finding) => finding.properties.path)).toEqual(paths);
		for (const finding of findings) {
			expect(finding.properties.explanation.what).toContain(linkNote(finding.properties.path));
			expect(finding.properties.severity).toBe("P2");
		}
	});

	it("notices a link the base and head both hold on every change, though the change touches nothing there", async () => {
		const { findings } = await notices(
			{ ...packages, ...shared },
			{ "packs/a/app/models/alpha.rb": lines("class Alpha", "  def g; end", "end") },
			{ read: linkedRead, baseLinks: { "packs/c": "../lib/c" } },
		);
		expect(summary(findings)[0]).toEqual([
			"packs/c/package.yml",
			"P2",
			enola,
			"Review packs/c/package.yml, which configures Enola's Packwerk check through a symbolic link.",
			`packs/c/package.yml configures Enola's Packwerk check. ${linkNote("packs/c/package.yml")}`,
		]);
		expect(findings.map((finding) => finding.properties.path)).toEqual([
			"packs/c/package.yml",
			"packs/c/package_todo.yml",
		]);
		expect(findings[0]!.properties.explanation.whatToDo).toBe(
			"Have a maintainer read packs/c/package.yml and what its link points to, or replace the link with the file itself.",
		);
	});

	it("draws nothing for a link that holds no Packwerk file Enola read, or only shares a name's prefix", async () => {
		const { findings } = await notices(
			{ ...packages, ...shared },
			{ "packs/a/app/models/alpha.rb": lines("class Alpha", "  def g; end", "end") },
			{ baseLinks: { "packs/ab": "../lib/c", "docs/c": "../lib/c" } },
		);
		expect(findings).toEqual([]);
	});
});

describe("EnolaFacts.packwerkFiles", () => {
	const fact = (fields: Record<string, unknown>) => JSON.stringify({ id: String(Math.random()), ...fields });
	it("names each Packwerk module's package.yml and package_todo.yml, and packwerk.yml, and nothing without one", () => {
		const facts = EnolaFacts.parse(
			[
				fact({ kind: "module", name: "packs/b", file: "packs/b/package.yml", props: { packwerk: true } }),
				fact({ kind: "module", name: "packs/a", file: "packs/a/package.yml", props: { packwerk: true } }),
				fact({ kind: "module", name: "src", file: "src/index.ts", props: { packwerk: false } }),
				fact({ kind: "module", name: "lib", file: "lib/package.yml" }),
				fact({ kind: "symbol", name: "Alpha", file: "packs/c/package.yml", props: { packwerk: true } }),
				fact({ kind: "module", name: "packs/d", props: { packwerk: true } }),
			].join("\n"),
		);
		expect(facts.packwerkFiles()).toEqual([
			"packs/a/package.yml",
			"packs/a/package_todo.yml",
			"packs/b/package.yml",
			"packs/b/package_todo.yml",
			"packwerk.yml",
		]);
		expect(
			EnolaFacts.parse(
				fact({ kind: "module", name: "src", file: "src/a.ts", props: { packwerk: "yes" } }),
			).packwerkFiles(),
		).toEqual([]);
	});
});

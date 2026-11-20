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

function commit(files: Record<string, string>, message: string, remove: string[] = []): string {
	writeFiles(repo, files);
	for (const path of remove) gitIn(repo, "rm", "--quiet", path);
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
// What Enola's facts name for `packages`: each package's package.yml, and packwerk.yml beside them.
const read = ["packs/a/package.yml", "packs/b/package.yml", "packwerk.yml"];
const enola = { check: "static.enola", version: "0.4.40" };

async function notices(
	base: Record<string, string>,
	head: Record<string, string>,
	options: { read?: string[]; remove?: string[]; source?: typeof enola } = {},
) {
	const baseCommit = commit(base, "base");
	const headCommit = commit(head, "head", options.remove);
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
});

describe("EnolaFacts.packwerkFiles", () => {
	const fact = (fields: Record<string, unknown>) => JSON.stringify({ id: String(Math.random()), ...fields });
	it("names each Packwerk module's package.yml and packwerk.yml, and nothing without one", () => {
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
		expect(facts.packwerkFiles()).toEqual(["packs/a/package.yml", "packs/b/package.yml", "packwerk.yml"]);
		expect(
			EnolaFacts.parse(
				fact({ kind: "module", name: "src", file: "src/a.ts", props: { packwerk: "yes" } }),
			).packwerkFiles(),
		).toEqual([]);
	});
});

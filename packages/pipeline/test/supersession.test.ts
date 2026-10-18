import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Changeset, defaultConfig, loadConfig, Revision } from "@melian-agent/core";
import { DecisionFiles } from "@melian-agent/decisions";
import {
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	createReviewRegistry,
	dismissFinding,
	type Harness,
	openHarness,
	readFindings,
	revisionKey,
	runChecks,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SupersessionReview } from "../src/supersession.ts";
import { commit, createRepository, gitIn, removeRepository } from "./fixtures/repo.ts";

let repo: string;
let opened: Harness[];
const old = "docs/decisions/old.md";
const fresh = "docs/decisions/new.md";
const policy = "tiers:\n  full: [guardrails]\n";

beforeEach(() => {
	repo = createRepository();
	opened = [];
});
afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	removeRepository(repo);
});

async function review(base: string, head: string) {
	const fake = createFakeModels();
	const registry = createReviewRegistry();
	registry.install(checksExtension);
	const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry });
	opened.push(harness);
	const root = await harness.root(context, { agent: { model: fake.ref() } });
	const changeset = await Changeset.resolve(repo, `${base}..${head}`);
	const source = { kind: "revision", commit: base } as const;
	const { config } = await loadConfig(repo, source, "");
	const run = await runChecks(harness, { rootConversationId: root.id, changeset, config, source }, context);
	expect(fake.provider.state.callCount).toBe(0);
	return {
		records: run.records,
		findings: await readFindings(harness, root.id, revisionKey(changeset.revision), context),
	};
}

async function direct(base: string, head: string) {
	const changeset = await Changeset.resolve(repo, `${base}..${head}`);
	return new SupersessionReview({
		repoRoot: repo,
		revision: Revision.from(changeset.revision),
		source: { kind: "revision", commit: base },
	}).report();
}

type Golden = {
	base: Record<string, string>;
	head: Record<string, string>;
	expect: { findings: number; missing?: number; status: "ran" | "failed" };
};

describe("supersession guardrail", { timeout: 60_000 }, () => {
	it("does not associate an untouched successor with another file's rename", async () => {
		const base = commit(repo, {
			[old]: "Keep the rule.",
			"docs/decisions/untouched.md": "Supersedes: old.md",
			"a-before.md": "Unrelated text.",
		});
		gitIn(repo, "mv", "a-before.md", "a-after.md");
		const head = commit(repo, { [fresh]: "Supersedes: old.md" });
		const report = await direct(base, head);
		expect(report.findings.map((finding) => finding.properties.path)).toEqual([fresh]);
		expect(report.notes).toEqual([]);
	});

	it("does not use an unrelated rename as the target's baseline", async () => {
		const base = commit(repo, { [old]: "Keep the target rule.", "a-before.md": "Unrelated text." });
		gitIn(repo, "mv", "a-before.md", "a-after.md");
		const head = commit(repo, { [fresh]: "Supersedes: old.md" });
		const report = await direct(base, head);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]!.properties.evidence).toMatchObject([
			{ file: old, snippet: "Keep the target rule.", revision: "base" },
		]);
		expect(report.findings[0]!.properties.explanation.whyHere).toContain("Keep the target rule.");
	});

	it.each(["\r", "\r\n", "\n"])("places a declaration on its LF source line for %j endings", async (ending) => {
		const base = commit(repo, { [old]: "Keep the rule." });
		const head = commit(repo, { [fresh]: ["# New", "", "Supersedes: old.md"].join(ending) });
		const finding = (await direct(base, head)).findings[0]!;
		expect(finding.locations[0]!.physicalLocation.region.startLine).toBe(ending === "\r" ? 1 : 3);
	});
	it.each(["dropped-clause", "every-clause-restated", "nowhere-target", "active-amendment", "late-link-context"])(
		"golden: %s",
		async (name) => {
			const golden = JSON.parse(
				readFileSync(new URL(`golden/supersession/${name}.json`, import.meta.url), "utf8"),
			) as Golden;
			const base = commit(repo, { "melian.yaml": policy, ...golden.base });
			const head = commit(repo, golden.head);
			const { records, findings } = await review(base, head);
			expect(records[0]!.status).toBe(golden.expect.status);
			expect(findings).toHaveLength(golden.expect.findings);
			if (golden.expect.missing !== undefined) {
				expect(findings[0]!.properties).toMatchObject({
					severity: "P3",
					path: fresh,
					source: { check: "guardrails" },
					cause: "introduced",
				});
				expect(findings[0]!.ruleId).toBe("guardrail/supersession-drop");
				expect(findings[0]!.locations[0]!.physicalLocation.region.startLine).toBe(3);
				expect(findings[0]!.properties.explanation.whyHere).toContain(
					`${golden.expect.missing} uncarried clause(s)`,
				);
			}
			if (name === "dropped-clause") {
				expect(findings[0]!.properties.explanation.whyHere).toContain("Keep the retry limit.");
				expect(findings[0]!.properties.evidence).toMatchObject([
					{ file: old, startLine: 3, revision: "base", role: "context" },
				]);
			}
			if (name === "active-amendment")
				expect((await DecisionFiles.load(repo, head)).render()).toContain(`[ACTIVE; amended by ${fresh}] ${old}`);
			if (name === "late-link-context")
				expect((await DecisionFiles.load(repo, head)).render()).toContain("[ACTIVE] docs/decisions/context.md");
		},
	);

	it("accepts its enabled switch and per-rule resolution policy", async () => {
		const base = commit(repo, {
			"melian.yaml": `${policy}guardrails:\n  supersession-drop: { enabled: false }\nresolution:\n  checks:\n    guardrails:\n      rules:\n        guardrail/supersession-drop: { P3: block }\n`,
			[old]: "# Old\n\nKeep the timeout.\n",
		});
		const source = { kind: "revision", commit: base } as const;
		const { config } = await loadConfig(repo, source, fresh);
		expect(config.guardrails["supersession-drop"].enabled).toBe(false);
		const head = commit(repo, { [fresh]: "# New\n\nSupersedes: old.md\n" });
		expect((await review(base, head)).findings).toEqual([]);
	});

	it("defaults to enabled and honours the notice's per-rule requirement", async () => {
		expect(defaultConfig.guardrails["supersession-drop"]).toEqual({ enabled: true });
		const base = commit(repo, {
			[old]: "Keep the rule.",
			"melian.yaml": `${policy}resolution:\n  checks:\n    guardrails:\n      rules:\n        guardrail/supersession-drop: { P3: block }\n`,
		});
		const head = commit(repo, { [fresh]: "Supersedes: old.md" });
		const { config, resolutionLayers } = await loadConfig(repo, { kind: "revision", commit: base }, fresh);
		const finding = (await direct(base, head)).findings[0]!;
		expect(finding.resolve({ resolution: config.resolution, layers: resolutionLayers })).toBe("block");
	});

	it("skips validation when every changed decision is under the off switch", async () => {
		const base = commit(repo, {
			"melian.yaml": `${policy}guardrails:\n  supersession-drop: { enabled: false }\n`,
			[old]: "Old rule.",
		});
		const head = commit(repo, { [fresh]: "Supersedes: absent.md" });
		expect((await review(base, head)).records[0]!.status).toBe("ran");
	});

	it("applies the enabled switch per declaring path in a mixed change", async () => {
		const base = commit(repo, {
			"melian.yaml": policy,
			"docs/decisions/quiet/melian.yaml": "guardrails:\n  supersession-drop: { enabled: false }\n",
			[old]: "Old rule.",
		});
		const head = commit(repo, {
			[fresh]: "Supersedes: old.md",
			"docs/decisions/quiet/new.md": "Supersedes: ../old.md",
		});
		const report = await direct(base, head);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]!.properties.path).toBe(fresh);
	});

	it("refuses a non-boolean enabled value", async () => {
		const base = commit(repo, { "melian.yaml": "guardrails:\n  supersession-drop: { enabled: sometimes }\n" });
		await expect(loadConfig(repo, { kind: "revision", commit: base }, fresh)).rejects.toMatchObject({
			code: "invalidValue",
		});
	});

	it.each(["body", "target", "late context", "declaring rename"])(
		"does not repeat an unchanged edge after a %s change",
		async (change) => {
			const declaration = "# New\n\nSupersedes: old.md. Context stays.\n\nKeep the rule.";
			const base = commit(repo, { [old]: "Keep the rule.", [fresh]: declaration });
			let head: string;
			if (change === "declaring rename") {
				gitIn(repo, "mv", fresh, "docs/decisions/renamed.md");
				head = commit(repo, {});
			} else
				head = commit(
					repo,
					change === "target"
						? { [old]: "Changed target." }
						: {
								[fresh]: declaration.replace(
									change === "body" ? "Keep the rule." : "Context stays.",
									"Changed text.",
								),
							},
				);
			expect((await direct(base, head)).findings).toEqual([]);
		},
	);

	it.each(["Supersedes", "Amends"])("notices an existing %s declaration changed to whole retirement", async (kind) => {
		const base = commit(repo, { [old]: "Keep the rule.", [fresh]: `${kind}: old.md, for routing.` });
		const head = commit(repo, { [fresh]: "Supersedes: old.md, whole retirement." });
		expect((await direct(base, head)).findings).toHaveLength(1);
	});

	it("reopens a dismissed retirement notice after its declaration changes", async () => {
		const base = commit(repo, { [old]: "Keep the rule." });
		const head = commit(repo, { [fresh]: "Supersedes: old.md, for routing." });
		const first = (await direct(base, head)).findings[0]!;
		const firstRevision = revisionKey({ base, head });
		const fake = createFakeModels();
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
		opened.push(harness);
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		await root.commit((tx) => upsertFinding(tx, root.id, first, firstRevision), context);
		const dismissal = { by: "Maintainer", at: "2026-10-18T00:00:00Z", reason: "Routing retirement accepted." };
		await root.commit((tx) => dismissFinding(tx, root.id, first.id, dismissal, firstRevision), context);
		expect((await readFindings(harness, root.id, firstRevision, context))[0]!.properties).toMatchObject({
			status: "dismissed",
			dismissal,
		});

		const unchangedHead = commit(repo, { "other.txt": "Unrelated push." });
		const unchanged = (await direct(base, unchangedHead)).findings[0]!;
		const unchangedRevision = revisionKey({ base, head: unchangedHead });
		await root.commit((tx) => upsertFinding(tx, root.id, unchanged, unchangedRevision), context);
		expect((await readFindings(harness, root.id, unchangedRevision, context))[0]!.properties.status).toBe(
			"dismissed",
		);

		const editedHead = commit(repo, { [fresh]: "Supersedes: old.md, whole retirement." });
		const edited = (await direct(base, editedHead)).findings[0]!;
		const editedRevision = revisionKey({ base, head: editedHead });
		expect(edited.id).toBe(first.id);
		expect.soft(edited.properties.trigger!.hash).not.toBe(first.properties.trigger!.hash);
		await root.commit((tx) => upsertFinding(tx, root.id, edited, editedRevision), context);
		const reopened = (await readFindings(harness, root.id, editedRevision, context))[0]!;
		expect(reopened.properties.status).toBe("new");
		expect(reopened.properties.dismissal).toBeUndefined();
		expect(reopened.properties.pastDismissals).toEqual([{ ...dismissal, reopenedRevision: editedRevision }]);
		expect(fake.provider.state.callCount).toBe(0);
	});

	it("uses a same-change target's head text", async () => {
		const base = commit(repo, { "readme.md": "Base." });
		const head = commit(repo, { [old]: "Keep the new rule.", [fresh]: "Supersedes: old.md" });
		const finding = (await direct(base, head)).findings[0]!;
		expect(finding.properties.explanation.whyHere).toContain("Keep the new rule.");
		expect(finding.properties.evidence?.[0]?.revision).toBe("head");
	});

	it("notices a relative target changed by moving the declaring file", async () => {
		const base = commit(repo, {
			[old]: "First target.",
			"docs/decisions/nested/old.md": "Second target.",
			[fresh]: "Supersedes: old.md",
		});
		gitIn(repo, "mv", fresh, "docs/decisions/nested/new.md");
		const head = commit(repo, {});
		const report = await direct(base, head);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]!.message.text).toContain("docs/decisions/nested/old.md");
	});

	it("uses an edited target's base text", async () => {
		const base = commit(repo, { [old]: "Keep the old rule." });
		const head = commit(repo, { [old]: "New target text.", [fresh]: "Supersedes: old.md\n\nNew target text." });
		const finding = (await direct(base, head)).findings[0]!;
		expect(finding.properties.explanation.whyHere).toContain("Keep the old rule.");
		expect(finding.properties.evidence?.[0]?.revision).toBe("base");
	});

	it("follows Git's old target path for a rename", async () => {
		const content = `${"Stable context. ".repeat(50)}Keep the old rule.`;
		const base = commit(repo, { [old]: content });
		gitIn(repo, "mv", old, "docs/decisions/moved.md");
		const head = commit(repo, {
			"docs/decisions/moved.md": content.replace("Keep the old rule.", "New target rule."),
			[fresh]: `Supersedes: moved.md\n\n${content.replace("Keep the old rule.", "New target rule.")}`,
		});
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		expect(changeset.revision.files.find((file) => file.path === "docs/decisions/moved.md")?.oldPath).toBe(old);
		const finding = (await direct(base, head)).findings[0]!;
		expect(finding.properties.explanation.whyHere).toContain("Keep the old rule.");
		expect(finding.properties.evidence?.[0]?.file).toBe(old);
	});

	it("compares only the direct target in a chain", async () => {
		const base = commit(repo, {
			[old]: "Ancestor rule.",
			"docs/decisions/middle.md": "Supersedes: old.md\n\nDirect rule.",
		});
		const head = commit(repo, { [fresh]: "Supersedes: middle.md\n\nDirect rule." });
		const report = await direct(base, head);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]!.properties.explanation.whyHere).toContain("0 uncarried clause(s)");
		expect(report.findings[0]!.properties.explanation.whyHere).not.toContain("Ancestor rule.");
	});

	it("reports each direct target once, including a target without comparable prose", async () => {
		const base = commit(repo, { [old]: "# Empty", "docs/decisions/other.md": "Other rule." });
		const head = commit(repo, { [fresh]: "Supersedes: old.md, other.md, old.md\n\nSupersedes: old.md" });
		const report = await direct(base, head);
		expect(report.findings).toHaveLength(2);
		expect(new Set(report.findings.map((finding) => finding.id)).size).toBe(2);
		expect(
			report.findings.find((finding) => finding.message.text.includes(old))!.properties.explanation.whyHere,
		).toContain("no comparable prose");
	});

	it("does not validate an untouched decision graph for a change elsewhere", async () => {
		const base = commit(repo, { [fresh]: "Supersedes: absent.md", "file.ts": "export const value = 1;" });
		const head = commit(repo, { "file.ts": "export const value = 2;" });
		expect((await direct(base, head)).findings).toEqual([]);
	});

	it.each(["deletion", "rename out"])("fails a graph with a missing target after %s", async (change) => {
		const base = commit(repo, { [old]: "Old rule.", [fresh]: "Supersedes: old.md" });
		if (change === "rename out") gitIn(repo, "mv", old, "outside.md");
		const head = commit(repo, {}, change === "deletion" ? [old] : []);
		expect((await review(base, head)).records[0]).toMatchObject({ status: "failed", reason: "invalid" });
	});

	it("fails a mixed amendment cycle", async () => {
		const base = commit(repo, { [old]: "Old rule." });
		const head = commit(repo, { [fresh]: "Supersedes: old.md", [old]: "Amends: new.md, routing." });
		expect((await review(base, head)).records[0]).toMatchObject({ status: "failed", reason: "invalid" });
	});

	it("refuses a symlinked head decision", async () => {
		const base = commit(repo, { [old]: "Old rule." });
		symlinkSync("old.md", join(repo, fresh));
		const head = commit(repo, {});
		expect((await review(base, head)).records[0]).toMatchObject({ status: "failed" });
	});

	it.each([256 * 1024, 256 * 1024 + 1])("enforces the decision file bound at %s bytes", async (bytes) => {
		const base = commit(repo, { "readme.md": "Base." });
		const head = commit(repo, { [old]: "x".repeat(bytes), [fresh]: "Supersedes: old.md" });
		const result = await review(base, head);
		expect(result.records[0]!.status).toBe(bytes === 256 * 1024 ? "ran" : "failed");
	});

	it.each([256 * 1024, 256 * 1024 + 1])("enforces the base target bound at %s bytes", async (bytes) => {
		const base = commit(repo, { [old]: "x".repeat(bytes) });
		const head = commit(repo, { [old]: "Edited target.", [fresh]: "Supersedes: old.md" });
		expect((await review(base, head)).records[0]!.status).toBe(bytes === 256 * 1024 ? "ran" : "failed");
	});

	it.each([60, 61])("bounds structured paragraph evidence at %s source lines", async (lines) => {
		const base = commit(repo, { [old]: `${Array.from({ length: lines }, () => "a word").join("\n")}.` });
		const head = commit(repo, { [fresh]: "Supersedes: old.md" });
		const finding = (await direct(base, head)).findings[0]!;
		expect(finding.properties.evidence?.[0]?.endLine).toBe(60);
	});

	it("counts the full missing list before bounding its display", async () => {
		const base = commit(repo, { [old]: Array.from({ length: 1000 }, (_, i) => `Keep obligation ${i}.`).join(" ") });
		const head = commit(repo, { [fresh]: "Supersedes: old.md" });
		const text = (await direct(base, head)).findings[0]!.properties.explanation.whyHere;
		expect(text).toContain("1000 uncarried clause(s)");
		expect(text).toContain("[cut at 2 KiB]");
		expect(Buffer.byteLength(text)).toBeLessThan(2200);
	});

	it("keeps sentence evidence out of the notice's identity and trigger", async () => {
		const declaration = "Supersedes: old.md\n\nReplacement.";
		const base = commit(repo, { [old]: "First rule." });
		const head = commit(repo, { [fresh]: declaration });
		const first = (await direct(base, head)).findings[0]!;
		const nextBase = commit(repo, { [old]: "Second rule. Third rule." }, [fresh]);
		const nextHead = commit(repo, { [fresh]: declaration });
		const second = (await direct(nextBase, nextHead)).findings[0]!;
		expect(first.properties.explanation.whyHere).toContain("1 uncarried clause(s)");
		expect(second.properties.explanation.whyHere).toContain("2 uncarried clause(s)");
		expect(first.id).toBe(second.id);
		expect(first.properties.trigger).toEqual(second.properties.trigger);
		expect(second.resolve({ resolution: defaultConfig.resolution })).toBe("advisory");
	});
});

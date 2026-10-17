import { rmSync } from "node:fs";
import { Adjudication, Changeset, defaultConfig, evaluateGuardrails, snippetHash } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	dismissFinding,
	openHarness,
	readFindings,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";
import { baseAndHead, commit, gitIn } from "./fixtures/repo.ts";

it.each(["docs/melian.yaml", "biome.json"])(
	"reopens a dismissed notice when %s changes, but carries it across an unrelated push",
	async (file) => {
		const repo = baseAndHead({ [file]: "{}\n" }, { [file]: "# comment only\n{}\n" });
		const fake = createFakeModels();
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
		try {
			const root = await harness.root(context, { agent: { model: fake.ref() } });
			const notice = async () => {
				const { revision } = await Changeset.resolve(repo, "main...feature");
				const source = { kind: "revision" as const, commit: revision.base };
				const report = await evaluateGuardrails({ repoRoot: repo, revision, source });
				return { revision: revision.head, finding: report.findings.find((each) => each.properties.path === file)! };
			};
			const first = await notice();
			await root.commit((tx) => upsertFinding(tx, root.id, first.finding, first.revision), context);
			expect(
				new Adjudication({ findings: [first.finding], manifest: [], checks: [], config: defaultConfig })
					.adjudicate()
					.reviewStatus().state,
			).toBe("failure");
			const dismissal = { by: "Maintainer", at: "2026-10-17T00:00:00Z", reason: "Comment only." };
			await root.commit((tx) => dismissFinding(tx, root.id, first.finding.id, dismissal), context);
			const dismissed = await readFindings(harness, root.id, first.revision, context);
			expect(
				new Adjudication({ findings: dismissed, manifest: [], checks: [], config: defaultConfig })
					.adjudicate()
					.reviewStatus(),
			).toEqual({ state: "success", description: "0 findings, 1 dismissed" });
			commit(repo, { "other.txt": "unrelated\n" });
			const unchanged = await notice();
			await root.commit((tx) => upsertFinding(tx, root.id, unchanged.finding, unchanged.revision), context);
			expect((await readFindings(harness, root.id, unchanged.revision, context))[0]!.properties.status).toBe(
				"dismissed",
			);
			commit(repo, {
				[file]: file === "biome.json" ? '{"linter":{"enabled":false}}\n' : "resolution: { P2: advisory }\n",
			});
			const changed = await notice();
			expect(changed.finding.id).toBe(first.finding.id);
			await root.commit((tx) => upsertFinding(tx, root.id, changed.finding, changed.revision), context);
			const findings = await readFindings(harness, root.id, changed.revision, context);
			expect(findings[0]!.properties.status).toBe("new");
			expect(findings[0]!.properties.pastDismissals).toEqual([{ ...dismissal, reopenedRevision: changed.revision }]);
			expect(changed.finding.properties.trigger).toEqual({
				file,
				index: 0,
				hash: snippetHash(
					`blob:${gitIn(repo, "rev-parse", `main:${file}`)}:${gitIn(repo, "rev-parse", `HEAD:${file}`)}`,
				),
			});
			const verdict = new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig }).adjudicate();
			expect(verdict.dismissed).toHaveLength(0);
			expect(verdict.reviewStatus().state).toBe("failure");
		} finally {
			await harness.close(context);
			rmSync(repo, { recursive: true, force: true });
		}
	},
);

it("reopens a dismissal after merging main while keeping the head policy blob", async () => {
	const file = "services/pay/melian.yaml";
	const ours = "lenses: { correctness: { enabled: false } }\nstatic: { biome: { enabled: true } }\n";
	const repo = baseAndHead(
		{ "melian.yaml": "{}\n", [file]: "lenses: { correctness: { enabled: false } }\n" },
		{ [file]: ours },
	);
	const fake = createFakeModels();
	const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
	try {
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		const notice = async () => {
			const { revision } = await Changeset.resolve(repo, "main...feature");
			const report = await evaluateGuardrails({
				repoRoot: repo,
				revision,
				source: { kind: "revision", commit: revision.base },
			});
			return {
				revision: `${revision.base}..${revision.head}`,
				finding: report.findings.find((each) => each.properties.path === file)!,
			};
		};
		const first = await notice();
		const originalHeadBlob = gitIn(repo, "rev-parse", `HEAD:${file}`);
		await root.commit((tx) => upsertFinding(tx, root.id, first.finding, first.revision), context);
		const dismissal = { by: "Maintainer", at: "2026-10-18T00:00:00Z", reason: "Only enables Biome." };
		await root.commit((tx) => dismissFinding(tx, root.id, first.finding.id, dismissal, first.revision), context);
		expect((await readFindings(harness, root.id, first.revision, context))[0]!.properties.status).toBe("dismissed");

		gitIn(repo, "checkout", "--quiet", "main");
		commit(repo, { "unrelated.txt": "new base commit\n" });
		gitIn(repo, "checkout", "--quiet", "feature");
		gitIn(repo, "merge", "--quiet", "main", "-m", "merge unrelated base");
		const sameBlobs = await notice();
		await root.commit((tx) => upsertFinding(tx, root.id, sameBlobs.finding, sameBlobs.revision), context);
		expect((await readFindings(harness, root.id, sameBlobs.revision, context))[0]!.properties.status).toBe(
			"dismissed",
		);

		gitIn(repo, "checkout", "--quiet", "main");
		commit(repo, { [file]: "lenses: { correctness: { enabled: true } }\n" });
		gitIn(repo, "checkout", "--quiet", "feature");
		expect(() => gitIn(repo, "merge", "--quiet", "main", "-m", "merge changed policy")).toThrow();
		commit(repo, { [file]: ours });
		expect(gitIn(repo, "rev-parse", `HEAD:${file}`)).toBe(originalHeadBlob);
		expect(gitIn(repo, "show", `main:${file}`)).toContain("enabled: true");
		const changed = await notice();
		expect(changed.finding.id).toBe(first.finding.id);
		await root.commit((tx) => upsertFinding(tx, root.id, changed.finding, changed.revision), context);
		const findings = await readFindings(harness, root.id, changed.revision, context);
		expect(findings[0]!.properties.status).toBe("new");
		expect(findings[0]!.properties.pastDismissals).toEqual([{ ...dismissal, reopenedRevision: changed.revision }]);
		expect(
			new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig }).adjudicate().reviewStatus()
				.state,
		).toBe("failure");
	} finally {
		await harness.close(context);
		rmSync(repo, { recursive: true, force: true });
	}
});

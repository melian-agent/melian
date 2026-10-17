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
				hash: snippetHash(`blob:${gitIn(repo, "rev-parse", `HEAD:${file}`)}`),
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

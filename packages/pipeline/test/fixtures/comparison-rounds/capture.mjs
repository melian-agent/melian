// Copy to the historical source tree's root; run with --conditions=@melian-agent/source.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset, defaultConfig, ExternalFinding } from "./packages/core/src/index.ts";
import { backgroundContext as context, CompareHarness, createReviewRegistry, openHarness, openSqliteStorage, reviewChangeset } from "./packages/pipeline/src/index.ts";
import { createFakeModels } from "./packages/pipeline/src/testing.ts";
import { baseAndHead, gitIn } from "./packages/pipeline/test/fixtures/repo.ts";

const [output, commit, minted] = process.argv.slice(2);
mkdirSync(output, { recursive: true });
const repo = baseAndHead({ "a.ts": "export const n = 1;\n" }, { "a.ts": "export const n = 2;\n" });
const fake = createFakeModels();
const path = join(output, "comparisons.sqlite");
const external = ExternalFinding.create({ reviewer: { name: "codex" }, file: "a.ts", line: 1, title: "Check n", body: "n may be wrong", source: { kind: "file", path: "review.json", position: 0 } });
const revisions = [];
for (let i = 0; i < 2; i++) {
  if (i === 1 && minted !== "minted") gitIn(repo, "commit", "--quiet", "--allow-empty", "-m", "second head");
  const changeset = await Changeset.resolve(repo, "main...feature");
  const harness = await openHarness(await openSqliteStorage(path), { models: fake.models, registry: createReviewRegistry() });
  await harness.root(context, { agent: { model: fake.ref() } });
  await reviewChangeset({ harness, changeset, config: { ...defaultConfig, tiers: { full: ["static.mutation"] } }, lenses: [], standards: [], models: fake.review, checks: [{ name: "static.mutation", status: "ran", version: String(i) }] });
  await harness.close(context);
  revisions.push(changeset.revision);
  if (minted === "minted" && i === 0) continue;
  const compare = await CompareHarness.open(await openSqliteStorage(path), fake.review);
  await compare.importFindings(changeset.revision, [{ source: "file:review.json", imported: { findings: [external], skippedBodies: 0 } }], "2026-10-21T00:00:00Z");
  await compare.adjudicate(changeset.revision, external.id, { verdict: "noise", by: "Fixture", at: "2026-10-21T00:01:00Z" });
  await compare.adjudicate(changeset.revision, external.id, { verdict: "valid", reason: "no-owner", by: "Fixture", at: "2026-10-21T00:02:00Z" });
  await compare.close(context);
}
writeFileSync(join(output, "recorded.json"), JSON.stringify({ commit, revisions, external: external.id }, null, 2) + "\n");
rmSync(repo, { recursive: true, force: true });

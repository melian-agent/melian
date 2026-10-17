import { mkdirSync, writeFileSync } from "node:fs";
import { Adjudication, defaultConfig, Finding } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	openHarness,
	readFindings,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { VerdictDocument } from "../../../src/adjudication.ts";
import { FindingsDocument, upsertVerification } from "../../../src/findings.ts";
import { PublishedDocument } from "../../../src/publish.ts";

const fake = createFakeModels();
const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
const root = await harness.root(context);
const finding = Finding.create({
	rule: "fail-open",
	message: "A cold run reuses a kill.",
	file: "src/review.ts",
	startLine: 1,
	snippet: "incremental: true",
	occurrence: 0,
	cause: "introduced",
	severity: "P2",
	source: { check: "lens.trust-boundary", version: "1" },
	failureScenario: "A planted kill survives.",
	evidence: [{ file: "src/review.ts", startLine: 1, role: "cause", revision: "head", snippet: "incremental: true" }],
	explanation: { what: "A cold run reuses a kill.", whyHere: "It loads the cache.", whatToDo: "Rerun the mutant." },
});
const judgement = {
	verdict: "plausible",
	reason: "The head can plant it.",
	executor: "llm",
	model: "faux/judge",
	version: "1",
	lowered: { from: "P2", to: "P3", reason: "Needs hostile configuration." },
} as const;
await root.commit(async (tx) => {
	await upsertFinding(tx, root.id, finding, "base..head");
	await upsertVerification(tx, root.id, "base..head", finding.id, finding.properties.source, judgement);
}, context);
const findings = await readFindings(harness, root.id, "base..head", context);
const verdict = new Adjudication({ findings, config: defaultConfig, manifest: [], checks: [] }).adjudicate();
await root.commit(async (tx) => {
	(await tx.doc(VerdictDocument, root.id)).verdicts["base..head"] = verdict.toJSON();
	await tx.doc(PublishedDocument, root.id);
}, context);
const recorded = {
	recordedBy: "331c74d8db7696629652f641cef01065ae139c0d",
	versions: { findings: 8, verdicts: 9, published: 7 },
	findings: await harness.snapshot(FindingsDocument, root.id, context),
	verdicts: await harness.snapshot(VerdictDocument, root.id, context),
	published: await harness.snapshot(PublishedDocument, root.id, context),
};
mkdirSync("packages/pipeline/test/fixtures/step29-previous", { recursive: true });
writeFileSync("packages/pipeline/test/fixtures/step29-previous/review.json", `${JSON.stringify(recorded, null, 2)}\n`);
await harness.close(context);

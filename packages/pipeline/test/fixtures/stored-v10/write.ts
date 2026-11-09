import { Finding } from "@melian-agent/core";
import {
	backgroundContext as context,
	createRegistry,
	dismissFinding,
	openHarness,
	openSqliteStorage,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { FindingsDocument, upsertVerification } from "../../../src/findings.ts";

// Writes a version-10 findings document to the SQLite file named by the first argument, and prints its root's ID.
const [path] = process.argv.slice(2);
const fake = createFakeModels();
const harness = await openHarness(await openSqliteStorage(path!), { models: fake.models, registry: createRegistry() });
try {
	const root = await harness.root(context, { agent: { model: fake.ref() } });
	const finding = Finding.create({
		rule: "fail-open",
		file: "src/review.ts",
		startLine: 3,
		endLine: 4,
		snippet: "if (cached) {\n\treturn cached;",
		occurrence: 0,
		severity: "P2",
		cause: "introduced",
		message: "A cached kill is reused for a cold run.",
		source: { check: "lens.correctness", version: "1@careful" },
		explanation: { what: "Cached kill", whyHere: "Reused cache", whatToDo: "Rerun" },
		failureScenario: "A cold run reads a cached kill and reports the mutant killed.",
		evidence: [{ file: "src/review.ts", startLine: 3, role: "cause", revision: "head", snippet: "if (cached) {" }],
		trigger: { file: "src/review.ts", index: 0, snippet: "if (cached) {\n\treturn cached;" },
	});
	await root.commit(async (tx) => {
		await upsertFinding(tx, root.id, finding, "base..accepted");
		await upsertVerification(tx, root.id, "base..accepted", finding.id, finding.properties.source, {
			verdict: "confirmed",
			reason: "The cache is read before the cold flag.",
			answers: { code: "yes", guard: "no", base: "no" },
			executor: "llm",
			model: "faux/judge",
			version: "4190289e598badf0",
		});
		await dismissFinding(
			tx,
			root.id,
			finding.id,
			{
				by: "Maintainer <maintainer@melian.invalid>",
				at: "2026-11-08T00:00:00Z",
				reason: "Cold runs never read it.",
			},
			"base..accepted",
		);
	}, context);
	const snapshot = await harness.snapshot(FindingsDocument, root.id, context);
	process.stdout.write(
		`${JSON.stringify({ root: root.id, version: FindingsDocument.definition.version, findings: snapshot }, null, 2)}\n`,
	);
} finally {
	await harness.close(context);
}

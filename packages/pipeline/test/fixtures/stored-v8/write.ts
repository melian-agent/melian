import { Finding } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	dismissFinding,
	openHarness,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { FindingsDocument } from "../../../src/findings.ts";

// Run from main e0a9d00f, whose findings document is version 8.
const fake = createFakeModels();
const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
try {
	const root = await harness.root(context, { agent: { model: fake.ref() } });
	const report = (snippet: string) =>
		Finding.create({
			rule: "no-eval",
			file: "src/run.ts",
			startLine: 1,
			snippet: "eval(input)",
			occurrence: 0,
			severity: "P1",
			cause: "introduced",
			message: "Unsafe input",
			source: { check: "lens.security", version: "1" },
			explanation: { what: "Unsafe", whyHere: "New call", whatToDo: "Validate" },
			trigger: { file: "src/run.ts", index: 0, snippet },
		});
	const a = report("eval(input)");
	const b = report("eval(constant)");
	await root.commit(async (tx) => {
		await upsertFinding(tx, root.id, a, "A");
		await upsertFinding(tx, root.id, b, "B");
		await dismissFinding(tx, root.id, b.id, {
			by: "Maintainer",
			at: "2026-10-17T00:00:00Z",
			reason: "Constant input.",
		});
	}, context);
	process.stdout.write(
		`${JSON.stringify({ writtenBy: "e0a9d00f5ecd4bb25a642c815f921479bb4370c1", findings: await harness.snapshot(FindingsDocument, root.id, context) }, null, 2)}\n`,
	);
} finally {
	await harness.close(context);
}

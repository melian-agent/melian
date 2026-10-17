import { Finding, snippetHash } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	dismissFinding,
	openHarness,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { FindingsDocument, upsertVerification } from "../../../src/findings.ts";

const fake = createFakeModels();
const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
try {
	const root = await harness.root(context, { agent: { model: fake.ref() } });
	for (const cause of ["introduced", "affected"] as const) {
		const finding = Finding.create({
			rule: `fail-open-${cause}`,
			file: "src/review.ts",
			startLine: 1,
			snippet: "incremental: true",
			occurrence: 0,
			severity: "P2",
			cause,
			message: "A cold run reuses a planted kill.",
			source: { check: "lens.trust-boundary", version: "1" },
			explanation: { what: "Cached kill", whyHere: "Reused cache", whatToDo: "Rerun" },
			evidence: [
				{ file: "src/cache.ts", startLine: 1, role: "cause", revision: "head", proves: true, snippet: "cache" },
			],
			trigger: {
				file: "src/review.ts",
				index: 0,
				snippet: "incremental: true",
				proof: [{ file: "src/cache.ts", hash: snippetHash("cache") }],
			},
		});
		await root.commit(async (tx) => {
			await upsertFinding(tx, root.id, finding, "base..accepted", finding.properties.trigger!.proof);
			await upsertVerification(tx, root.id, "base..accepted", finding.id, finding.properties.source, {
				verdict: "plausible",
				reason: "Needs hostile configuration.",
				executor: "llm",
				model: "faux/judge",
				version: "1",
				lowered: { from: "P2", to: "P3", reason: "Needs hostile configuration." },
			});
			await dismissFinding(
				tx,
				root.id,
				finding.id,
				{
					by: "Maintainer",
					at: "2026-10-18T00:00:00Z",
					reason: "Accepted this trigger and proof.",
				},
				"base..accepted",
			);
		}, context);
	}
	process.stdout.write(
		`${JSON.stringify(
			{
				writtenBy: "748dfe37f634550f9aba8b8886aefa4e09984dab",
				version: FindingsDocument.definition.version,
				findings: await harness.snapshot(FindingsDocument, root.id, context),
			},
			null,
			2,
		)}\n`,
	);
} finally {
	await harness.close(context);
}

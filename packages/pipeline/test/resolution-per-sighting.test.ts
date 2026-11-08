import {
	Adjudication,
	defaultConfig,
	Finding,
	type FindingInput,
	type PolicyAt,
	type Verification,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	type Harness,
	openHarness,
	readFindings,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { upsertVerification } from "../src/findings.ts";

// Two lenses that both declare `no-eval` report one ID: the security lens at P1, the style lens at P3.
const input: FindingInput = {
	rule: "no-eval",
	message: "eval runs request input",
	file: "src/run.ts",
	startLine: 12,
	snippet: "eval(input)",
	occurrence: 0,
	cause: "introduced",
	severity: "P1",
	explanation: {
		what: "The handler passes the request body to eval.",
		whyHere: "This change routes the body into run().",
		whatToDo: "Parse the body with JSON.parse.",
	},
	failureScenario: "run('process.exit()') stops the server.",
	evidence: [{ file: "src/run.ts", startLine: 12, role: "cause", revision: "head", snippet: "eval(input)" }],
	source: { check: "lens.security", version: "1" },
};
const security = Finding.create(input);
const style = Finding.create({ ...input, severity: "P3", source: { check: "lens.style", version: "7" } });
const confirmed: Verification = {
	verdict: "confirmed",
	reason: "Traced the body into eval.",
	executor: "llm",
	model: "faux/judge",
	version: "v1",
};

const policy = (checks: NonNullable<NonNullable<PolicyAt["layers"]>[number]["resolution"]["checks"]>): PolicyAt => ({
	resolution: defaultConfig.resolution,
	ruleAliases: {},
	layers: [{ file: "melian.yaml", resolution: { checks } }],
});

let opened: Harness[] = [];
afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	opened = [];
});

async function sighted() {
	const fake = createFakeModels();
	const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
	opened.push(harness);
	const root = await harness.root(context, { agent: { model: fake.ref() } });
	await root.commit(async (tx) => {
		await upsertFinding(tx, root.id, security, "rev1");
		await upsertFinding(tx, root.id, style, "rev1");
	}, context);
	return { harness, root };
}

function decide(findings: readonly Finding[], config: PolicyAt, verificationRan = false) {
	const verdict = new Adjudication({ findings, config, manifest: [], checks: [], verificationRan }).adjudicate();
	const [only] = verdict.all();
	return only!.properties;
}

describe("resolution per sighting", () => {
	it("resolves each lens's sighting of one ID under its own severity", async () => {
		const { harness, root } = await sighted();
		const findings = await readFindings(harness, root.id, "rev1", context);
		// The security lens's P1 is capped at advisory; the style lens's P3 is advisory by the table. Neither blocks.
		expect(decide(findings, policy({ "lens.security": { ceiling: "advisory" } }))).toMatchObject({
			resolution: "advisory",
		});
		// The style lens's own P3 meets its P3 entry; the security lens's P1 is silent under its own.
		expect(
			decide(findings, policy({ "lens.security": { P1: "silent" }, "lens.style": { P1: "silent", P3: "block" } })),
		).toMatchObject({ resolution: "block", decidedBy: { check: "lens.style" } });
	});

	it("caps only the sighting no verifier judged", async () => {
		const { harness, root } = await sighted();
		await root.commit(async (tx) => {
			await upsertVerification(tx, root.id, "rev1", security.id, security.properties.source, confirmed);
		}, context);
		const findings = await readFindings(harness, root.id, "rev1", context);
		// The security lens's confirmed P1 blocks in full; the style lens's unjudged P3 is capped at advisory alone.
		expect(decide(findings, policy({}), true)).toMatchObject({
			resolution: "block",
			decidedBy: { check: "lens.security" },
		});
	});
});

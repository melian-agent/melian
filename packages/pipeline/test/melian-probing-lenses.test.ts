import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Changeset, Lens, loadConfig, type MelianConfig, Standards } from "@melian-agent/core";
import { createMemoryStorage, openReviewHarness, type ReviewHarness, reviewChangeset } from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	type ScriptedReply,
	scriptConversations,
	systemPromptOf,
	textOf,
	unconfinedSandbox,
} from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { baseAndHead } from "./fixtures/repo.ts";

// Melian's own policy and repository lenses, read from the checkout this test sits in, so the test reviews under the
// files Melian's rounds use.
const melian = fileURLToPath(new URL("../../../", import.meta.url));
const ownFiles = () => ({
	"melian.yaml": readFileSync(join(melian, "melian.yaml"), "utf8"),
	...Object.fromEntries(
		readdirSync(join(melian, ".melian/lenses")).map((name) => {
			const file = `.melian/lenses/${name}/LENS.md`;
			return [file, readFileSync(join(melian, file), "utf8")];
		}),
	),
});

const workflow = ".github/workflows/round.yml";
const headFiles = {
	"src/load.ts":
		'import { readFileSync } from "node:fs";\nexport function load(path: string) {\n\treturn readFileSync(path, "utf8");\n}\n',
	"fixture/leak.txt": "LEAK\n",
	[workflow]: `on: pull_request_target\njobs:\n  round:\n    env:\n      TOKEN: \${{ secrets.TOKEN }}\n    run: npm test\n`,
};

let repo: string;
let harness: ReviewHarness | undefined;
afterEach(async () => {
	await harness?.close();
	harness = undefined;
	rmSync(repo, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>) {
	return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], {
		stopReason: "toolUse",
	});
}

const attack = {
	target: "src/load.ts load()",
	reason: "an author's path reaches readFileSync unconfined",
	passing: "the read stays inside the repository and prints held",
	failing: "the read returns a file outside where it belongs and prints LEAK",
};
const failing =
	'import { readFileSync } from "node:fs";\nconst text = readFileSync("fixture/leak.txt", "utf8").trim();\nconsole.log(text);\nprocess.exit(text === "LEAK" ? 1 : 0);\n';

// A defect no probe can reach: the workflow runs only on GitHub.
const reading = {
	file: workflow,
	line: 5,
	rule: "secret-exposure",
	severity: "P1",
	explanation: {
		what: "the round job hands TOKEN to npm test",
		why: "pull_request_target runs the head's tests",
		fix: "keep the secret out of the step",
	},
	failureScenario: "A fork's pull request edits a test to print TOKEN, and the round job runs it with the secret set",
	evidence: [{ file: workflow, line: 5, role: "cause" }],
};
const probed = (probe: string) => ({
	file: "src/load.ts",
	line: 3,
	rule: "path-traversal",
	severity: "P1",
	explanation: { what: "load reads any path", why: "the path is the author's", fix: "confine it" },
	failureScenario: 'load("fixture/leak.txt") returns LEAK, a file the caller never meant to expose',
	evidence: [{ file: "src/load.ts", line: 3, role: "cause" }],
	probe,
});

describe("Melian's own trust-boundary lenses", { timeout: 60_000 }, () => {
	it("load as one lens that reads and one that probes at deep, held there by melian.yaml", async () => {
		repo = baseAndHead(ownFiles(), headFiles);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const policy = { kind: "revision", commit: changeset.revision.base } as const;
		const lenses = await Lens.load(repo, policy, changeset.revision.paths());
		const reader = lenses.find((lens) => lens.name === "trust-boundary")!;
		const prober = lenses.find((lens) => lens.name === "trust-boundary-probes")!;
		for (const level of ["quick", "careful", "deep"] as const) expect(reader.level(level).probe).toBeUndefined();
		expect(prober.level("deep")).toMatchObject({
			tier: "heavy",
			reads: "functions",
			verify: true,
			probe: { prober: "medium" },
			budget: { findings: 12, tokens: 3_000_000, tools: 90 },
		});
		expect(prober.level("careful").probe).toBeUndefined();
		expect(prober.rules).toEqual(reader.rules);
		expect(prober.instructions.startsWith(reader.instructions)).toBe(true);
		expect(prober.instructions).not.toBe(reader.instructions);
		const { config } = await loadConfig(repo, policy, ".");
		expect(config.tiers.full).toEqual(expect.arrayContaining(["lens.trust-boundary", "lens.trust-boundary-probes"]));
		expect(config.lenses?.["trust-boundary-probes"]).toEqual({
			paths: config.lenses?.["trust-boundary"]?.paths,
			level: { floor: "deep" },
		});
		expect(config.lenses?.["trust-boundary"]?.level).toBeUndefined();
	});

	it("report a finding by reading and a finding a failing probe backs, in one review", async () => {
		repo = baseAndHead(ownFiles(), headFiles);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const policy = { kind: "revision", commit: changeset.revision.base } as const;
		const paths = changeset.revision.paths();
		const lenses = await Lens.load(repo, policy, paths);
		const loaded = (await loadConfig(repo, policy, ".")).config;
		const fake = createFakeModels();
		const route = `${fake.ref().provider}/${fake.ref().modelId}`;
		// Melian's lenses, paths and floor, on the fake model, with the tier cut to the two lenses under test.
		const config: MelianConfig = {
			...loaded,
			tiers: { ...loaded.tiers, full: ["lens.trust-boundary", "lens.trust-boundary-probes"] },
			models: { heavy: { model: route }, medium: { model: route } },
		};
		const prober = lenses.find((lens) => lens.name === "trust-boundary-probes")!;
		const reader = lenses.find((lens) => lens.name === "trust-boundary")!;
		const requests = scriptConversations(fake, [
			// The longer instructions first: the probing lens's planner holds the reading lens's instructions too.
			{
				match: prober.instructions,
				replies: [call("record_plan", { attacks: [attack] }), fauxAssistantMessage("Planned 1 attack.")],
			},
			{
				match: "You are the prober for the trust-boundary-probes lens",
				replies: [
					call("run_probe", { attack: 1, script: failing }),
					((messages) => {
						const results = messages.filter((message) => message.role === "toolResult").map(textOf);
						const id = /probe (p[0-9]+)/.exec(results.at(-1) ?? "")?.[1] ?? "p0";
						return call("report_finding", probed(id));
					}) satisfies ScriptedReply,
					fauxAssistantMessage("Reported 1 finding."),
				],
			},
			{
				match: reader.instructions,
				replies: [call("report_finding", reading), fauxAssistantMessage("Reported 1 finding.")],
			},
		]);
		harness = await openReviewHarness(createMemoryStorage(), fake.review, {
			retry: false,
			probeSandbox: unconfinedSandbox(),
		});
		const { verdict } = await reviewChangeset({
			harness,
			changeset,
			config,
			lenses,
			standards: await Standards.load(repo, policy, paths),
			models: fake.review,
			writer: { trusted: true, by: "reviewer" },
		});
		const found = verdict
			.counted()
			.map((finding) => [
				finding.properties.reportedBy?.map(({ check }) => check),
				finding.properties.path,
				finding.ruleId,
				finding.properties.verification?.verdict,
			]);
		expect(found).toEqual(
			expect.arrayContaining([
				[["lens.trust-boundary"], workflow, "secret-exposure", "confirmed"],
				[["lens.trust-boundary-probes"], "src/load.ts", "path-traversal", "confirmed"],
			]),
		);
		expect(found).toHaveLength(2);
		const records = verdict.ran ?? [];
		expect(records.find(({ name }) => name === "lens.trust-boundary")).toMatchObject({
			status: "ran",
			level: "careful",
		});
		const probing = records.find(({ name }) => name === "lens.trust-boundary-probes")!;
		expect(probing).toMatchObject({ status: "ran", level: "deep" });
		expect(probing.reason).toMatch(/it planned 1 attack and ran 1 probe/);
		// The reading lens never saw the planner's role, and the prober got the plan, not the change.
		expect(systemPromptOf(requests[reader.instructions]![0]!)).not.toContain("the attack planner");
		const proberInput = requests["You are the prober for the trust-boundary-probes lens"]![0]!.filter(
			(message) => message.role === "user",
		)
			.map(textOf)
			.join("\n");
		expect(proberInput).toContain(attack.failing);
		expect(proberInput).not.toContain("secrets.TOKEN");
	});
});

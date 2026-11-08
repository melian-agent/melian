import { rmSync } from "node:fs";
import { Changeset, defaultConfig, Lens, type MelianConfig, Revision } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
	type Review,
	readFindings,
	recordDismissal,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptVerifier,
	systemPromptOf,
	textOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindingsDocument } from "../src/findings.ts";
import { verifierMarker } from "../src/verification-instructions.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines, writeFiles } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";

const user = (label: string, body: string) =>
	lines(
		"export interface User {",
		"\tname: string;",
		"\tmanager?: User;",
		"}",
		"",
		"export function managerName(user: User): string {",
		`\tconst label = "${label}";`,
		body,
		"}",
	);

const nullDeref = {
	file: "src/user.ts",
	line: 8,
	rule: "null-dereference",
	severity: "P1",
	explanation: {
		what: "managerName reads name from a manager that may be undefined.",
		why: "This change dropped the optional chain, so a user without a manager throws.",
		fix: "Restore user.manager?.name with a fallback.",
	},
	failureScenario: 'managerName({ name: "Ada" }) throws TypeError: Cannot read properties of undefined.',
	evidence: [{ file: "src/user.ts", line: 8, role: "cause" }],
};
// The same defect worded afresh: it cites lines 7 to 8, so its snippet, and its ID, differ.
const restatement = {
	...nullDeref,
	line: 7,
	endLine: 8,
	failureScenario: "A user with no manager makes managerName throw on the name read.",
	evidence: [{ file: "src/user.ts", line: 8, role: "cause" }],
};

const dismissal = {
	by: "Tal <tal@melian.invalid>",
	reason: "Every user here has a manager.",
	at: "2026-10-04T01:00:00Z",
};

const deterministicRan = [
	{ name: "guardrails", status: "ran" },
	{ name: "static.biome", status: "ran" },
	{ name: "static.tsc", status: "ran" },
] as const;

let repo: string;
let fake: FakeModels;
let config: MelianConfig;
let lenses: Lens[];
let harness: Harness;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead(
		{ "src/user.ts": user("manager", '\treturn user.manager?.name ?? "none";') },
		{ "src/user.ts": user("boss", "\treturn user.manager.name + label;") },
	);
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	config = {
		...defaultConfig,
		tiers: twoLensTiers,
		models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
	};
	lenses = await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"]);
	harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
});

afterEach(async () => {
	await harness.close(context);
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

type Messages = Parameters<typeof scriptVerifier>[0];

const report = (args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall("report_finding", args), { stopReason: "toolUse" });

// The verifier confirms every claim and answers `matches` for each dismissed finding it is shown; `same` when unset.
function script(
	reported: readonly Parameters<typeof fauxToolCall>[1][],
	answer: (dismissed: string) => string = () => "same",
): Record<string, Messages[]> {
	const verify = (messages: Messages) => {
		const prompt = systemPromptOf(messages);
		const dismissed = [...prompt.matchAll(/Dismissed d[1-9][0-9]* finding ([0-9a-f]{16})/g)].map((m) => m[1]!);
		const claims = [...prompt.matchAll(/Claim c[1-9][0-9]* finding ([0-9a-f]+)/g)].map((m) => m[1]!);
		const matches = Object.fromEntries(dismissed.map((id) => [id, answer(id)]));
		return scriptVerifier(
			messages,
			Object.fromEntries(claims.map((id) => [id, { verdict: "confirmed" as const, matches }])),
		);
	};
	return scriptConversations(fake, [
		{ match: correctness, replies: [...reported.map((each) => report(each)), fauxAssistantMessage("Done.")] },
		{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
		{ match: verifierMarker, replies: [verify, verify, verify, verify] },
	]);
}

async function review(): Promise<Review> {
	const changeset = await Changeset.resolve(repo, "main...feature");
	return reviewChangeset({
		harness,
		changeset,
		config,
		lenses,
		standards: [],
		models: fake.review,
		checks: [...deterministicRan],
	});
}

async function revision() {
	return (await Changeset.resolve(repo, "main...feature")).revision;
}

// Pushes a commit onto `feature` that adds a file and leaves src/user.ts alone.
function pushElsewhere(name: string): void {
	writeFiles(repo, { [`src/${name}.ts`]: `export const ${name} = 1;\n` });
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", `add ${name}`);
}

// Reviews the first head, where the lens reports the dereference, and the maintainer dismisses it.
async function dismissedRoot(): Promise<string> {
	script([nullDeref]);
	const first = await review();
	const [finding] = first.verdict.attention();
	expect(finding?.properties.severity).toBe("P1");
	await recordDismissal({ harness, revision: await revision(), id: finding!.id, dismissal, repoRoot: repo });
	return finding!.id;
}

describe("a dismissal carrying to a restatement", () => {
	it("dismisses a restatement the verifier judges the same, under the root's reason and never its dismisser", async () => {
		const root = await dismissedRoot();
		pushElsewhere("other");
		const requests = script([restatement]);
		const second = await review();
		const [restated] = second.findings;
		expect(restated!.id).not.toBe(root);
		expect(second.verdict.attention()).toEqual([]);
		expect(second.verdict.status).toBe("passed");
		const [dismissed] = second.verdict.dismissed;
		expect(dismissed!.id).toBe(restated!.id);
		expect(dismissed!.properties.dismissal).toEqual({
			by: "melian",
			reason: dismissal.reason,
			at: dismissal.at,
			inheritedFrom: root,
		});
		expect(JSON.stringify(second.verdict.toJSON())).not.toContain("Tal");
		// The root goes to the verifier on a trusted label line, its claim inside the boundary, and its reason nowhere.
		const shown = requests[verifierMarker]!.at(-1)!;
		const prompt = systemPromptOf(shown);
		expect(prompt).toContain(`Dismissed d1 finding ${root}`);
		const input = shown
			.filter((message) => message.role === "user")
			.map(textOf)
			.join("\n");
		expect(input).toMatch(/Dismissed d1\n<untrusted-[0-9a-f]+ label="findings">/);
		expect(input).toContain(JSON.stringify(nullDeref.failureScenario).slice(1, -1));
		expect(`${prompt}\n${input}`).not.toContain(dismissal.reason);
	});

	it("leaves a restatement the verifier judges different live, with no link", async () => {
		await dismissedRoot();
		pushElsewhere("other");
		script([restatement], () => "different");
		const second = await review();
		expect(second.verdict.attention()).toHaveLength(1);
		expect(second.verdict.attention()[0]!.properties).not.toHaveProperty("likelyDismissedAs");
		const state = await harness.snapshot(FindingsDocument, (await harness.root(context)).id, context);
		expect(state!.inherited?.[Revision.key(await revision())]).toBeUndefined();
	});

	it("asks nothing and carries nothing when a change touches the root's region", async () => {
		const root = await dismissedRoot();
		writeFiles(repo, { "src/user.ts": user("boss", "\treturn user.manager.name + label + label;") });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "touch the line");
		const requests = script([restatement]);
		const second = await review();
		expect(second.verdict.attention()).toHaveLength(1);
		const prompt = requests[verifierMarker]!.map(systemPromptOf).join("\n");
		expect(prompt).not.toContain(`Dismissed d1 finding ${root}`);
	});

	it("re-derives the link each round, so a root dismissed again with another reason carries the new one", async () => {
		const root = await dismissedRoot();
		pushElsewhere("other");
		script([restatement]);
		await review();
		const replaced = { ...dismissal, reason: "Managers are always set by the loader.", at: "2026-10-05T01:00:00Z" };
		const first = await Changeset.resolve(repo, "main...feature~1");
		await recordDismissal({ harness, revision: first.revision, id: root, dismissal: replaced, repoRoot: repo });
		// The link names the old dismissal, which no longer stands, so a read shows the restatement live.
		const at = Revision.key(await revision());
		const owner = (await harness.root(context)).id;
		const [lapsed] = await readFindings(harness, owner, at, context);
		expect(lapsed!.properties.status).toBe("new");
		expect(lapsed!.properties.dismissal).toBeUndefined();
		// The next round re-derives it from the judgements it stored, against the dismissal that stands now.
		script([restatement]);
		const third = await review();
		expect(third.verdict.dismissed[0]!.properties.dismissal).toEqual({
			by: "melian",
			reason: replaced.reason,
			at: replaced.at,
			inheritedFrom: root,
		});
	});

	it.each([
		{ name: "omits a dismissed finding", matches: undefined, says: "missing" },
		{
			name: "answers one it was not shown",
			matches: { "0123456789abcdef": "same" },
			says: "not listed 0123456789abcdef",
		},
	])("refuses a report that $name, judges nothing, and links nothing", async ({ matches, says }) => {
		const root = await dismissedRoot();
		pushElsewhere("other");
		const call = (messages: Messages) =>
			messages.some((message) => message.role === "toolResult")
				? fauxAssistantMessage("Done.")
				: fauxAssistantMessage(
						fauxToolCall("report_verdict", {
							claim: "c1",
							answers: { code: "yes", guard: "no", base: "no" },
							verdict: "confirmed",
							reason: "Traced.",
							...(matches === undefined ? {} : { matches: { ...matches, [root]: "same" } }),
						}),
						{ stopReason: "toolUse" },
					);
		const requests = scriptConversations(fake, [
			{ match: correctness, replies: [report(restatement), fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
			{ match: verifierMarker, replies: [call, call, call] },
		]);
		const second = await review().catch((error: { verdict?: unknown }) => error);
		const results = requests[verifierMarker]!.flat()
			.filter((message) => message.role === "toolResult")
			.map(textOf)
			.join("\n");
		expect(results).toContain(`matches must answer same or different for each dismissed finding listed, d1 ${root}`);
		expect(results).toContain(says);
		expect(second).toMatchObject({ code: "verifierFailed" });
		const state = await harness.snapshot(FindingsDocument, (await harness.root(context)).id, context);
		expect(state!.inherited?.[Revision.key(await revision())]).toBeUndefined();
	});
});

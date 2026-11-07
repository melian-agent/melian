import { rmSync } from "node:fs";
import {
	Adjudication,
	Changeset,
	type CheckRecord,
	defaultConfig,
	Finding,
	type FindingInput,
	Revision,
	type StoredFinding,
	withheldToolText,
} from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, expect, it, vi } from "vitest";
import { evalInput } from "../../core/test/fixtures/findings.ts";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../src/adjudication.ts";
import { backgroundContext as context, createMemoryStorage } from "../src/index.ts";
import { publishReview } from "../src/publish.ts";
import { ReviewIndex as ReviewIndexOf } from "../src/review-index.ts";
import { RoundWriter } from "../src/rounds.ts";
import { createFakeModels } from "../src/testing.ts";
import { RecordedReview } from "./fixtures/recorded-review.ts";
import { baseAndHead, isolatedGitEnv } from "./fixtures/repo.ts";

// No character Markdown escapes, so the posted text holds it verbatim if it holds it at all.
const token = "ghpFAKEoutsideTOKEN281";
const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const said = withheldToolText("static.tsc", "tsc/TS2322");

// A tsc finding that holds Melian's sentence where the tool's message was, with `plant` writing the token into one
// other stored field, as a build before Melian withheld tool text, or a caller supplying its own records, could.
function planted(plant: (stored: StoredFinding) => void, input: Partial<FindingInput> = {}): Finding {
	const stored = Finding.create({
		rule: "tsc/TS2322",
		message: said,
		file: "src/a.ts",
		startLine: 1,
		snippet: "new",
		occurrence: 0,
		cause: "introduced",
		severity: "P1",
		explanation: { what: said, whyHere: "tsc reports this at head.", whatToDo: "Change the code." },
		source: { check: "static.tsc", version: "7.0.2" },
		...input,
	}).toJSON();
	plant(stored);
	return Finding.from(stored);
}

const verified = (fields: Record<string, unknown>) => (stored: StoredFinding) => {
	stored.properties.verification = {
		verdict: "plausible",
		reason: "The type is wrong.",
		executor: "llm",
		model: "faux/judge",
		version: "1",
		...fields,
	} as NonNullable<StoredFinding["properties"]["verification"]>;
};

// A lens report a verifier refuted.
function refuted(input: FindingInput): Finding {
	const stored = Finding.create(input).toJSON();
	verified({ verdict: "refuted", reason: "The branch is covered." })(stored);
	return Finding.from(stored);
}

const cases: [string, Finding[], CheckRecord[]][] = [
	["a verifier's reason", [planted(verified({ reason: token }))], []],
	["a verifier's correction", [planted(verified({ correction: token }))], []],
	[
		"a lowering's reason",
		[
			planted(
				(stored) => {
					verified({ lowered: { from: "P1", to: "P2", reason: token } })(stored);
					stored.properties.originalSeverity = "P1";
				},
				{ severity: "P2" },
			),
		],
		[],
	],
	[
		"the explanation's why-here, as advice carries it",
		[planted((stored) => Object.assign(stored.properties.explanation, { whyHere: token }))],
		[],
	],
	[
		"the explanation's what-to-do, as advice carries it",
		[planted((stored) => Object.assign(stored.properties.explanation, { whatToDo: token }))],
		[],
	],
	["a failed check's reason", [], [{ name: "static.tsc", status: "failed", reason: token, error: "x" }]],
	["a failed check's error", [], [{ name: "static.tsc", status: "failed", reason: "toolFailed", error: token }]],
	["a skipped check's reason", [], [{ name: "static.biome", status: "skipped", reason: token }]],
	// Codex's scenario: a refuted lens report speaks for a defect, and the merge shows the Biome report that stands.
	[
		"a Biome report merged under a refuted lens report",
		[
			refuted({
				...evalInput,
				rule: "untested-branch",
				file: "src/a.ts",
				startLine: 1,
				endLine: 1,
				startColumn: undefined,
				endColumn: undefined,
				snippet: "new",
				severity: "P0",
				resolution: undefined,
				trigger: undefined,
				failureScenario: "The branch never runs.",
				evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, role: "cause", revision: "head", snippet: "new" }],
				source: { check: "lens.tests", version: "1" },
			}),
			planted(() => {}, {
				rule: "biome/suspicious/noDebugger",
				message: token,
				severity: "P1",
				explanation: { what: token, whyHere: token, whatToDo: token },
				source: { check: "static.biome", version: "2.5.15" },
			}),
		],
		[],
	],
];

it.each(cases)("posts nothing of %s on a Biome or tsc result", async (_field, findings, checks) => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	const repo = baseAndHead({ "src/a.ts": "old\n" }, { "src/a.ts": "new\n" });
	directories.push(repo);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const state = pullRequestState();
	moveTo(state, changeset);
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "t",
		fetch: fakeGitHub(state),
	});
	const recorded = await RecordedReview.open(createMemoryStorage(), createFakeModels().review, provider);
	try {
		const root = await recorded.harness.root(context, { agent: { model: createFakeModels().ref() } });
		const key = Revision.key(changeset.revision);
		await root.commit(async (tx) => {
			const doc = await tx.doc(VerdictDocument, root.id);
			doc.verdicts[key] = new Adjudication({
				findings,
				manifest: ["static.tsc", "static.biome", "lens.tests"],
				checks: [
					...checks,
					...["static.tsc", "static.biome"]
						.filter((name) => !checks.some((check) => check.name === name))
						.map((name) => ({ name, status: "ran" as const })),
					{ name: "lens.tests", status: "ran" as const },
				],
				config: defaultConfig,
			})
				.adjudicate()
				.toJSON();
			doc.provenance = {
				[key]: {
					kind: "pull-request",
					manifest: ["static.tsc", "static.biome", "lens.tests"],
					lenses: [],
					repository: { owner: state.owner, name: state.repo },
					pullRequest: 7,
					base: changeset.revision.base,
					head: changeset.revision.head,
					policy: `revision:${changeset.revision.base}`,
				},
			};
		}, context);
		expect(JSON.stringify(await recorded.harness.snapshot(VerdictDocument, root.id, context))).toContain(token);
		console.log(
			"DBGM",
			JSON.stringify(
				(await recorded.harness.snapshot(VerdictDocument, root.id, context))?.verdicts[key]?.findings,
			).slice(0, 1500),
		);
		await recorded.record(key);
		const adjudication = (await recorded.harness.snapshot(ReviewIndexOf, root.id, context))!.reviews[key]!
			.adjudication!.task;
		await root.commit((tx) => new RoundWriter(tx, root.id).keep(key, adjudication), context);
		await publishReview({
			harness: recorded.harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: true,
		});
		expect(state.reviews).toHaveLength(1);
		expect(state.ledgers.length + state.comments.length).toBeGreaterThan(0);
		const { reviews, comments, ledgers, statuses } = state;
		expect(JSON.stringify({ reviews, comments, ledgers, statuses })).not.toContain(token);
	} finally {
		await recorded.close(context);
	}
});

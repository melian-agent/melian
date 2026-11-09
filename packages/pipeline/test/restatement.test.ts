import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	injectionAttemptRuleId,
	Lens,
	type MelianConfig,
	Rendering,
	Revision,
} from "@melian-agent/core";
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
import { FindingsDocument, findingsVersion } from "../src/findings.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { verifierMarker } from "../src/verification-instructions.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines, writeFiles } from "./fixtures/repo.ts";
import { twoLensTiers, withBudget } from "./fixtures/review-scenario.ts";

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
async function dismissedRoot(reported = nullDeref): Promise<string> {
	script([reported]);
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
		const tag = input.match(/Dismissed d1\n<(untrusted-[0-9a-f]+) label="findings">/)?.[1];
		const claim = {
			failureScenario: nullDeref.failureScenario,
			evidence: [
				{
					file: "src/user.ts",
					startLine: 8,
					role: "cause",
					revision: "head",
					proves: true,
					snippet: "\treturn user.manager.name + label;",
				},
			],
		};
		expect(input.split("\n\n").find((block) => block.startsWith("Dismissed d1\n"))).toBe(
			`Dismissed d1\n<${tag} label="findings">\n${JSON.stringify(claim)}\n</${tag}>`,
		);
		expect(`${prompt}\n${input}`).not.toContain(dismissal.reason);
	});

	// Pull request #329: a second round on the same head, after the lens's version changed, worded the dismissed
	// claim afresh at the same rule, file and line. The root was dismissed at this head, so git maps an empty diff.
	it("carries the dismissal to a restatement on the same head the root was dismissed at", async () => {
		const root = await dismissedRoot();
		// Another findings budget is another lens selection, so round two runs the lens again on this head. Its run
		// replaces the sightings round one left there, the root's included.
		lenses = lenses.map((lens) => (lens.name === "correctness" ? withBudget(lens, { findings: 9 }) : lens));
		const worded = {
			...restatement,
			explanation: { ...restatement.explanation, what: "managerName dereferences an optional manager." },
		};
		const requests = script([worded]);
		const second = await review();
		const [restated] = second.findings;
		expect(restated!.id).not.toBe(root);
		const state = await harness.snapshot(FindingsDocument, (await harness.root(context)).id, context);
		expect(state!.items[root]!.sightings[Revision.key(await revision())]).toBeUndefined();
		expect(systemPromptOf(requests[verifierMarker]!.at(-1)!)).toContain(`Dismissed d1 finding ${root}`);
		expect(second.verdict.attention()).toEqual([]);
		expect(second.verdict.dismissed.find((each) => each.id === restated!.id)!.properties.dismissal).toEqual({
			by: "melian",
			reason: dismissal.reason,
			at: dismissal.at,
			inheritedFrom: root,
		});
	});

	// Review A waits on its lens run or its verifier until review B, which replaced that run, has finished; A must not
	// then clear the links B recorded.
	it.each([
		{ name: "its verifier by lens selection", waitsOn: "verification", budget: 9, verifier: false },
		{ name: "its lens run before verification", waitsOn: "task", budget: 9, verifier: false },
		{
			name: "its verifier by verifier route",
			waitsOn: "verification",
			budget: undefined,
			verifier: true,
		},
	] as const)("keeps the links of a review that replaced $name", async ({ waitsOn, budget, verifier }) => {
		const root = await dismissedRoot();
		pushElsewhere("other");
		const at = Revision.key(await revision());
		const owner = (await harness.root(context)).id;
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let finish: (() => void) | undefined;
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let hold = waitsOn === "verification";
		const verify = (messages: Messages) => {
			if (hold) {
				hold = false;
				return held.then(() => fauxAssistantMessage("Done."));
			}
			const prompt = systemPromptOf(messages);
			const claims = [...prompt.matchAll(/Claim c[1-9][0-9]* finding ([0-9a-f]+)/g)].map((m) => m[1]!);
			return scriptVerifier(
				messages,
				Object.fromEntries(
					claims.map((id) => [id, { verdict: "confirmed" as const, matches: { [root]: "same" } }]),
				),
			);
		};
		const requests = scriptConversations(fake, [
			{
				match: correctness,
				replies: [
					report(restatement),
					fauxAssistantMessage("Done."),
					report(restatement),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: contracts, replies: [fauxAssistantMessage("Done."), fauxAssistantMessage("Done.")] },
			{ match: verifierMarker, replies: [verify, verify, verify, verify] },
		]);
		const entry = async () => (await harness.snapshot(ReviewIndex, owner, context))?.reviews[at];
		const gated = new Proxy(harness, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				if (property !== "waitForTask") return typeof value === "function" ? value.bind(target) : value;
				return async (...args: Parameters<Harness["waitForTask"]>) => {
					const known = await entry();
					const waits = (waitsOn === "task" ? known?.task : known?.verification?.task) === args[0];
					const outcome = await target.waitForTask(...args);
					if (waits) {
						finish!();
						await held;
					}
					return outcome;
				};
			},
		});
		const changeset = await Changeset.resolve(repo, "main...feature");
		const options = { changeset, standards: [], models: fake.review, checks: [...deterministicRan] };
		const replaced = reviewChangeset({ ...options, config, harness: gated, lenses }).catch((error: unknown) => error);
		if (waitsOn === "task") await finished;
		else while ((requests[verifierMarker]?.length ?? 0) === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		const orchestrator = fake.ref("orchestrator");
		const replacing = await reviewChangeset({
			...options,
			harness,
			// Another findings budget is another lens selection; another verifier model is another verification input.
			lenses: lenses.map((lens) =>
				lens.name === "correctness" && budget !== undefined ? withBudget(lens, { findings: budget }) : lens,
			),
			config: verifier
				? {
						...config,
						models: { ...config.models, verifier: { model: `${orchestrator.provider}/${orchestrator.modelId}` } },
					}
				: config,
		});
		const [restated] = replacing.findings;
		expect(replacing.verdict.dismissed.map((each) => each.id)).toEqual([restated!.id]);
		const links = structuredClone((await harness.snapshot(FindingsDocument, owner, context))!.inherited?.[at]);
		expect(links?.[restated!.id]).toMatchObject({ from: root, kind: "inherited" });
		const version = await findingsVersion(harness, owner, at, context);
		release!();
		await replaced;
		expect((await harness.snapshot(FindingsDocument, owner, context))!.inherited?.[at]).toEqual(links);
		if (!verifier) expect(await findingsVersion(harness, owner, at, context)).toBe(version);
	});

	// Codex's adversarial review of round four: the verifier judged one dismissal, and the link must not bind to another.
	it("links nothing when the root's dismissal is replaced while the verifier judges it", async () => {
		const root = await dismissedRoot();
		const first = await revision();
		pushElsewhere("other");
		const replaced = { ...dismissal, reason: "Only staff reach this path." };
		let pending = true;
		const verify = async (messages: Messages) => {
			if (pending)
				await recordDismissal({ harness, revision: first, id: root, dismissal: replaced, repoRoot: repo });
			pending = false;
			const prompt = systemPromptOf(messages);
			const claims = [...prompt.matchAll(/Claim c[1-9][0-9]* finding ([0-9a-f]+)/g)].map((m) => m[1]!);
			return scriptVerifier(
				messages,
				Object.fromEntries(
					claims.map((id) => [id, { verdict: "confirmed" as const, matches: { [root]: "same" } }]),
				),
			);
		};
		scriptConversations(fake, [
			{ match: correctness, replies: [report(restatement), fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
			{ match: verifierMarker, replies: [verify, verify, verify, verify] },
		]);
		const second = await review();
		const owner = (await harness.root(context)).id;
		expect((await harness.snapshot(FindingsDocument, owner, context))!.items[root]!.lifecycle.dismissedReason).toBe(
			replaced.reason,
		);
		expect(second.verdict.attention().map((each) => each.id)).toEqual([second.findings[0]!.id]);
		expect(
			(await harness.snapshot(FindingsDocument, owner, context))!.inherited?.[Revision.key(await revision())],
		).toBeUndefined();
	});

	// A review that attaches to a finished lens task starts no wave, so its own final task is what another review replaces.
	it.each([
		{ name: "under another verifier route", absent: false },
		{ name: "with no verifier credentials", absent: true },
	] as const)(
		"leaves the links of a review that replaced a final verification still awaited, $name",
		async ({ absent }) => {
			const root = await dismissedRoot();
			pushElsewhere("other");
			let hold = false;
			let release: (() => void) | undefined;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const verify = (messages: Messages) => {
				if (hold) {
					hold = false;
					return held.then(() => fauxAssistantMessage("Done."));
				}
				const prompt = systemPromptOf(messages);
				const claims = [...prompt.matchAll(/Claim c[1-9][0-9]* finding ([0-9a-f]+)/g)].map((m) => m[1]!);
				return scriptVerifier(
					messages,
					Object.fromEntries(
						claims.map((id) => [id, { verdict: "confirmed" as const, matches: { [root]: "same" } }]),
					),
				);
			};
			const requests = scriptConversations(fake, [
				{ match: correctness, replies: [report(restatement), fauxAssistantMessage("Done.")] },
				{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
				{ match: verifierMarker, replies: Array.from({ length: 8 }, () => verify) },
			]);
			const at = Revision.key(await revision());
			const owner = (await harness.root(context)).id;
			const changeset = await Changeset.resolve(repo, "main...feature");
			const options = {
				changeset,
				lenses,
				standards: [],
				models: fake.review,
				checks: [...deterministicRan],
				harness,
			};
			await reviewChangeset({ ...options, config });
			const orchestrator = fake.ref("orchestrator");
			const heavy = fake.ref("heavy");
			// Each verifier route is another verification input, so each review starts a final task of its own.
			const routed = (model: typeof heavy, thinking?: "high") => ({
				...config,
				models: {
					...config.models,
					verifier: {
						model: `${model.provider}/${model.modelId}`,
						...(thinking === undefined ? {} : { thinking }),
					},
				},
			});
			const asked = requests[verifierMarker]?.length ?? 0;
			hold = true;
			const replaced = reviewChangeset({ ...options, config: routed(orchestrator) }).catch(
				(error: unknown) => error,
			);
			while ((requests[verifierMarker]?.length ?? 0) === asked)
				await new Promise((resolve) => setTimeout(resolve, 5));
			if (absent) {
				// The replacing review detaches the verification, which the awaited one reads as no longer its own.
				const absentVerifier = { ...config, models: { ...config.models, verifier: { model: "faux/absent" } } };
				await reviewChangeset({ ...options, config: absentVerifier }).catch(() => undefined);
				expect((await harness.snapshot(ReviewIndex, owner, context))!.reviews[at]!.verification).toBeUndefined();
			} else {
				const replacing = await reviewChangeset({ ...options, config: routed(heavy, "high") });
				const [restated] = replacing.findings;
				expect(replacing.verdict.dismissed.map((each) => each.id)).toEqual([restated!.id]);
			}
			const links = structuredClone((await harness.snapshot(FindingsDocument, owner, context))!.inherited?.[at]);
			expect(links === undefined).toBe(absent);
			release!();
			expect(await replaced).toMatchObject({ code: expect.any(String) });
			expect((await harness.snapshot(FindingsDocument, owner, context))!.inherited?.[at]).toEqual(links);
		},
	);

	// The round on 14f2d16 (lens.durability): a call that crashed after its wave judged the root, and before its final
	// step, leaves a retry nothing in memory to say which dismissal that wave was shown.
	it("links nothing when the root's dismissal is replaced after a wave judged it and a retry reuses that wave", async () => {
		const root = await dismissedRoot();
		const first = await revision();
		pushElsewhere("other");
		const replaced = { ...dismissal, reason: "Only staff reach this path." };
		let judged!: () => void;
		const waveJudged = new Promise<void>((resolve) => {
			judged = resolve;
		});
		const verify = (messages: Messages) => {
			if (messages.some((message) => message.role === "toolResult")) judged();
			const prompt = systemPromptOf(messages);
			const claims = [...prompt.matchAll(/Claim c[1-9][0-9]* finding ([0-9a-f]+)/g)].map((m) => m[1]!);
			return scriptVerifier(
				messages,
				Object.fromEntries(
					claims.map((id) => [id, { verdict: "confirmed" as const, matches: { [root]: "same" } }]),
				),
			);
		};
		const asked = scriptConversations(fake, [
			{ match: correctness, replies: [report(restatement), fauxAssistantMessage("Done.")] },
			{
				match: contracts,
				replies: [
					async () => {
						await Promise.race([waveJudged, new Promise((resolve) => setTimeout(resolve, 2_000))]);
						return fauxAssistantMessage("Done.");
					},
				],
			},
			{ match: verifierMarker, replies: [verify, verify, verify, verify] },
		]);
		const at = Revision.key(await revision());
		const owner = (await harness.root(context)).id;
		let crashed = false;
		const gated = new Proxy(harness, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				if (property !== "waitForTask") return typeof value === "function" ? value.bind(target) : value;
				return async (...args: Parameters<Harness["waitForTask"]>) => {
					const outcome = await target.waitForTask(...args);
					const entry = (await target.snapshot(ReviewIndex, owner, context))?.reviews[at];
					const lensTask =
						entry?.task === undefined ? undefined : await target.getTask(entry.task as never, context);
					// The wave has judged the root, the lenses have ended and no final step has started: the call dies here,
					// however it waits, since the wave watcher swallows its own failures.
					if (
						outcome.kind === "melian.verification" &&
						entry?.verification === undefined &&
						lensTask?.state.status === "terminal"
					) {
						if (!crashed)
							await recordDismissal({
								harness: target,
								revision: first,
								id: root,
								dismissal: replaced,
								repoRoot: repo,
							});
						crashed = true;
						throw new Error("the process died");
					}
					return outcome;
				};
			},
		});
		const changeset = await Changeset.resolve(repo, "main...feature");
		const options = { changeset, config, lenses, standards: [], models: fake.review, checks: [...deterministicRan] };
		await expect(reviewChangeset({ ...options, harness: gated })).rejects.toThrow("the process died");
		const retry = await reviewChangeset({ ...options, harness });
		expect(asked[verifierMarker]).toHaveLength(2);
		expect(retry.verdict.attention().map((each) => each.id)).toEqual([retry.findings[0]!.id]);
		expect((await harness.snapshot(FindingsDocument, owner, context))!.inherited?.[at]).toBeUndefined();
	});

	it("clears the links when a later round on the head has no verifier with credentials", async () => {
		await dismissedRoot();
		pushElsewhere("other");
		script([restatement]);
		await review();
		const at = Revision.key(await revision());
		const owner = (await harness.root(context)).id;
		expect((await harness.snapshot(ReviewIndex, owner, context))!.reviews[at]!.verification).toBeDefined();
		expect((await harness.snapshot(FindingsDocument, owner, context))!.inherited?.[at]).toBeDefined();
		script([restatement]);
		config = { ...config, models: { ...config.models, verifier: { model: "faux/absent" } } };
		await review().catch(() => undefined);
		expect((await harness.snapshot(FindingsDocument, owner, context))!.inherited?.[at]).toBeUndefined();
	});

	it("clears the links when a later round on the head selects no lens", async () => {
		await dismissedRoot();
		pushElsewhere("other");
		script([restatement]);
		await review();
		const at = Revision.key(await revision());
		const owner = (await harness.root(context)).id;
		expect((await harness.snapshot(FindingsDocument, owner, context))!.inherited?.[at]).toBeDefined();
		const changeset = await Changeset.resolve(repo, "main...feature");
		await reviewChangeset({
			harness,
			changeset,
			config,
			lenses: [],
			standards: [],
			models: fake.review,
			checks: [...deterministicRan],
		}).catch(() => undefined);
		expect((await harness.snapshot(FindingsDocument, owner, context))!.inherited?.[at]).toBeUndefined();
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

	it("only proposes a P1 restatement of a root dismissed at the P2 it was lowered to", async () => {
		const lowering = (messages: Messages) => {
			const [id] = [...systemPromptOf(messages).matchAll(/Claim c1 finding ([0-9a-f]+)/g)].map((m) => m[1]!);
			return scriptVerifier(messages, {
				[id!]: {
					verdict: "confirmed",
					evidence: [{ file: "src/user.ts", line: 6, role: "context" }],
					lower: { severity: "P2", reason: "One caller checks first." },
				},
			});
		};
		scriptConversations(fake, [
			{ match: correctness, replies: [report(nullDeref), fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
			{ match: verifierMarker, replies: [lowering, lowering] },
		]);
		const [shown] = (await review()).verdict.attention();
		expect(shown!.properties).toMatchObject({ severity: "P2", originalSeverity: "P1" });
		await recordDismissal({ harness, revision: await revision(), id: shown!.id, dismissal, repoRoot: repo });
		pushElsewhere("other");
		script([restatement]);
		expect((await review()).verdict.attention().map((each) => each.properties)).toMatchObject([
			{ severity: "P1", status: "new", likelyDismissedAs: { id: shown!.id } },
		]);
	});

	it("keeps as the root's claim the sighting of a lens the dismissed verdict selected", async () => {
		script([nullDeref]);
		const [shown] = (await review()).verdict.attention();
		const owner = await harness.root(context);
		// A sighting of the ID by a producer the review did not select, more severe, so it would win if it counted.
		await owner.commit(async (tx) => {
			const sightings = (await tx.doc(FindingsDocument, owner.id)).items[shown!.id]!.sightings[
				Revision.key(await revision())
			]!;
			const [own] = Object.values(sightings);
			sightings["lens.contracts@stale"] = JSON.parse(
				JSON.stringify({
					...own!,
					properties: {
						...own!.properties,
						severity: "P0",
						failureScenario: "A lens since dropped wrote this.",
						source: { check: "lens.contracts", version: "stale" },
					},
				}),
			);
		}, context);
		await recordDismissal({ harness, revision: await revision(), id: shown!.id, dismissal, repoRoot: repo });
		const state = await harness.snapshot(FindingsDocument, owner.id, context);
		expect(state!.items[shown!.id]!.lifecycle.dismissedSighting!.sighting.properties).toMatchObject({
			failureScenario: nullDeref.failureScenario,
			source: { check: "lens.correctness" },
		});
	});

	// Pull request #341: two selected lenses reported one ID, and the verifier refuted the stricter claim. The verdict
	// spoke with the other, so the root must freeze that one, or a restatement of the refuted claim inherits.
	it("keeps as the root's claim the one the verdict showed, not a stricter claim the verifier refuted", async () => {
		const refutedScenario = "Every caller passes a user without a manager, so the read always throws.";
		const refuting = (messages: Messages) => {
			if (messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall")))
				return fauxAssistantMessage("Every claim judged.");
			const claims = [
				...systemPromptOf(messages).matchAll(/Claim (c[0-9]+) finding [0-9a-f]+, reported at (P[0-3])/g),
			];
			return fauxAssistantMessage(
				claims.map(([, claim, severity]) =>
					fauxToolCall("report_verdict", {
						claim: claim!,
						answers: { code: "yes", guard: severity === "P0" ? "yes" : "no", base: "no" },
						verdict: severity === "P0" ? "refuted" : "confirmed",
						reason: "The scripted verifier traced the claim.",
						...(severity === "P0" ? { evidence: [{ file: "src/user.ts", line: 7, role: "context" }] } : {}),
					}),
				),
				{ stopReason: "toolUse" },
			);
		};
		scriptConversations(fake, [
			{ match: correctness, replies: [report(nullDeref), fauxAssistantMessage("Done.")] },
			{
				match: contracts,
				replies: [
					report({ ...nullDeref, severity: "P0", failureScenario: refutedScenario }),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: verifierMarker, replies: [refuting, refuting, refuting, refuting] },
		]);
		// The contracts lens may report the correctness rule, so both lenses can sight one ID.
		const rule = lenses
			.find((lens) => lens.name === "correctness")!
			.rules.find((each) => each.id === nullDeref.rule)!;
		lenses = lenses.map((lens) =>
			lens.name === "contracts" ? Lens.from({ ...lens.toJSON(), rules: [...lens.rules, rule] }) : lens,
		);
		const [shown] = (await review()).verdict.attention();
		expect(shown!.properties).toMatchObject({
			severity: "P1",
			reportedBy: [{ check: "lens.contracts" }, { check: "lens.correctness" }],
		});
		await recordDismissal({ harness, revision: await revision(), id: shown!.id, dismissal, repoRoot: repo });
		const state = await harness.snapshot(FindingsDocument, (await harness.root(context)).id, context);
		expect(state!.items[shown!.id]!.lifecycle.dismissedSighting!.sighting.properties).toMatchObject({
			severity: "P1",
			failureScenario: nullDeref.failureScenario,
			source: { check: "lens.correctness" },
		});
		pushElsewhere("other");
		const requests = script([{ ...restatement, failureScenario: refutedScenario }]);
		await review();
		const shownRoot = requests[verifierMarker]!.flatMap((messages) =>
			messages.filter((m) => m.role === "user").flatMap((m) => textOf(m).split("\n\n")),
		).find((block) => block.startsWith("Dismissed d1\n"));
		expect(shownRoot).toContain(JSON.stringify(nullDeref.failureScenario));
		expect(shownRoot).not.toContain(refutedScenario);
	});

	it("lets the scripted verifier answer different by default for each dismissed finding it is shown", async () => {
		await dismissedRoot();
		pushElsewhere("other");
		scriptConversations(fake, [
			{ match: correctness, replies: [report(restatement), fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
		]);
		const second = await review();
		expect(second.verdict.status).toBe("findings");
		expect(second.verdict.attention()).toHaveLength(1);
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
		{ name: "omits a dismissed finding", matches: undefined, says: (root: string) => `; missing ${root}` },
		{
			name: "answers two it was not shown",
			matches: { "0123456789abcdef": "same", fedcba9876543210: "different" },
			says: () => "; not listed 0123456789abcdef, fedcba9876543210",
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
		expect(results).toContain(
			`matches must answer same or different for each dismissed finding listed, d1 ${root}, and no other${says(root)}\n`,
		);
		expect(second).toMatchObject({ code: "verifierFailed" });
		const state = await harness.snapshot(FindingsDocument, (await harness.root(context)).id, context);
		expect(state!.inherited?.[Revision.key(await revision())]).toBeUndefined();
	});

	it("refuses sameness answers from a verifier shown no dismissed finding", async () => {
		const call = (messages: Messages) =>
			messages.some((message) => message.role === "toolResult")
				? fauxAssistantMessage("Done.")
				: fauxAssistantMessage(
						fauxToolCall("report_verdict", {
							claim: "c1",
							answers: { code: "yes", guard: "no", base: "no" },
							verdict: "confirmed",
							reason: "Traced.",
							matches: { "0123456789abcdef": "same" },
						}),
						{ stopReason: "toolUse" },
					);
		const requests = scriptConversations(fake, [
			{ match: correctness, replies: [report(nullDeref), fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
			{ match: verifierMarker, replies: [call, call, call] },
		]);
		await review().catch(() => undefined);
		const results = requests[verifierMarker]!.flat()
			.filter((message) => message.role === "toolResult")
			.map(textOf)
			.join("\n");
		expect(results).toContain(
			"matches must answer same or different for each dismissed finding listed, none here, and no other; not listed 0123456789abcdef\n",
		);
	});

	it("names every listed dismissed finding, and every one a report left out", async () => {
		const spanning = { ...nullDeref, endLine: 9, failureScenario: "managerName throws for a user with no manager." };
		script([nullDeref, spanning]);
		const first = await review();
		const ids = first.verdict.attention().map((each) => each.id);
		expect(ids).toHaveLength(2);
		for (const id of ids)
			await recordDismissal({ harness, revision: await revision(), id, dismissal, repoRoot: repo });
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
						}),
						{ stopReason: "toolUse" },
					);
		const requests = scriptConversations(fake, [
			{ match: correctness, replies: [report(restatement), fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
			{ match: verifierMarker, replies: [call, call, call] },
		]);
		await review().catch(() => undefined);
		const prompt = systemPromptOf(requests[verifierMarker]!.at(-1)!);
		const listed = [...prompt.matchAll(/Dismissed (d[12]) finding ([0-9a-f]{16})/g)].map((match) => match[2]!);
		expect([...listed].sort()).toEqual([...ids].sort());
		const results = requests[verifierMarker]!.flat()
			.filter((message) => message.role === "toolResult")
			.map(textOf)
			.join("\n");
		expect(results).toContain(
			`listed, d1 ${listed[0]}, d2 ${listed[1]}, and no other; missing ${listed[0]}, ${listed[1]}\n`,
		);
	});

	it("keeps a candidate with no root out of the attach key, and puts the roots of one in it", async () => {
		const verification = async () => {
			const owner = (await harness.root(context)).id;
			const index = await harness.snapshot(ReviewIndex, owner, context);
			return index!.reviews[Revision.key(await revision())]!.verification!.input;
		};
		const root = await dismissedRoot();
		expect(await verification()).not.toContain('"dismissed"');
		pushElsewhere("other");
		script([restatement]);
		await review();
		expect(await verification()).toContain(`"dismissed":[{"id":"${root}"`);
	});

	it("links nothing when the verifier did not finish, though one candidate was judged the same", async () => {
		const root = await dismissedRoot();
		pushElsewhere("other");
		const unrelated = {
			...nullDeref,
			line: 3,
			rule: "null-dereference",
			failureScenario: "A user's manager field is read before it is set.",
			evidence: [{ file: "src/user.ts", line: 3, role: "cause" }],
		};
		const verify = (messages: Messages) => {
			const prompt = systemPromptOf(messages);
			// Only the candidate shown the root is judged; the other is left unjudged, so the verifier fails.
			if (!prompt.includes(`Dismissed d1 finding ${root}`)) return fauxAssistantMessage("Done.");
			const claims = [...prompt.matchAll(/Claim c[1-9][0-9]* finding ([0-9a-f]+)/g)].map((m) => m[1]!);
			return scriptVerifier(
				messages,
				Object.fromEntries(
					claims.map((id) => [id, { verdict: "confirmed" as const, matches: { [root]: "same" } }]),
				),
			);
		};
		scriptConversations(fake, [
			{ match: correctness, replies: [report(restatement), report(unrelated), fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
			{ match: verifierMarker, replies: [verify, verify, verify, verify, verify, verify] },
		]);
		const failed = await review().catch((error: { code?: string }) => error);
		expect(failed).toMatchObject({ code: "verifierFailed" });
		const owner = (await harness.root(context)).id;
		const state = await harness.snapshot(FindingsDocument, owner, context);
		const at = Revision.key(await revision());
		const judged = Object.values(state!.items).some((item) =>
			Object.values(item.verifications?.[at] ?? {}).some((records) =>
				Object.values(records).some((record) => record.matches?.[root] === "same"),
			),
		);
		expect(judged).toBe(true);
		expect(state!.inherited?.[at]).toBeUndefined();
	});
});

describe("showing a carried dismissal", () => {
	it("shows a reviewed restatement as inherited from its root, in the terminal and the status", async () => {
		const root = await dismissedRoot();
		pushElsewhere("other");
		script([restatement]);
		const { verdict } = await review();
		const text = verdict.render(new Rendering({ all: true }));
		expect(text.split("\n").filter((line) => line.startsWith("    Dismissed"))).toEqual([
			`    Dismissed, inherited from ${root}, at ${dismissal.at}: ${dismissal.reason}`,
		]);
		expect(text).not.toContain("Tal");
		expect(verdict.reviewStatus()).toEqual({
			state: "success",
			description: `0 findings, 1 dismissed, 1 inherited from ${root}`,
		});
	});

	it("shows an injection attempt that restates a dismissed one neither inherited nor proposed", async () => {
		const injection = { ...nullDeref, rule: injectionAttemptRuleId };
		await dismissedRoot(injection);
		pushElsewhere("other");
		script([{ ...restatement, rule: injectionAttemptRuleId }]);
		const { verdict } = await review();
		const [live] = verdict.attention();
		expect(live!.ruleId).toBe(injectionAttemptRuleId);
		expect(live!.properties.status).toBe("new");
		expect(live!.properties).not.toHaveProperty("likelyDismissedAs");
		expect(live!.likelyDismissalNotes()).toEqual([]);
		const text = verdict.render(new Rendering({ all: true, ids: true }));
		expect(text.split("\n").filter((line) => /inherited|Likely the same|Dismissed/.test(line))).toEqual([]);
		expect(verdict.dismissed).toEqual([]);
	});
});

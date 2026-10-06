import { rmSync } from "node:fs";
import { join } from "node:path";
import { Adjudication, defaultConfig, Finding, type LedgerRound, replyKey } from "@melian-agent/core";
import { createGitHubProvider, Ledger, marker, maxBodyLength, parseMarker, verifyMarker } from "@melian-agent/github";
import {
	backgroundContext as context,
	createMemoryStorage,
	defineDoc,
	type Harness,
	openSqliteStorage,
	publishReview,
	revisionKey,
	summarizeReview,
} from "@melian-agent/pipeline";
import { fauxAssistantMessage, fauxToolCall, scriptConversations, textOf } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerdictDocument } from "../../pipeline/src/adjudication.ts";
import { LedgerDocument, PublishedDocument, PublisherDocument } from "../../pipeline/src/publish.ts";
import { renderResolvedReply } from "../src/publication.ts";
import { fakeGitHub } from "./fixtures/fake-github.ts";
import {
	emptyName,
	isolatedGitEnv,
	lensScript,
	moveTo,
	openPublishHarness,
	pullRequestState,
	pushRevisionThree,
	pushRevisionTwo,
	reviewScenario,
	scenarioModels,
	scenarioRepository,
	stackOnParent,
	unsafeManager,
} from "./fixtures/scenario.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const secret = "11".repeat(32);
const links = { web: "https://github.com/melian-agent/example" };
const finding = Finding.create({
	rule: "unsafe",
	message: "Unsafe input",
	file: "src/run.ts",
	startLine: 7,
	snippet: "run(input)",
	occurrence: 0,
	severity: "P1",
	cause: "introduced",
	resolution: "block",
	source: { check: "lens.security", version: "1" },
	explanation: { what: "Unsafe input", whyHere: "New input", whatToDo: "Validate it" },
});
const verdict = new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate();
const round: LedgerRound = {
	base,
	head,
	round: 1,
	verdict: verdict.toJSON(),
	resolved: [],
	walkthrough: { summary: "A change to input", files: [{ path: "src/run.ts", summary: "Reads input" }] },
};
const options = { pullRequest: 7, secret, walkthrough: { enabled: true, collapsed: true, diagrams: true } };

describe("ledger rendering", () => {
	it("renders run details beside verification outcomes, including refuted claims", () => {
		const judged = Finding.from({
			...finding.toJSON(),
			properties: {
				...finding.properties,
				failureScenario: "Passing unchecked input runs it.",
				evidence: [{ file: "src/run.ts", startLine: 7, role: "context", revision: "head", snippet: "run(input)" }],
				verification: {
					verdict: "confirmed",
					reason: "Traced the failure.",
					executor: "llm",
					model: "fake/judge",
					version: "1",
				},
			},
		});
		const refuted = Finding.from({
			...judged.toJSON(),
			properties: {
				...judged.properties,
				id: "refuted-finding",
				verification: { ...judged.properties.verification!, verdict: "refuted" },
			},
		});
		const current = new Adjudication({
			findings: [judged, refuted],
			manifest: ["verifier"],
			checks: [{ name: "verifier", status: "ran" }],
			config: defaultConfig,
		}).adjudicate();
		const posted: LedgerRound = {
			...round,
			verdict: current.toJSON(),
			details: {
				policy: "config",
				manifest: ["lens.security", "verifier"],
				standards: ["AGENTS.md"],
				lenses: [
					{
						name: "security",
						version: "1",
						level: "careful",
						models: ["fake/finder"],
						ran: "fake/finder",
						budget: { findings: 8 },
					},
				],
			},
		};
		const body = Ledger.from(current, { rounds: [posted] }, options).render(links);
		expect(body).toContain("1 confirmed, 0 plausible, 1 refuted, 0 unverified");
		expect(body).toContain("1 refuted finding not posted");
		expect(body).toContain("<summary>Run details</summary>");
		expect(body).toContain("security@1, careful; route fake/finder; ran on fake/finder");
		expect(body).toContain("Manifest: lens.security, verifier");
	});

	it("stamps the open, blocking and dismissed counts", () => {
		const warning = Finding.from({
			...finding.toJSON(),
			properties: { ...finding.properties, id: "warning-finding", severity: "P3", resolution: "advisory" },
		});
		const dismissed = Finding.from({
			...finding.toJSON(),
			properties: {
				...finding.properties,
				id: "dismissed-finding",
				status: "dismissed",
				dismissal: { by: "Reviewer", reason: "Input is validated upstream.", at: "2026-10-05" },
			},
		});
		const counted = new Adjudication({
			findings: [finding, warning, dismissed],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		const { stamp } = Ledger.from(counted, { rounds: [{ ...round, verdict: counted.toJSON() }] }, options);
		expect(stamp.counts).toEqual({ open: 2, blocking: 1, dismissed: 1 });
	});

	it("reads back a signed stamp and rejects a changed stamp", () => {
		const ledger = Ledger.from(verdict, { rounds: [round] }, options);
		const body = ledger.render(links);
		const marker = parseMarker(body.split("\n")[0]!)!;
		expect(marker.kind).toBe("ledger");
		expect(verifyMarker(marker, secret)).toBe(true);
		expect(Ledger.readStamp(body)).toEqual(ledger.stamp);
		expect(ledger.diff(Ledger.readStamp(body))).toBe(false);
		expect(Ledger.readStamp(body.replace('"round":1', '"round":2'))).toBeUndefined();
	});

	it("switches the walkthrough and keeps earlier rounds collapsed with their heads", () => {
		const earlier = {
			...round,
			head: "c".repeat(40),
			resolved: [{ id: finding.id, ruleId: finding.ruleId, path: "src/run.ts", line: 7, commit: head }],
		};
		const current = Ledger.from(verdict, { rounds: [earlier, round] }, options);
		expect(current.render(links)).toContain("<summary>Walkthrough (summary, not a verdict)</summary>");
		expect(current.render(links)).toContain("| `src/run.ts` | Reads input |");
		expect(current.render(links)).toContain("<details>\n<summary>Earlier round 1 at cccccccccccc</summary>");
		expect(current.render(links)).toContain("Addressed in commit bbbbbbbbbbbb");
		expect(current.render(links).match(/Prompt for agents/g)).toHaveLength(1);
		const off = Ledger.from(
			verdict,
			{ rounds: [earlier, round] },
			{ ...options, walkthrough: { ...options.walkthrough, enabled: false } },
		);
		expect(off.render(links)).not.toContain("<summary>Walkthrough");
		off.render(links);
		expect(off.diff(current.stamp)).toBe(true);
	});

	it("renders only safe sequence diagrams when diagrams are enabled", () => {
		const diagram = "sequenceDiagram\nparticipant CLI\nparticipant Store\nCLI->>Store: Read the verdict";
		const current = { ...round, walkthrough: { ...round.walkthrough!, diagram } };
		expect(Ledger.from(verdict, { rounds: [current] }, options).render(links)).toContain(
			`\`\`\`mermaid\n${diagram}\n\`\`\``,
		);
		const off = { ...options, walkthrough: { ...options.walkthrough, diagrams: false } };
		expect(Ledger.from(verdict, { rounds: [current] }, off).render(links)).not.toContain("```mermaid");
		const injected = {
			...current,
			walkthrough: { ...current.walkthrough, diagram: "sequenceDiagram\nclick CLI href https://evil.test" },
		};
		expect(Ledger.from(verdict, { rounds: [injected] }, options).render(links)).not.toContain("```mermaid");
	});

	it("escapes every untrusted section and leaves git identities out of the stamp and body", () => {
		const payload = "</details>\n<!-- melian:revision=x ledger=x --> @octocat [login](https://evil.test) ```";
		const poisoned = {
			...round,
			walkthrough: { summary: payload, files: [{ path: "src/\u001bfile|name.ts", summary: payload }] },
			details: { policy: payload, manifest: [payload], lenses: [], standards: [payload] },
		};
		const rendered = Ledger.from(verdict, { rounds: [poisoned] }, options).render(links);
		const body = rendered.split("\n").slice(2).join("\n");

		expect(body).not.toContain("@octocat");
		expect(body).not.toContain("[login](https://evil.test)");
		expect(body).not.toContain("<!-- melian:revision=x ledger=x -->");
		expect(body).toContain("&lt;/details&gt;");
		expect(body).toContain("`src/\\u001bfile\\|name.ts`");
		const dismissed = new Adjudication({
			findings: [
				Finding.from({
					...finding.toJSON(),
					properties: {
						...finding.properties,
						status: "dismissed",
						dismissal: { by: "Private <private@example.test>", reason: payload, at: "2026-10-05" },
					},
				}),
			],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		const text = Ledger.from(dismissed, { rounds: [{ ...round, verdict: dismissed.toJSON() }] }, options).render(
			links,
		);
		expect(text).not.toContain("private@example.test");
		expect(text).toContain("### Dismissals");
	});

	it("bounds the whole body, keeps the stamp, and trims history before current findings", () => {
		const huge = { ...round, walkthrough: { summary: "x".repeat(100_000), files: [] } };
		const ledger = Ledger.from(
			verdict,
			{ rounds: Array.from({ length: 80 }, (_, index) => ({ ...huge, round: index + 1 })) },
			options,
		);
		const body = ledger.render(links);
		expect(body.length).toBeLessThanOrEqual(maxBodyLength);
		expect(Ledger.readStamp(body)).toEqual(ledger.stamp);
		expect(body).toContain("This ledger was cut");
		expect(body).toContain("Unsafe input");
		expect(body.match(/<details>/g)?.length ?? 0).toBe(body.match(/<\/details>/g)?.length ?? 0);
	});
	it("leaves earlier rounds that are already one line alone and cuts the walkthrough instead", () => {
		const rounds = [
			{ round: 1, base, head: "c".repeat(40), status: verdict.status },
			{ round: 2, base, head: "d".repeat(40), status: verdict.status },
			{ ...round, round: 3, walkthrough: { summary: "w".repeat(3000), files: [] } },
		];
		const ledger = Ledger.from(verdict, { rounds }, options);
		const roomy = ledger.render(links);
		const body = ledger.render(links, roomy.length - 3300);
		expect(body.length).toBeLessThanOrEqual(roomy.length - 3300);
		expect(body).not.toContain("Details trimmed.");
		expect(body).not.toContain("w".repeat(3000));
		expect(body).toContain("This ledger was cut");
	});
	it("shortens a full earlier round and shrinks the body", () => {
		const rounds = [
			{ ...round, round: 1, walkthrough: { summary: "y".repeat(3000), files: [] } },
			{ ...round, round: 2 },
		];
		const ledger = Ledger.from(verdict, { rounds }, options);
		const roomy = ledger.render(links);
		const body = ledger.render(links, roomy.length - 1000);
		expect(body.length).toBeLessThan(roomy.length);
		expect(body).toMatch(/Earlier round 1 at[^\n]*<\/summary>\n\n[^\n]*Details trimmed\./);
	});
	it("drops the oldest earlier round first and keeps the current round", () => {
		const rounds = Array.from({ length: 6 }, (_, index) => ({
			...round,
			round: index + 1,
			walkthrough: { summary: (index === 5 ? "z" : "y").repeat(800), files: [] },
		}));
		const ledger = Ledger.from(verdict, { rounds }, options);
		const roomy = ledger.render(links);
		const size = roomy.length;
		const body = ledger.render(links, size - 1500);
		expect(body.length).toBeLessThanOrEqual(size - 1500);
		expect(body).toContain("Unsafe input");
		expect(Ledger.readStamp(body)).toEqual(ledger.stamp);
		expect(body).toContain("This ledger was cut");
		expect(body).toMatch(/Earlier round 1 at[^\n]*<\/summary>\n\n[^\n]*Details trimmed\./);
		expect(body).toContain("y".repeat(800));
		expect(body).toContain("z".repeat(800));
	});

	it("rejects visible tampering, truncation and a digest hidden in another marker field", () => {
		const ledger = Ledger.from(verdict, { rounds: [round] }, options);
		const body = ledger.render(links);
		expect(Ledger.readStamp(body.replace("Reads input", "Different text"))).toBeUndefined();
		expect(Ledger.readStamp(body.slice(0, -20))).toBeUndefined();
		const opening = parseMarker(body.split("\n")[0]!)!;
		const wrong = [marker(opening.revision, "ledger", "0123456789abcdef", secret), ...body.split("\n").slice(1)].join(
			"\n",
		);
		expect(parseMarker(wrong.split("\n")[0]!)).toMatchObject({ kind: "ledger", id: "0123456789abcdef" });
		expect(verifyMarker(parseMarker(wrong.split("\n")[0]!)!, secret)).toBe(true);
		expect(Ledger.readStamp(wrong)).toBeUndefined();
		expect(Ledger.readStamp(body)).toBeDefined();
	});

	it("renders no empty agent prompt or unrecorded verifier claim", () => {
		const passed = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig }).adjudicate();
		const body = Ledger.from(passed, { rounds: [{ ...round, verdict: passed.toJSON() }] }, options).render(links);
		expect(passed.agentPrompt("#7")).toBe("");
		expect(body).not.toContain("Prompt for agents");
		expect(body).not.toContain("the verifier has not run");
	});

	it("escapes separator characters in stamps and flattens multiline prose", () => {
		const current = {
			...round,
			details: {
				policy: "policy",
				manifest: [],
				lenses: [
					{ name: "lens\u2028name\u2029", version: "1", level: "careful", models: [], budget: { findings: 1 } },
				],
				standards: [],
			},
			walkthrough: { summary: "one\ntwo", files: [] },
		};
		const ledger = Ledger.from(verdict, { rounds: [current] }, options);
		const body = ledger.render(links);
		expect(body.split("\n")[1]).toContain("\\u2028");
		expect(body.split("\n")[1]).toContain("\\u2029");
		expect(Ledger.readStamp(body)).toEqual(ledger.stamp);
		expect(body).toContain("one two");
		expect(body).not.toContain("one\\u000atwo");
	});

	it("renders a lens lineage in the run details", () => {
		const current = {
			...round,
			details: {
				policy: "policy",
				manifest: [],
				lenses: [
					{
						name: "security",
						version: "1",
						level: "careful",
						models: ["a/b"],
						lineage: "committed lens changed at head",
						budget: { findings: 1 },
					},
				],
				standards: [],
			},
		};
		const body = Ledger.from(verdict, { rounds: [current] }, options).render(links);
		expect(body).toContain("careful; route a/b; committed lens changed at head; budgets");
	});

	it("names each lens's standards and keeps hostile paths inert", () => {
		const hostile = "docs/`[log in](https://evil.test)\n# Approved\u2028@octocat.md";
		const current = {
			...round,
			details: {
				policy: "revision:base",
				manifest: [],
				standards: ["AGENTS.md", "packages/core/AGENTS.md"],
				lenses: [
					{
						name: "contracts",
						version: "1",
						level: "careful",
						models: [],
						budget: { findings: 8 },
						standards: ["packages/core/AGENTS.md", "AGENTS.md", hostile],
					},
				],
			},
		};
		const body = Ledger.from(verdict, { rounds: [current] }, options).render(links);
		expect(body).toContain("Standards: AGENTS.md, packages/core/AGENTS.md");
		const start = body.indexOf("<summary>Run details</summary>");
		const runDetails = body.slice(start, body.indexOf("</details>", start));
		expect(runDetails).toContain(
			"; standards `packages/core/AGENTS.md`, `AGENTS.md`, ``docs/`[log in](https://evil.test)\\u000a# Approved\\u2028@octocat.md``",
		);
		expect(runDetails).not.toContain(hostile);
		expect(runDetails).not.toContain("\n# Approved");
		expect(runDetails).not.toContain("\u2028");
	});

	it("keeps markdown in a finding path inert inside the agent prompt", () => {
		const hostile = Finding.create({
			rule: "unsafe",
			message: "Unsafe input",
			file: "src/`~~~\n```\n</details>[x](https://evil.test)*a*.ts",
			startLine: 7,
			snippet: "run(input)",
			occurrence: 0,
			severity: "P1",
			cause: "introduced",
			resolution: "block",
			source: { check: "lens.security", version: "1" },
			explanation: { what: "Unsafe input", whyHere: "New input", whatToDo: "Validate it" },
		});
		const hostileVerdict = new Adjudication({
			findings: [hostile],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		const body = Ledger.from(
			hostileVerdict,
			{ rounds: [{ ...round, verdict: hostileVerdict.toJSON() }] },
			options,
		).render(links);
		const prompt = body.slice(body.indexOf("<summary>Prompt for agents</summary>"));
		const lines = prompt.split("\n");
		expect(lines.filter((line) => /^\s*(`{3,}|~{3,})/.test(line))).toEqual(["```text", "```"]);
		expect(lines.filter((line) => line.startsWith("</details>"))).toHaveLength(1);
		expect(prompt).toContain("\\u0060");
		expect(prompt).toContain("\\u000a");
	});

	it("neutralises autolinks in walkthrough text", () => {
		const payload = "https://evil.test www.evil.test _www.x.test *www.y.test (www.z.test user@evil.test GH-123";
		const body = Ledger.from(
			verdict,
			{
				rounds: [
					{
						...round,
						walkthrough: {
							summary: payload,
							files: [{ path: "src/run.ts", summary: payload }],
							diagram: payload,
						},
					},
				],
			},
			options,
		).render(links);
		expect(body).not.toContain("https://evil.test");
		expect(body).not.toContain("www.evil.test");
		for (const host of ["www.x.test", "www.y.test", "www.z.test"]) expect(body).not.toContain(host);
		expect(body).not.toContain("user@evil.test");
		expect(body).not.toContain("GH-123");
	});

	it("bounds the walkthrough before losing dismissals, run details or the prompt", () => {
		const dismissed = Finding.from({
			...finding.toJSON(),
			properties: {
				...finding.properties,
				id: "dismissed-finding",
				status: "dismissed",
				dismissal: { by: "Reviewer", reason: "Input is validated upstream.", at: "2026-10-05" },
			},
		});
		const currentVerdict = new Adjudication({
			findings: [finding, dismissed],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		const ledger = Ledger.from(
			currentVerdict,
			{
				rounds: [
					{
						...round,
						walkthrough: {
							summary: "summary",
							files: Array.from({ length: 6 }, (_, index) => ({
								path: `src/run${index}.ts`,
								summary: "x".repeat(1500),
							})),
						},
					},
				],
			},
			options,
		);
		const whole = ledger.render(links, 100_000);
		expect(whole).toContain("src/run5.ts");
		expect(whole).not.toContain("Walkthrough details trimmed.");
		expect(whole.length).toBeGreaterThan(9000);
		const cut = ledger.render(links, 9000);
		expect(cut.length).toBeLessThanOrEqual(9000);
		expect(cut).toContain("This ledger was cut");
		expect(cut).not.toContain("<summary>Walkthrough");
		expect(cut).not.toContain("src/run0.ts");
		expect(cut).toContain("<summary>Run details");
		expect(cut).toContain("<summary>Prompt for agents");
		expect(cut).toContain("### Dismissals");
		expect(cut).toContain("Input is validated upstream.");
		expect(Ledger.readStamp(cut)).toBeDefined();
	});

	it("cuts a walkthrough over 12,000 characters and says so", () => {
		const long = {
			...round,
			walkthrough: {
				summary: "summary",
				files: Array.from({ length: 100 }, (_, index) => ({ path: `src/f${index}.ts`, summary: "x".repeat(2000) })),
			},
		};
		const body = Ledger.from(verdict, { rounds: [long] }, options).render(links);
		expect(body).toContain("Walkthrough details trimmed.");
		expect(body).not.toContain("src/f99.ts");
		expect(body.length).toBeLessThan(40_000);
	});

	it("changes the stamp for each walkthrough switch alone", () => {
		const current = { ...round, walkthrough: { ...round.walkthrough!, diagram: "sequenceDiagram\nparticipant CLI" } };
		const on = Ledger.from(verdict, { rounds: [current] }, options);
		on.render(links);
		for (const setting of ["enabled", "collapsed", "diagrams"] as const) {
			const off = Ledger.from(
				verdict,
				{ rounds: [current] },
				{ ...options, walkthrough: { ...options.walkthrough, [setting]: false } },
			);
			off.render(links);
			expect(off.diff(on.stamp)).toBe(true);
		}
	});
});

let repo: string;
let harness: Harness | undefined;
beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = scenarioRepository();
});
afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

describe("ledger publication", { timeout: 60_000 }, () => {
	it("creates then edits one ledger, recovers a lost record, and stores the summarise task's bounded output", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager, emptyName));
		await first.review;
		moveTo(state, first.changeset);
		const captured = scriptConversations(fake, [
			{
				match: "You write Melian's walkthrough",
				replies: [
					fauxAssistantMessage(
						[
							fauxToolCall("record_walkthrough", {
								summary: "Makes the manager lookup unsafe.",
								files: [{ path: "src/user.ts", summary: "Removes the absent manager fallback." }],
							}),
						],
						{ stopReason: "toolUse" },
					),
				],
			},
		]);
		const ref = fake.ref("scripted");
		await summarizeReview({
			harness,
			changeset: first.changeset,
			config: { ...defaultConfig, models: { light: { model: `${ref.provider}/${ref.modelId}` } } },
			models: fake.review,
		});
		const prompt = captured["You write Melian's walkthrough"]![0]!.map(textOf).join("\n");
		expect(prompt).toContain("<untrusted-");
		expect(prompt).toContain('label="file"');
		expect(prompt).toContain("return (user.manager as User).name;");
		const publish = async (changeset: typeof first.changeset, enabled = true) =>
			publishReview({
				harness: harness!,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
				walkthrough: { enabled, collapsed: true, diagrams: true },
			});
		await publish(first.changeset);
		expect(state.ledgers).toHaveLength(1);
		const id = state.ledgers[0]!.id;
		expect(state.ledgers[0]!.body).toContain("Removes the absent manager fallback.");
		const doc = await harness.snapshot(VerdictDocument, (await harness.root(context)).id, context);
		const details = doc?.details?.[revisionKey(first.changeset.revision)];
		expect(details?.policy).toBe(`revision:${first.changeset.revision.base}`);
		expect(details?.manifest).toContain("lens.correctness");
		expect(details?.lenses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "correctness",
					level: "careful",
					ran: expect.any(String),
					usage: expect.objectContaining({ tokens: expect.any(Number), cost: expect.any(Number) }),
				}),
			]),
		);
		expect(details!.lenses[0]!.usage!.tokens).toBeGreaterThan(0);
		expect(state.ledgers[0]!.body).toContain(
			`correctness@${details!.lenses.find(({ name }) => name === "correctness")!.version}`,
		);
		expect(state.ledgers[0]!.body).toContain("tokens, $");
		expect(state.ledgers[0]!.body).toContain(`ran on ${details!.lenses[0]!.ran}`);
		expect(Ledger.readStamp(state.ledgers[0]!.body)?.plan).not.toBeNull();
		const patchesBefore = state.calls.filter(({ method }) => method === "PATCH").length;
		await publish(first.changeset, false);
		expect(state.calls.filter(({ method }) => method === "PATCH")).toHaveLength(patchesBefore + 1);
		expect(state.ledgers[0]!.body).not.toContain("<summary>Walkthrough");
		expect(state.statuses.at(-1)?.target_url).toBe(state.ledgers[0]!.html_url);
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness, fake, lensScript(emptyName));
		await second.review;
		moveTo(state, second.changeset);
		await publish(second.changeset, false);
		expect(state.ledgers).toHaveLength(1);
		expect(state.ledgers[0]!.id).toBe(id);
		expect(Ledger.readStamp(state.ledgers[0]!.body)?.head).toBe(second.changeset.revision.head);
		expect(state.ledgers[0]!.body).toContain(`Earlier round 1 at ${first.changeset.revision.head.slice(0, 12)}`);
		expect(state.ledgers[0]!.body).not.toContain("<summary>Walkthrough");
		const rootState = (await harness.snapshot(PublishedDocument, (await harness.root(context)).id, context))!;
		expect(rootState.ledgerRounds?.[0]).toEqual({
			base: first.changeset.revision.base,
			head: first.changeset.revision.head,
			round: 1,
			status: "findings",
		});
		expect(rootState.ledgerRounds?.[0]).not.toHaveProperty("verdict");
		const writes = state.calls.filter(({ method }) => method === "POST" || method === "PATCH").length;
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			delete (await tx.doc(LedgerDocument, root.id)).comment;
		}, context);
		await publish(second.changeset, false);
		expect(state.calls.filter(({ method }) => method === "POST" || method === "PATCH")).toHaveLength(writes);
		expect((await harness.snapshot(LedgerDocument, root.id, context))?.comment?.id).toBe(String(id));
	});

	it("refuses an orphaned ledger instead of creating a second one", async () => {
		const state = pullRequestState();
		state.ledgers.push({
			id: 17,
			user: { login: state.login },
			body: Ledger.from(verdict, { rounds: [round] }, options).render(links),
			html_url: "https://example.test/17",
		});
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		await expect(provider.findLedger(7, "22".repeat(32))).rejects.toThrow("delete the orphaned ledger");
		expect(state.ledgers).toHaveLength(1);
	});

	it("carries an accepted edit to a later head and finishes thread resolution without repeating the edit", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		let interrupt = true;
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state, (call) => {
				if (interrupt && call.method === "PATCH" && call.path.includes("/pulls/comments/")) {
					state.failReplies = true;
				}
			}),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager, emptyName));
		await first.review;
		moveTo(state, first.changeset);
		const publish = async (changeset: typeof first.changeset) =>
			publishReview({
				harness: harness!,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
			});
		await publish(first.changeset);
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness, fake, lensScript(emptyName));
		await second.review;
		moveTo(state, second.changeset);
		await expect(publish(second.changeset)).rejects.toThrow();
		expect(state.resolvedThreads).toEqual([]);
		const edits = state.calls.filter(({ method, path }) => method === "PATCH" && path.includes("/pulls/comments/"));
		expect(edits).toHaveLength(1);
		interrupt = false;
		state.failReplies = false;
		pushRevisionThree(repo);
		const third = await reviewScenario(repo, harness, fake, lensScript(emptyName));
		await third.review;
		moveTo(state, third.changeset);
		await publish(third.changeset);
		expect(state.resolvedThreads).toHaveLength(1);
		expect(state.calls.filter(({ method, path }) => method === "PATCH" && path.includes("/pulls/comments/"))).toEqual(
			edits,
		);
		expect(state.ledgers).toHaveLength(1);
		expect(state.ledgers[0]!.body).toContain(`Addressed in commit ${second.changeset.revision.head.slice(0, 12)}`);
	});
	it.each(["unsigned", "copied"])("ignores a stranger's %s ledger marker through publishReview", async (kind) => {
		const fake = scenarioModels();
		const state = pullRequestState();
		state.ledgers.push({
			id: 17,
			user: { login: "stranger" },
			body:
				kind === "unsigned"
					? `<!-- melian:revision=${head} ledger=0123456789abcdef -->`
					: Ledger.from(verdict, { rounds: [round] }, options).render(links),
			html_url: "https://example.test/17",
		});
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager));
		await first.review;
		moveTo(state, first.changeset);
		await publishReview({
			harness,
			provider,
			changeset: first.changeset,
			pullRequest: await provider.pullRequest(7),
			base: first.changeset.revision.base,
		});
		expect(state.reviews).toHaveLength(1);
		expect(state.ledgers).toHaveLength(2);
		expect(state.ledgers[0]!.user.login).toBe("stranger");
		expect(state.calls.filter(({ method, path }) => method === "PATCH" && path.endsWith("/17"))).toEqual([]);
	});

	it("posts the current status and review before refusing an orphaned own ledger", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		state.ledgers.push({
			id: 17,
			user: { login: state.login },
			body: Ledger.from(verdict, { rounds: [round] }, options).render(links),
			html_url: "https://example.test/17",
		});
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager));
		await first.review;
		moveTo(state, first.changeset);
		state.statuses.push({
			sha: first.changeset.revision.head,
			state: "success",
			description: "old pass",
			context: "melian/review",
		});
		await expect(
			publishReview({
				harness,
				provider,
				changeset: first.changeset,
				pullRequest: await provider.pullRequest(7),
				base: first.changeset.revision.base,
			}),
		).rejects.toThrow("delete the orphaned ledger");
		expect(state.statuses[1]?.state).toBe("failure");
		expect(state.statuses.at(-1)).toMatchObject({
			state: "error",
			description: expect.stringContaining("delete the ledger comment"),
		});
		expect(state.reviews).toHaveLength(1);
		expect(state.ledgers).toHaveLength(1);
		expect(
			state.calls.findIndex(({ method, path }) => method === "POST" && path.includes("/statuses/")),
		).toBeLessThan(state.calls.findIndex(({ method, path }) => method === "GET" && path.includes("/issues/")));
	});

	it("leaves the verdict's status alone when a ledger write fails for another reason", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		state.failLedger = true;
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager));
		await first.review;
		moveTo(state, first.changeset);
		await expect(
			publishReview({
				harness,
				provider,
				changeset: first.changeset,
				pullRequest: await provider.pullRequest(7),
				base: first.changeset.revision.base,
			}),
		).rejects.toThrow("create the review ledger");
		expect(state.statuses.map(({ state: each }) => each)).toEqual(["failure"]);
		expect(state.statuses.some(({ description }) => description.includes("ledger"))).toBe(false);
	});

	it.each(["marker", "stamp", "body"])(
		"fetches the recorded id and refuses a damaged %s without duplicating the ledger",
		async (damaged) => {
			const fake = scenarioModels();
			const state = pullRequestState();
			const provider = createGitHubProvider({
				owner: state.owner,
				repo: state.repo,
				token: "test-token",
				fetch: fakeGitHub(state),
			});
			harness = await openPublishHarness(createMemoryStorage(), fake, provider);
			const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager));
			await first.review;
			moveTo(state, first.changeset);
			const publish = async () =>
				publishReview({
					harness: harness!,
					provider,
					changeset: first.changeset,
					pullRequest: await provider.pullRequest(7),
					base: first.changeset.revision.base,
				});
			await publish();
			const comment = state.ledgers[0]!;
			comment.body =
				damaged === "marker"
					? comment.body.split("\n").slice(1).join("\n")
					: damaged === "stamp"
						? comment.body.replace('"round":1', '"round":2')
						: `${comment.body}changed`;
			state.calls = [];
			await expect(publish()).rejects.toThrow(/delete .*ledger comment/);
			expect(state.calls).toContainEqual({
				method: "GET",
				path: `/repos/${state.owner}/${state.repo}/issues/comments/${comment.id}`,
			});
			expect(state.calls.some(({ path }) => path.includes("/issues/7/comments"))).toBe(false);
			expect(state.ledgers).toHaveLength(1);
		},
	);

	it("refuses a recorded foreign ledger while ignoring foreign markers during scanning", async () => {
		const state = pullRequestState();
		const comment = {
			id: 17,
			user: { login: "stranger" },
			body: Ledger.from(verdict, { rounds: [round] }, options).render(links),
			html_url: "https://example.test/17",
		};
		state.ledgers.push(comment);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		expect(await provider.findLedger(7, secret)).toBeUndefined();
		await expect(
			provider.findLedger(7, secret, {
				id: "17",
				url: comment.html_url,
				stamp: Ledger.readStamp(comment.body)!,
				author: state.login,
			}),
		).rejects.toThrow("another publisher");
	});

	it("uses the posted review author instead of an edited older comment when the login is unknown", async () => {
		const state = pullRequestState();
		state.failUser = true;
		const body = Ledger.from(verdict, { rounds: [round] }, options).render(links);
		state.ledgers.push(
			{
				id: 17,
				user: { login: state.login },
				body,
				html_url: "https://example.test/17",
				created_at: "2026-01-01T00:00:00Z",
			},
			{
				id: 18,
				user: { login: "stranger" },
				body,
				html_url: "https://example.test/18",
				created_at: "2025-12-01T00:00:00Z",
			},
		);
		state.ledgers.reverse();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		state.reviews.push({
			id: 19,
			user: { login: state.login },
			body: "Posted review",
			commit_id: head,
			event: "COMMENT",
		});
		const found = await provider.findLedger(7, secret, undefined, "19");
		expect(found?.id).toBe("17");
		const edited = { ...options, verdict, review: "19", publication: { rounds: [{ ...round, round: 2 }] } };
		await provider.writeLedger(edited);
		expect(state.calls.filter(({ method, path }) => method === "PATCH" && path.endsWith("/comments/18"))).toEqual([]);
		expect(state.ledgers.find((comment) => comment.id === 18)?.body).toBe(body);
	});

	it("refuses a damaged stamp during marker discovery with deletion instructions", async () => {
		const state = pullRequestState();
		state.ledgers.push({
			id: 17,
			user: { login: state.login },
			body: Ledger.from(verdict, { rounds: [round] }, options)
				.render(links)
				.replace('"round":1', '"round":2'),
			html_url: "https://example.test/17",
		});
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		await expect(provider.findLedger(7, secret)).rejects.toThrow("delete the ledger comment");
	});

	it("uses the recorded id and author with installation tokens and rejects copied comments", async () => {
		const state = pullRequestState();
		state.failUser = true;
		const comment = {
			id: 17,
			user: { login: state.login },
			body: Ledger.from(verdict, { rounds: [round] }, options).render(links),
			html_url: "https://example.test/17",
		};
		state.ledgers.push(comment);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		const recorded = {
			id: "17",
			url: comment.html_url,
			stamp: Ledger.readStamp(comment.body)!,
			author: state.login,
		};
		expect(await provider.findLedger(7, secret, recorded)).toEqual(recorded);
		expect(await provider.findLedger(7, secret)).toBeUndefined();
		const lookalike = {
			id: 18,
			user: { login: "stranger" },
			body: comment.body.replace(/ledger=\S+/, "ledger=forged"),
			html_url: "https://example.test/18",
		};
		state.ledgers.splice(0, state.ledgers.length, lookalike);
		expect(await provider.findLedger(7, secret)).toBeUndefined();
		state.ledgers.splice(0, state.ledgers.length, comment);
		comment.user.login = "stranger";
		await expect(provider.findLedger(7, secret, recorded)).rejects.toThrow("another publisher");
		await expect(provider.findLedger(7, secret, { ...recorded, author: undefined })).rejects.toThrow("unknown");
	});

	it("finds an unrecorded ledger through its recorded review under an installation token", async () => {
		const state = pullRequestState();
		state.failUser = true;
		const connect = () =>
			createGitHubProvider({ owner: state.owner, repo: state.repo, token: "test-token", fetch: fakeGitHub(state) });
		state.reviews.push({
			id: 19,
			user: { login: state.login },
			body: "Posted review",
			commit_id: head,
			event: "COMMENT",
		});
		const draft = { ...options, verdict, review: "19", publication: { rounds: [round] } };
		await connect().writeLedger(draft);
		expect(state.ledgers).toHaveLength(1);
		const edited = { ...draft, publication: { rounds: [{ ...round, round: 2 }] } };
		const again = await connect().writeLedger(edited);
		expect(state.ledgers).toHaveLength(1);
		expect(again.id).toBe(String(state.ledgers[0]!.id));
		expect(state.ledgers[0]!.body).toBe(Ledger.from(verdict, edited.publication, options).render(links));
	});

	it("creates a fresh ledger when neither the login nor a posted review is known", async () => {
		const state = pullRequestState();
		state.failUser = true;
		const body = Ledger.from(verdict, { rounds: [round] }, options).render(links);
		state.ledgers.push({ id: 17, user: { login: "stranger" }, body, html_url: "https://example.test/17" });
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		expect(await provider.findLedger(7, secret)).toBeUndefined();
		const posted = await provider.writeLedger({ ...options, verdict, publication: { rounds: [round] } });
		expect(posted.id).not.toBe("17");
		expect(state.ledgers[0]!.body).toBe(body);
		expect(state.ledgers).toHaveLength(2);
	});

	it("keeps the newest 50 rounds, so round 51 drops the oldest", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager));
		await first.review;
		moveTo(state, first.changeset);
		const publish = async (changeset: typeof first.changeset) =>
			publishReview({
				harness: harness!,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
			});
		await publish(first.changeset);
		const root = (await harness.root(context)).id;
		const filler = Array.from({ length: 49 }, (_, index) => ({
			base: "b".repeat(40),
			head: "c".repeat(40),
			round: index + 1,
			status: "passed" as const,
		}));
		await (await harness.root(context)).commit(async (tx) => {
			const doc = await tx.doc(PublishedDocument, root);
			doc.ledgerRounds = [...filler, ...doc.ledgerRounds!];
		}, context);
		expect((await harness.snapshot(PublishedDocument, root, context))!.ledgerRounds).toHaveLength(50);
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness, fake, lensScript(unsafeManager));
		await second.review;
		moveTo(state, second.changeset);
		await publish(second.changeset);
		const rounds = (await harness.snapshot(PublishedDocument, root, context))!.ledgerRounds!;
		expect(rounds).toHaveLength(50);
		expect(rounds[0]).toMatchObject({ round: 2, head: "c".repeat(40) });
		expect(rounds.at(-1)).toMatchObject({ head: second.changeset.revision.head });
	});

	it("refuses the ledger write when the head moves after the review posts", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const moved = "f".repeat(40);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state, ({ method, path }) => {
				if (method === "POST" && path.endsWith("/reviews")) state.pull.head.sha = moved;
			}),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const { changeset, review } = await reviewScenario(repo, harness, fake, lensScript());
		await review;
		moveTo(state, changeset);
		const waited = vi.spyOn(harness, "waitForTask");
		const refused = await publishReview({
			harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: changeset.revision.base,
		}).catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: "staleTarget", pullRequest: 7 });
		expect((refused as Error).message).toContain(`its head moved to ${moved.slice(0, 12)}`);
		expect(state.reviews).toHaveLength(1);
		expect(state.ledgers).toEqual([]);
		expect(state.calls.filter(({ path }) => path.includes("/issues/"))).toEqual([]);
		const root = (await harness.root(context)).id;
		expect(await harness.snapshot(LedgerDocument, root, context)).toBeUndefined();
		const task = await harness.getTask(waited.mock.calls.at(-1)![0], context);
		expect(task?.state).toMatchObject({
			status: "terminal",
			outcome: {
				status: "completed",
				result: { kind: "staleTarget", reason: `its head moved to ${moved.slice(0, 12)}` },
			},
		});
	});

	it("recovers an old resolved reply and still resolves its open thread", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager, emptyName));
		await first.review;
		moveTo(state, first.changeset);
		const publish = async (changeset: typeof first.changeset) =>
			publishReview({
				harness: harness!,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
			});
		await publish(first.changeset);
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness, fake, lensScript(emptyName));
		await second.review;
		moveTo(state, second.changeset);
		const opening = state.comments[0]!;
		const id = parseMarker(opening.body.split("\n")[0]!)!.id;
		const publisher = (await harness.snapshot(PublisherDocument, (await harness.root(context)).id, context))!;
		state.comments.push({
			...opening,
			id: 9000,
			in_reply_to_id: opening.id,
			body: renderResolvedReply(
				{ id, ruleId: "x", path: opening.path, line: opening.line } as Parameters<typeof renderResolvedReply>[0],
				second.changeset.revision.head,
				publisher.secret!,
			),
		});
		expect(state.resolvedThreads).toEqual([]);
		const repliesBefore = state.comments.length;
		await publish(second.changeset);
		expect(state.resolvedThreads).toEqual([opening.id]);
		expect(state.comments).toHaveLength(repliesBefore);
		expect(state.calls.filter(({ method, path }) => method === "PATCH" && path.includes("/pulls/comments/"))).toEqual(
			[],
		);
		const stored = (await harness.snapshot(PublishedDocument, (await harness.root(context)).id, context))!;
		expect(Object.values(stored.revisions[second.changeset.revision.head]!.replies)).toEqual(["9000"]);
	});

	it.each([
		{ version: 2, earlier: false },
		{ version: 5, earlier: false },
		{ version: 2, earlier: true },
		{ version: 5, earlier: true },
	])(
		"resolves a recorded version $version reply (earlier head: $earlier) without posting again",
		async ({ version, earlier }) => {
			const fake = scenarioModels();
			const state = pullRequestState();
			const provider = createGitHubProvider({
				owner: state.owner,
				repo: state.repo,
				token: "test-token",
				fetch: fakeGitHub(state),
			});
			const database = join(repo, ".git", "published.sqlite");
			harness = await openPublishHarness(await openSqliteStorage(database), fake, provider);
			const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager));
			const firstReview = await first.review;
			pushRevisionTwo(repo);
			const second = await reviewScenario(repo, harness, fake, lensScript());
			const reviewed = await second.review;
			moveTo(state, second.changeset);
			const id = Object.values(firstReview.verdict.findings).flat()[0]!.id;
			const thread = "1002";
			const key = replyKey(id, thread);
			const entry = {
				ruleId: "null-dereference",
				path: "src/user.ts",
				line: 7,
				revision: first.changeset.revision.head,
				thread,
			};
			const opening = {
				id: Number(thread),
				user: { login: state.login },
				body: marker(entry.revision, "finding", id, secret),
				path: entry.path,
				line: entry.line,
				side: "RIGHT",
				pull_request_review_id: 1001,
			};
			state.comments.push(opening, {
				...opening,
				id: 9000,
				in_reply_to_id: opening.id,
				body: renderResolvedReply({ id, ...entry }, second.changeset.revision.head, secret),
			});
			state.reviews.push({
				id: 1001,
				user: opening.user,
				body: "Old review",
				commit_id: second.changeset.revision.head,
				event: "COMMENT",
			});
			const record = {
				reviews: ["1001"],
				verdict: reviewed.verdict.fingerprint(),
				verdictRevision: revisionKey(second.changeset.revision),
				rounds: 1,
				open: {},
				resolved: { [id]: entry },
				replies: { [version < 3 ? id : key]: "9000" },
			};
			const oldPublished = defineDoc<{ order: string[]; revisions: Record<string, typeof record> }>({
				kind: "melian.published",
				version,
				scope: "conversation",
				history: "latest",
				fork: "current",
				initial: () => ({ order: [], revisions: {} }),
			});
			let current = second;
			if (earlier) {
				pushRevisionThree(repo);
				current = await reviewScenario(repo, harness, fake, lensScript());
				await current.review;
				moveTo(state, current.changeset);
			}
			let root = (await harness.root(context)).id;
			await harness.commit(async (tx) => {
				const doc = await tx.doc(oldPublished, root);
				doc.order = [second.changeset.revision.head];
				doc.revisions = { [second.changeset.revision.head]: record };
				(await tx.doc(PublisherDocument, root)).secret = secret;
			}, context);
			await harness.close(context);
			harness = await openPublishHarness(await openSqliteStorage(database), fake, provider);
			root = (await harness.root(context)).id;
			const publish = async () =>
				publishReview({
					harness: harness!,
					provider,
					changeset: current.changeset,
					pullRequest: await provider.pullRequest(7),
					base: current.changeset.revision.base,
				});
			expect(state.resolvedThreads).toEqual([]);
			await publish();
			expect(state.resolvedThreads).toEqual([opening.id]);
			expect(state.comments).toHaveLength(2);
			expect(state.reviews).toHaveLength(earlier ? 2 : 1);
			expect(
				state.calls.filter(({ method, path }) => method === "PATCH" && path.includes("/pulls/comments/")),
			).toEqual([]);
			const stored = (await harness.snapshot(PublishedDocument, root, context))!.revisions[
				second.changeset.revision.head
			]!;
			expect(stored.replies).toEqual({ [key]: "9000" });
			expect(stored.threadResolutions).toEqual({ [key]: true });
			const writes = state.calls.filter(({ method }) => method === "POST" || method === "PATCH");
			await publish();
			expect(state.calls.filter(({ method }) => method === "POST" || method === "PATCH")).toEqual(writes);
		},
	);

	it("starts a fresh ledger when the recorded comment was deleted by hand", async () => {
		const state = pullRequestState();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		const draft = { ...options, verdict, publication: { rounds: [round] } };
		const first = await provider.writeLedger(draft);
		state.ledgers.length = 0;
		expect(await provider.findLedger(7, secret, first)).toBeUndefined();
		const second = await provider.writeLedger({ ...draft, recorded: first });
		expect(state.ledgers).toHaveLength(1);
		expect(second.id).toBe(String(state.ledgers[0]!.id));
	});

	it("never adopts a stranger's copy of the ledger when the recorded comment is gone and the login is unknown", async () => {
		const state = pullRequestState();
		state.failUser = true;
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		const body = Ledger.from(verdict, { rounds: [round] }, options).render(links);
		const copy = { id: 18, user: { login: "stranger" }, body, html_url: "https://example.test/18" };
		state.ledgers.push(copy);
		const recorded = {
			id: "17",
			url: "https://example.test/17",
			stamp: Ledger.readStamp(body)!,
			author: state.login,
		};
		expect(await provider.findLedger(7, secret, recorded)).toBeUndefined();
		const written = await provider.writeLedger({
			...options,
			verdict,
			publication: { rounds: [round] },
			recorded,
		});
		expect(written.id).not.toBe("18");
		expect(written.author).toBe(state.login);
	});

	it("resolves markerless finding threads, records null and shares one thread lookup", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager, emptyName));
		await first.review;
		moveTo(state, first.changeset);
		const publish = async (changeset: typeof first.changeset) =>
			publishReview({
				harness: harness!,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
			});
		await publish(first.changeset);
		for (const comment of state.comments) comment.body = "Edited by the maintainer.";
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness, fake, lensScript());
		await second.review;
		moveTo(state, second.changeset);
		state.calls = [];
		await publish(second.changeset);
		expect(state.resolvedThreads).toHaveLength(2);
		expect(state.calls.filter(({ method, path }) => method === "PATCH" && path.includes("/pulls/comments/"))).toEqual(
			[],
		);
		expect(
			state.calls.filter(
				({ path, body }) => path === "/graphql" && JSON.stringify(body).includes("reviewThreads(first:"),
			),
		).toHaveLength(1);
		const replies = (await harness.snapshot(PublishedDocument, (await harness.root(context)).id, context))!.revisions[
			second.changeset.revision.head
		]!.replies;
		expect(Object.values(replies)).toEqual([null, null]);
		await publish(second.changeset);
		expect(state.resolvedThreads).toHaveLength(2);
	});

	it("reads every page of review threads before resolving addressed findings", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		state.threadPageSize = 1;
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager, emptyName));
		await first.review;
		moveTo(state, first.changeset);
		const publish = async (changeset: typeof first.changeset) =>
			publishReview({
				harness: harness!,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
			});
		await publish(first.changeset);
		expect(state.comments.length).toBeGreaterThanOrEqual(2);
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness, fake, lensScript());
		await second.review;
		moveTo(state, second.changeset);
		state.calls = [];
		await publish(second.changeset);
		expect(state.resolvedThreads).toHaveLength(2);
		expect(
			state.calls.filter(
				({ path, body }) => path === "/graphql" && JSON.stringify(body).includes("reviewThreads(first:"),
			),
		).toHaveLength(2);
	});

	it("keeps the ledger link when a later round is abandoned", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager));
		await first.review;
		moveTo(state, first.changeset);
		const publish = async (changeset: typeof first.changeset) =>
			publishReview({
				harness: harness!,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
			});
		await publish(first.changeset);
		const url = state.ledgers[0]!.html_url;
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness, fake, lensScript());
		await second.review;
		moveTo(state, second.changeset);
		state.failReviews = true;
		for (let i = 0; i < 3; i++) await expect(publish(second.changeset)).rejects.toThrow();
		expect(state.statuses.at(-1)).toMatchObject({ state: "error", target_url: url });
	});

	it("numbers ledger rounds by posted rounds and keeps one for a repeat publish after an abandoned round", async () => {
		stackOnParent(repo);
		const fake = scenarioModels();
		const state = pullRequestState();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		const changesets: Awaited<ReturnType<typeof reviewScenario>>["changeset"][] = [];
		for (const range of ["main...feature", "parent...feature"]) {
			const review = await reviewScenario(repo, harness, fake, lensScript(unsafeManager), false, { range });
			await review.review;
			changesets.push(review.changeset);
		}
		const publish = async (changeset: (typeof changesets)[number]) => {
			moveTo(state, changeset);
			return publishReview({
				harness: harness!,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
			});
		};
		await publish(changesets[0]!);
		state.failReviews = true;
		for (let i = 0; i < 3; i++) await expect(publish(changesets[1]!)).rejects.toThrow();
		state.failReviews = false;
		await publish(changesets[0]!);
		const rounds = (await harness.snapshot(PublishedDocument, (await harness.root(context)).id, context))!
			.ledgerRounds!;
		expect(rounds.map(({ round }) => round)).toEqual([1]);
		expect(rounds[0]).toHaveProperty("verdict");
	});

	it("adds one round for a base-only retarget and prunes older stored detail", async () => {
		stackOnParent(repo);
		const fake = scenarioModels();
		const state = pullRequestState();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, provider);
		for (const range of ["main...feature", "parent...feature"]) {
			const review = await reviewScenario(repo, harness, fake, lensScript(unsafeManager), false, { range });
			await review.review;
			moveTo(state, review.changeset);
			await publishReview({
				harness,
				provider,
				changeset: review.changeset,
				pullRequest: await provider.pullRequest(7),
				base: review.changeset.revision.base,
			});
		}
		const rounds = (await harness.snapshot(PublishedDocument, (await harness.root(context)).id, context))!
			.ledgerRounds!;
		expect(rounds.map(({ round }) => round)).toEqual([1, 2]);
		expect(rounds[0]).not.toHaveProperty("verdict");
		expect(rounds[0]).not.toHaveProperty("details");
		expect(rounds[0]).not.toHaveProperty("walkthrough");
	});
});

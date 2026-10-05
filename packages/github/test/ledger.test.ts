import { rmSync } from "node:fs";
import { Adjudication, defaultConfig, Finding, type LedgerRound } from "@melian-agent/core";
import {
	createGitHubProvider,
	Ledger,
	maxBodyLength,
	parseLedgerStamp,
	parseMarker,
	verifyMarker,
} from "@melian-agent/github";
import {
	backgroundContext as context,
	createMemoryStorage,
	type Harness,
	publishReview,
	summariseReview,
} from "@melian-agent/pipeline";
import { fauxAssistantMessage, fauxToolCall, scriptConversations, textOf } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerDocument } from "../../pipeline/src/publish.ts";
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
	it("reads back a signed stamp and rejects a changed stamp", () => {
		const ledger = Ledger.from(verdict, { rounds: [round] }, options);
		const body = ledger.render(links);
		const marker = parseMarker(body.split("\n")[0]!)!;
		expect(marker.kind).toBe("ledger");
		expect(verifyMarker(marker, secret)).toBe(true);
		expect(parseLedgerStamp(body)).toEqual(ledger.stamp);
		expect(ledger.diff(parseLedgerStamp(body))).toBe(false);
		expect(parseLedgerStamp(body.replace('"round":1', '"round":2'))).toBeUndefined();
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
		const off = Ledger.from(
			verdict,
			{ rounds: [round] },
			{ ...options, walkthrough: { ...options.walkthrough, enabled: false } },
		);
		expect(off.render(links)).not.toContain("<summary>Walkthrough");
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
		expect(parseLedgerStamp(body)).toEqual(ledger.stamp);
		expect(body).toContain("This ledger was cut");
		expect(body.match(/<details>/g)?.length ?? 0).toBe(body.match(/<\/details>/g)?.length ?? 0);
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
		await summariseReview({
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
		expect(state.statuses.at(-1)?.target_url).toBe(state.ledgers[0]!.html_url);
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness, fake, lensScript(emptyName));
		await second.review;
		moveTo(state, second.changeset);
		await publish(second.changeset, false);
		expect(state.ledgers).toHaveLength(1);
		expect(state.ledgers[0]!.id).toBe(id);
		expect(parseLedgerStamp(state.ledgers[0]!.body)?.head).toBe(second.changeset.revision.head);
		expect(state.ledgers[0]!.body).toContain(`Earlier round 1 at ${first.changeset.revision.head.slice(0, 12)}`);
		expect(state.ledgers[0]!.body).not.toContain("<summary>Walkthrough");
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
});

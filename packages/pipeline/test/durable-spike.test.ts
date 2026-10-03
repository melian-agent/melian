import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AssistantEntry,
	type AssistantMessage,
	type Conversation,
	type ConversationId,
	configure,
	backgroundContext as context,
	createFakeModels,
	createMemoryStorage,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryRecord,
	fauxAssistantMessage,
	fauxToolCall,
	hook,
	type Message,
	openHarness,
	openSqliteStorage,
	type Registry,
	type SubmissionId,
	SystemEntry,
	section,
	type TaskId,
	ToolResultEntry,
	ToolTask,
	Type,
} from "../src/harness.ts";
import {
	captured,
	count,
	type Event,
	offeredTools,
	openSpikeHarness,
	readEvents,
	type Scenario,
	spikeRegistry,
	systemPrompt,
	textOf,
	toolResult,
} from "./fixtures/spike.ts";

const crashScript = fileURLToPath(new URL("./fixtures/crash.ts", import.meta.url));

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "melian-durable-spike-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function crashWhen(scenario: Scenario, reached: (events: readonly Event[]) => boolean) {
	const database = join(dir, `${scenario}.sqlite`);
	const log = join(dir, `${scenario}.jsonl`);
	const child = spawn(process.execPath, [crashScript, scenario, database, log], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise<string | number | null>((resolve) =>
		child.on("exit", (code, signal) => resolve(signal ?? code)),
	);
	const deadline = Date.now() + 15_000;
	try {
		while (!reached(readEvents(log))) {
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error(`crash script exited before the kill point:\n${stderr}`);
			if (Date.now() > deadline) throw new Error(`crash script never reached the kill point:\n${stderr}`);
			await sleep(20);
		}
	} finally {
		child.kill("SIGKILL");
	}
	expect(await exited).toBe("SIGKILL");
	return { database, log };
}

function field<T>(events: readonly Event[], event: string, name: string): T {
	const found = events.find((each) => each.event === event);
	if (found === undefined) throw new Error(`no ${event} event`);
	if (!(name in found)) throw new Error(`${event} event has no ${name} field`);
	return found[name] as T;
}

async function transcript(conversation: Conversation): Promise<string[]> {
	const { entries } = await conversation.context(context);
	return entries
		.filter((entry) => entry.kind !== SystemEntry.kind)
		.map((entry) => `${entry.kind}: ${textOf(entry.model?.[0])}`);
}

async function entriesOf(conversation: Conversation): Promise<readonly EntryRecord[]> {
	return (await conversation.context(context)).entries;
}

async function ask(conversation: Conversation, content: string) {
	return (await conversation.submit({ type: "input", content }, context)).wait(context);
}

describe("Pi Durable spike", { timeout: 20_000 }, () => {
	it("a. reopens a SQLite harness with the transcript and the conversation ID intact", async () => {
		const path = join(dir, "resume.sqlite");
		const fake = createFakeModels();
		const registry = createRegistry();
		fake.provider.setResponses([fauxAssistantMessage("Canberra")]);

		const first = await openHarness(await openSqliteStorage(path), { models: fake.models, registry });
		const root = await first.root(context, { agent: { model: fake.ref() } });
		const settled = await ask(root, "What is the capital of Australia?");
		expect(settled.status).toBe("done");
		const before = await transcript(root);
		await first.close(context);

		const second = await openHarness(await openSqliteStorage(path), { models: fake.models, registry });
		const reopened = await second.root(context);
		expect(reopened.id).toBe(root.id);
		expect((await second.conversation(root.id, context))?.id).toBe(root.id);
		expect(await transcript(reopened)).toEqual(before);
		expect(before).toEqual(["pi.user: What is the capital of Australia?", "pi.assistant: Canberra"]);
		expect((await (await second.submission(settled.id, context))?.status(context))?.status).toBe("done");
		expect((await reopened.agent(context)).model).toEqual(fake.ref());
		await second.close(context);
	});

	it("b. resumes a task after SIGKILL without rerunning the phase that checkpointed", async () => {
		const { database, log } = await crashWhen("task", (events) => count(events, "phase-two-start") === 1);
		expect(count(readEvents(log), "phase-one")).toBe(1);
		expect(count(readEvents(log), "phase-two-done")).toBe(0);

		const harness = await openSpikeHarness(database, spikeRegistry("task", "resume", log), createFakeModels());
		const taskId = field<TaskId<{ first: string; second: string }>>(readEvents(log), "task-created", "taskId");
		harness.resume();
		const settled = await harness.waitForTask(taskId, context);
		await harness.close(context);

		expect(settled.state.outcome).toEqual({ status: "completed", result: { first: "one", second: "two" } });
		const events = readEvents(log);
		expect(count(events, "phase-one")).toBe(1);
		expect(count(events, "phase-two-start")).toBe(2);
		expect(count(events, "phase-two-done")).toBe(1);
	});

	it("c. reruns a replay-safe tool after SIGKILL and tells the model an unsafe one was interrupted", async () => {
		const { database, log } = await crashWhen(
			"replay",
			(events) => count(events, "safe_probe-start") === 1 && count(events, "unsafe_probe-start") === 1,
		);

		const fake = createFakeModels();
		const requests: Message[][] = [];
		fake.provider.setResponses([captured(requests, fauxAssistantMessage("One probe ran, one was interrupted."))]);
		const harness = await openSpikeHarness(database, spikeRegistry("replay", "resume", log), fake);
		const submissionId = field<SubmissionId>(readEvents(log), "submitted", "submissionId");
		const submission = await harness.submission(submissionId, context);
		const settled = await submission!.wait(context);
		await harness.close(context);

		expect(settled.status).toBe("done");
		const events = readEvents(log);
		expect(count(events, "safe_probe-start")).toBe(2);
		expect(count(events, "safe_probe-done")).toBe(1);
		expect(count(events, "unsafe_probe-start")).toBe(1);
		expect(count(events, "unsafe_probe-done")).toBe(0);

		expect(requests).toHaveLength(1);
		const safe = toolResult(requests[0]!, "safe_probe");
		const unsafe = toolResult(requests[0]!, "unsafe_probe");
		expect(safe?.isError).toBe(false);
		expect(textOf(safe)).toBe("safe_probe finished");
		expect(unsafe?.isError).toBe(true);
		expect(textOf(unsafe)).toContain("Tool unsafe_probe was interrupted and may have partially run");
	});

	it("d. a tool spawns a child conversation with its own instructions and model, and returns its answer", async () => {
		const fake = createFakeModels({ models: [{ id: "reviewer" }, { id: "lens" }] });
		const lensInstructions = "You are the security lens. Report findings, nothing else.";
		const seen: { model: string; messages: Message[] }[] = [];
		const replies: Record<string, AssistantMessage[]> = {
			reviewer: [
				fauxAssistantMessage(fauxToolCall("security_lens", { question: "Is this eval safe?" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The security lens raised one finding."),
			],
			lens: [fauxAssistantMessage("P1: eval runs user input.")],
		};
		const respond = (
			request: { readonly messages: readonly Message[] },
			_options: unknown,
			_state: unknown,
			model: { id: string },
		) => {
			seen.push({ model: model.id, messages: structuredClone([...request.messages]) });
			return replies[model.id]!.shift()!;
		};
		fake.provider.setResponses([respond, respond, respond]);

		const lens = defineTool({
			name: "security_lens",
			description: "Ask the security lens about the change",
			parameters: Type.Object({ question: Type.String() }),
			replay: "safe",
			execute: async (args, api, toolContext) => {
				const childId = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, created.id, { model: fake.ref("lens"), instructions: lensInstructions, tools: [] });
					return created.id;
				}, toolContext);
				const child = await api.conversation(childId, toolContext);
				const request = { type: "input", content: args.question, requestId: `lens:${api.taskId}` } as const;
				const settled = await (await child!.submit(request, toolContext)).wait(toolContext);
				if (settled.status !== "done" || settled.type !== "input")
					throw new Error(`lens did not answer: ${settled.reason}`);
				const answer = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), toolContext);
				return { content: [{ type: "text", text: textOf(answer?.model?.[0]) }] };
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "lenses", tools: [lens] }));
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry });
		const root = await harness.root(context, { agent: { model: fake.ref("reviewer") } });
		const settled = await ask(root, "Review this change.");

		expect(settled.status).toBe("done");
		expect(seen.map((each) => each.model)).toEqual(["reviewer", "lens", "reviewer"]);
		expect(systemPrompt(seen[1]!.messages)).toContain(lensInstructions);
		expect(systemPrompt(seen[0]!.messages)).not.toContain(lensInstructions);
		expect(offeredTools(seen[0]!.messages)).toEqual(["security_lens"]);
		expect(offeredTools(seen[1]!.messages)).toEqual([]);
		expect(textOf(toolResult(seen[2]!.messages, "security_lens"))).toBe("P1: eval runs user input.");

		const children = await harness.commit(
			(tx) => tx.scanConversations({ ownerConversationId: root.id }, 10),
			context,
		);
		expect(children.items).toHaveLength(1);
		const child = (await harness.conversation(children.items[0]!.id, context))!;
		const agent = await child.agent(context);
		expect(agent.model).toEqual(fake.ref("lens"));
		expect(agent.instructions).toBe(lensInstructions);
		expect(agent.tools).toEqual([]);
		expect(await transcript(child)).toEqual([
			"pi.user: Is this eval safe?",
			"pi.assistant: P1: eval runs user input.",
		]);
		await harness.close(context);
	});

	it("d2. a pipeline task fans lenses out as child conversations it owns, with no model choosing the topology", async () => {
		const lenses = { correctness: "You are the correctness lens.", contracts: "You are the contracts lens." };
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "correctness" }, { id: "contracts" }] });
		const seen: { model: string; prompt: string }[] = [];
		const respond = (
			request: { readonly messages: readonly Message[] },
			_options: unknown,
			_state: unknown,
			model: { id: string },
		) => {
			seen.push({ model: model.id, prompt: systemPrompt(request.messages) });
			return fauxAssistantMessage(`${model.id}: no findings`);
		};
		fake.provider.setResponses([respond, respond]);

		type Checkpoint = { phase: "spawn" } | { phase: "review"; children: Record<string, ConversationId> };
		const LensStep = defineTask<{ change: string }, Checkpoint, Record<string, string>>({
			name: "spike.lenses",
			version: 1,
			initial: () => ({ phase: "spawn" }),
			phases: {
				spawn: async (_task, runtime, taskContext) => {
					await runtime.commit(async (tx) => {
						const children: Record<string, ConversationId> = {};
						for (const [name, instructions] of Object.entries(lenses)) {
							const created = await tx.createConversation({
								ownership: { kind: "task", taskId: runtime.taskId },
							});
							await configure(tx, created.id, { model: fake.ref(name), instructions, tools: [] });
							children[name] = created.id;
						}
						return { status: "running", checkpoint: { phase: "review", children } };
					}, taskContext);
				},
				review: async (task, runtime, taskContext) => {
					const answers = await Promise.all(
						Object.entries(task.state.checkpoint.children).map(async ([name, id]) => {
							const child = (await runtime.conversation(id, taskContext))!;
							const request = { type: "input", content: task.input.change, requestId: `lens:${name}` } as const;
							await (await child.submit(request, taskContext)).wait(taskContext);
							const { entries } = await runtime.context(id, taskContext);
							return [name, textOf(entries.at(-1)?.model?.[0])] as const;
						}),
					);
					const result = Object.fromEntries(answers);
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result } }),
						taskContext,
					);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "pipeline", tasks: [LensStep] }));
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry });
		const root = await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
		const taskId = await root.commit(
			(tx) => tx.createTask(LensStep, { change: "diff --git a/src/a.ts" }, { ownership: { kind: "conversation" } }),
			context,
		);
		const settled = await harness.waitForTask(taskId, context);

		expect(settled.state.outcome).toEqual({
			status: "completed",
			result: { correctness: "correctness: no findings", contracts: "contracts: no findings" },
		});
		expect(seen.map((each) => each.model).sort()).toEqual(["contracts", "correctness"]);
		for (const { model, prompt } of seen) {
			expect(prompt).toContain(lenses[model as keyof typeof lenses]);
			expect(prompt).not.toContain(model === "correctness" ? lenses.contracts : lenses.correctness);
		}
		const owned = await harness.commit((tx) => tx.scanConversations({ ownerTaskId: taskId }, 10), context);
		expect(owned.items).toHaveLength(2);
		await harness.close(context);
	});

	it("e. validates TypeBox tool arguments before execute runs, after coercing what it can", async () => {
		const executed: { path: string; line: number }[] = [];
		const locate = defineTool({
			name: "locate",
			description: "Point at a line",
			parameters: Type.Object({ path: Type.String(), line: Type.Integer({ minimum: 1 }) }),
			execute: async (args) => {
				const line: number = args.line;
				executed.push({ path: args.path, line });
				return { content: [{ type: "text", text: `${args.path}:${line}` }] };
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "spike", tools: [locate] }));
		const fake = createFakeModels();
		const requests: Message[][] = [];
		const call = (args: Parameters<typeof fauxToolCall>[1]) =>
			fauxAssistantMessage(fauxToolCall("locate", args), { stopReason: "toolUse" });
		fake.provider.setResponses([
			call({ path: "src/a.ts", line: 0 }),
			captured(requests, call({ line: 3 })),
			captured(requests, call({ path: 42, line: "12" })),
			captured(requests, fauxAssistantMessage("Located.")),
		]);
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry });
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		const settled = await ask(root, "Where is the bug?");
		await harness.close(context);

		expect(settled.status).toBe("done");
		const results = (index: number) => toolResult(requests[index]!.slice(requests[index - 1]?.length ?? 0), "locate");
		expect(results(0)?.isError).toBe(true);
		expect(textOf(results(0))).toContain("line: must be >= 1");
		expect(results(1)?.isError).toBe(true);
		expect(textOf(results(1))).toMatch(/path/);
		expect(executed).toEqual([{ path: "42", line: 12 }]);
		expect(textOf(results(2))).toBe("42:12");
	});

	it("f. a document written in a tool commit survives reopen, and an asOf fork sees it only after the write", async () => {
		const Findings = defineDoc<{ items: string[] }>({
			kind: "melian.spike.findings",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ items: [] }),
		});
		const report = defineTool({
			name: "report_finding",
			description: "Report one finding",
			parameters: Type.Object({ title: Type.String() }),
			execute: async (args, api, toolContext) => {
				await api.commit(async (tx) => {
					(await tx.doc(Findings, api.conversationId)).items.push(args.title);
				}, toolContext);
				return { content: [{ type: "text", text: "reported" }] };
			},
		});
		const registry: Registry = createRegistry();
		registry.install(defineExtension({ name: "spike", tools: [report] }));
		const fake = createFakeModels();
		fake.provider.setResponses([
			fauxAssistantMessage(fauxToolCall("report_finding", { title: "P1: eval runs user input" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("One finding."),
		]);
		const path = join(dir, "docs.sqlite");
		const first = await openHarness(await openSqliteStorage(path), { models: fake.models, registry });
		const firstRoot = await first.root(context, { agent: { model: fake.ref() } });
		expect((await ask(firstRoot, "Review this change.")).status).toBe("done");
		await first.close(context);

		const harness = await openHarness(await openSqliteStorage(path), { models: fake.models, registry });
		const root = await harness.root(context);
		expect(await harness.snapshot(Findings, root.id, context)).toEqual({ items: ["P1: eval runs user input"] });

		const entries = await entriesOf(root);
		const call = entries.find((entry) => entry.kind === AssistantEntry.kind)!;
		const result = entries.find((entry) => entry.kind === ToolResultEntry.kind)!;
		const before = await root.fork(call.id, { ownership: { kind: "ownerless" } }, context);
		const after = await root.fork(result.id, { ownership: { kind: "ownerless" } }, context);
		await root.commit(async (tx) => {
			(await tx.doc(Findings, root.id)).items.push("P2: added after the fork");
		}, context);

		expect(await harness.snapshot(Findings, before.id, context)).toBeUndefined();
		expect(await harness.snapshot(Findings, after.id, context)).toEqual({ items: ["P1: eval runs user input"] });
		expect((await harness.snapshot(Findings, root.id, context))?.items).toHaveLength(2);
		expect(await harness.snapshotAsOf(Findings, root.id, call.id, context)).toBeUndefined();
		expect((await harness.snapshotAsOf(Findings, root.id, result.id, context))?.items).toEqual([
			"P1: eval runs user input",
		]);
		await harness.close(context);
	});

	it("g. api.memo is first-write-wins across SIGKILL and is dropped once its task ends", async () => {
		const { database, log } = await crashWhen("memo", (events) => count(events, "memo") === 1);
		const fake = createFakeModels();
		fake.provider.setResponses([fauxAssistantMessage("Published once.")]);
		const harness = await openSpikeHarness(database, spikeRegistry("memo", "resume", log), fake);
		const submissionId = field<SubmissionId>(readEvents(log), "submitted", "submissionId");
		const settled = await (await harness.submission(submissionId, context))!.wait(context);
		expect(settled.status).toBe("done");

		const memos = readEvents(log).filter((each) => each.event === "memo");
		expect(memos).toHaveLength(3);
		const [crashed, resumed, again] = memos;
		expect(crashed!.winner).toBe(crashed!.candidate);
		expect(String(resumed!.candidate)).toMatch(/^resume-/);
		expect(resumed!.winner).toBe(crashed!.candidate);
		expect(again!.winner).toBe(crashed!.candidate);

		const task = await harness.getTask(resumed!.taskId as TaskId, context);
		expect(task?.state.status).toBe("terminal");
		expect(task?.memos).toBeUndefined();
		await harness.close(context);
	});

	it("h. a repeated requestId returns the existing submission, before and after reopen", async () => {
		const path = join(dir, "once.sqlite");
		const fake = createFakeModels();
		fake.provider.setResponses([fauxAssistantMessage("Reviewed.")]);
		const registry = createRegistry();
		const delivery = { type: "input", content: "Review revision abc123.", requestId: "delivery-7f3a" } as const;

		const first = await openHarness(await openSqliteStorage(path), { models: fake.models, registry });
		const root = await first.root(context, { agent: { model: fake.ref() } });
		const original = await root.submit(delivery, context);
		const retried = await root.submit(delivery, context);
		expect(retried.id).toBe(original.id);
		expect((await original.wait(context)).status).toBe("done");
		await first.close(context);

		const second = await openHarness(await openSqliteStorage(path), { models: fake.models, registry });
		const reopened = await second.root(context);
		const redelivered = await reopened.submit(delivery, context);
		expect(redelivered.id).toBe(original.id);
		expect((await redelivered.status(context)).status).toBe("done");
		await second.waitForIdle(context);
		expect(await transcript(reopened)).toEqual(["pi.user: Review revision abc123.", "pi.assistant: Reviewed."]);
		expect(fake.provider.state.callCount).toBe(1);
		await second.close(context);
	});

	it("i. a section that reads a file is re-rendered after the file changes, and the transcript records it", async () => {
		const standards = join(dir, "AGENTS.md");
		writeFileSync(standards, "Use tabs.");
		const registry = createRegistry();
		registry.install(
			defineExtension({ name: "standards", sections: [section("standards", () => readFile(standards, "utf8"))] }),
		);
		const fake = createFakeModels();
		const requests: Message[][] = [];
		fake.provider.setResponses([
			captured(requests, fauxAssistantMessage("First.")),
			captured(requests, fauxAssistantMessage("Second.")),
		]);
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry });
		const root = await harness.root(context, { agent: { model: fake.ref() } });

		expect((await ask(root, "Review the first revision.")).status).toBe("done");
		writeFileSync(standards, "Use tabs. Prefer early returns.");
		expect((await ask(root, "Review the second revision.")).status).toBe("done");

		expect(systemPrompt(requests[0]!)).toContain("Use tabs.");
		expect(systemPrompt(requests[0]!)).not.toContain("Prefer early returns.");
		expect(systemPrompt(requests[1]!)).toContain("Prefer early returns.");
		const system = (await entriesOf(root)).filter((entry) => entry.kind === SystemEntry.kind);
		expect(system).toHaveLength(2);
		expect(textOf(system[0]!.model?.[0])).not.toContain("Prefer early returns.");
		expect(textOf(system[1]!.model?.[0])).toContain("Prefer early returns.");
		await harness.close(context);
	});

	it("hook(ToolTask) beforeTool blocks a call before it executes", async () => {
		let writes = 0;
		const write = defineTool({
			name: "write_file",
			description: "Write a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => {
				writes++;
				return { content: [{ type: "text", text: "written" }] };
			},
		});
		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "read-only",
				tools: [write],
				hooks: [
					hook(ToolTask, {
						beforeTool: (call) => (call.name === "write_file" ? { block: "lenses are read-only" } : undefined),
					}),
				],
			}),
		);
		const fake = createFakeModels();
		const requests: Message[][] = [];
		fake.provider.setResponses([
			fauxAssistantMessage(fauxToolCall("write_file", { path: "src/a.ts" }), { stopReason: "toolUse" }),
			captured(requests, fauxAssistantMessage("Could not write.")),
		]);
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry });
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		expect((await ask(root, "Fix it.")).status).toBe("done");
		await harness.close(context);

		expect(writes).toBe(0);
		const blocked = toolResult(requests[0]!, "write_file");
		expect(blocked?.isError).toBe(true);
		expect(textOf(blocked)).toContain("Tool call blocked: lenses are read-only");
	});
});

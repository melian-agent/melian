import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { findingId } from "@melian-agent/core";
import {
	type AssistantMessage,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type Harness,
	type Message,
	openHarness,
	openSqliteStorage,
	type Registry,
	Type,
} from "../../src/harness.ts";
import { type FakeModels, fauxAssistantMessage, fauxToolCall } from "../../src/testing.ts";

// `crash` parks the second half of each scenario so the parent can kill the process there; `resume` finishes it.
export type Mode = "crash" | "resume";

export type Scenario = "task" | "replay" | "memo" | "finding";

export type Event = { readonly event: string; readonly [field: string]: unknown };

// Synchronous, so the event is on disk before the next step runs and the parent can kill at it.
export function record(log: string, event: Event): void {
	appendFileSync(log, `${JSON.stringify(event)}\n`);
}

// A read can land mid-append, so the text after the last newline is an event still being written.
export function readEvents(log: string): Event[] {
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8")
		.split("\n")
		.slice(0, -1)
		.map((line) => JSON.parse(line) as Event);
}

export function count(events: readonly Event[], name: string): number {
	return events.filter((each) => each.event === name).length;
}

// The timer keeps Node alive until the parent kills the process.
function park(): Promise<never> {
	return new Promise(() => setInterval(() => {}, 60_000));
}

type PhasedCheckpoint = { phase: "first" } | { phase: "second"; first: string };

export function phasedTask(mode: Mode, log: string) {
	return defineTask<Record<string, never>, PhasedCheckpoint, { first: string; second: string }>({
		name: "spike.phased",
		version: 1,
		initial: () => ({ phase: "first" }),
		phases: {
			first: async (_task, runtime, context) => {
				record(log, { event: "phase-one" });
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "second", first: "one" } }), context);
			},
			second: async (task, runtime, context) => {
				record(log, { event: "phase-two-start" });
				if (mode === "crash") await park();
				const result = { first: task.state.checkpoint.first, second: "two" };
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
				record(log, { event: "phase-two-done" });
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}

export function replayTools(mode: Mode, log: string) {
	const probe = (name: string, replay: "safe" | "unsafe") =>
		defineTool({
			name,
			description: `Records that ${name} ran`,
			parameters: Type.Object({}),
			replay,
			execute: async () => {
				record(log, { event: `${name}-start` });
				if (mode === "crash") await park();
				record(log, { event: `${name}-done` });
				return { content: [{ type: "text", text: `${name} finished` }] };
			},
		});
	return [probe("safe_probe", "safe"), probe("unsafe_probe", "unsafe")];
}

const memoKey = "publish:revision-1";

export function memoTool(mode: Mode, log: string) {
	return defineTool({
		name: "publish_once",
		description: "Publishes a review at most once",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, context) => {
			const candidate = `${mode}-${process.pid}`;
			const winner = await api.memo<string>(memoKey, candidate, context);
			record(log, { event: "memo", candidate, winner, taskId: api.taskId });
			if (mode === "crash") await park();
			const again = await api.memo<string>(memoKey, `${mode}-again`, context);
			record(log, { event: "memo", candidate: `${mode}-again`, winner: again, taskId: api.taskId });
			return { content: [{ type: "text", text: `published as ${winner}` }] };
		},
	});
}

export type Finding = { file: string; rule: string; snippet: string; title: string };

export const Findings = defineDoc<{ items: Record<string, Finding> }>({
	kind: "melian.spike.findings",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ items: {} }),
});

export const evalFinding: Finding = {
	file: "src/run.ts",
	rule: "no-eval",
	snippet: "eval(input)",
	title: "P1: eval runs user input",
};

// The commit and the tool result are separate durable commits, so a crash between them reruns the call or has the
// model retry it. An upsert by finding ID makes either harmless, which is why it is replay-safe.
export function reportFinding(mode: Mode, log: string) {
	return defineTool({
		name: "report_finding",
		description: "Report one finding",
		parameters: Type.Object({
			file: Type.String({ minLength: 1 }),
			rule: Type.String({ minLength: 1 }),
			snippet: Type.String(),
			title: Type.String({ minLength: 1 }),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const id = findingId(args);
			await api.commit(async (tx) => {
				(await tx.doc(Findings, api.conversationId)).items[id] = { ...args };
			}, context);
			record(log, { event: "finding-committed", id });
			if (mode === "crash") await park();
			return { content: [{ type: "text", text: `recorded finding ${id}` }] };
		},
	});
}

export function reportFindingReply(): AssistantMessage {
	return fauxAssistantMessage(fauxToolCall("report_finding", evalFinding), { stopReason: "toolUse" });
}

export function spikeRegistry(scenario: Scenario, mode: Mode, log: string): Registry {
	const registry = createRegistry();
	if (scenario === "task") registry.install(defineExtension({ name: "spike", tasks: [phasedTask(mode, log)] }));
	if (scenario === "replay") registry.install(defineExtension({ name: "spike", tools: replayTools(mode, log) }));
	if (scenario === "memo") registry.install(defineExtension({ name: "spike", tools: [memoTool(mode, log)] }));
	if (scenario === "finding") registry.install(defineExtension({ name: "spike", tools: [reportFinding(mode, log)] }));
	return registry;
}

export function toolCallReply(...names: string[]): AssistantMessage {
	return fauxAssistantMessage(
		names.map((name) => fauxToolCall(name, {})),
		{ stopReason: "toolUse" },
	);
}

export function captured(requests: Message[][], reply: AssistantMessage) {
	return (context: { readonly messages: readonly Message[] }): AssistantMessage => {
		requests.push(structuredClone([...context.messages]));
		return reply;
	};
}

export async function openSpikeHarness(path: string, registry: Registry, fake: FakeModels): Promise<Harness> {
	return openHarness(await openSqliteStorage(path), {
		models: fake.models,
		registry,
		settings: { toolExecution: "parallel" },
	});
}

export function textOf(message: Message | undefined): string {
	if (message === undefined) return "";
	if (message.role === "system") {
		const content =
			typeof message.content === "string" ? message.content : message.content.map((each) => each.text).join("");
		return [content, ...Object.values(message.sections ?? {})].join("\n");
	}
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "toolCall") return `${block.name}(${JSON.stringify(block.arguments)})`;
			return "";
		})
		.join("");
}

export function systemPrompt(messages: readonly Message[]): string {
	return messages
		.filter((message) => message.role === "system")
		.map(textOf)
		.join("\n");
}

export function toolResult(messages: readonly Message[], toolName: string) {
	return messages.find(
		(message): message is Extract<Message, { role: "toolResult" }> =>
			message.role === "toolResult" && message.toolName === toolName,
	);
}

export function offeredTools(messages: readonly Message[]): string[] {
	return messages.flatMap((message) =>
		message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
	);
}

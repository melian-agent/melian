import { expect, it } from "vitest";
import {
	type AssistantMessage,
	type Context,
	type Conversation,
	type ConversationId,
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	type EntryId,
	type Harness,
	holdsWork,
	openHarness,
} from "../src/harness.ts";
import { createFakeModels, type FakeModels, fauxAssistantMessage } from "../src/testing.ts";

const stopReasons = Object.keys({
	stop: true,
	length: true,
	toolUse: true,
	error: true,
	aborted: true,
	deferred: true,
	pending: true,
} satisfies Record<AssistantMessage["stopReason"], true>) as AssistantMessage["stopReason"][];

async function withRoot(fake: FakeModels, run: (harness: Harness, root: Conversation) => Promise<void>) {
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createRegistry(),
		settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
	});
	try {
		await run(harness, await harness.root(context, { agent: { model: fake.ref() } }));
	} finally {
		await harness.close(context);
	}
}

const failed = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded_error" });

// A task reads a conversation's context by its ID; a test holds the conversation itself.
const readerOf = (root: Conversation) => ({
	context: (_id: ConversationId, at: Context, options?: { readonly at?: EntryId }) => root.context(at, options),
});

const reply = (stopReason: AssistantMessage["stopReason"]) =>
	({
		type: "write",
		entry: { kind: "test.reply", model: [fauxAssistantMessage("A reply.", { stopReason })] },
	}) as const;

it("finds the work a model did after compaction has summarised it away", async () => {
	const fake = createFakeModels();
	fake.provider.setResponses([
		fauxAssistantMessage("Reviewed the first file."),
		fauxAssistantMessage("Reviewed the second file."),
		failed(),
		fauxAssistantMessage("A summary of the review so far."),
	]);
	await withRoot(fake, async (harness, root) => {
		await (await root.submit({ type: "input", content: "Review the first file" }, context)).wait(context);
		await (await root.submit({ type: "input", content: "Review the second file" }, context)).wait(context);
		await (await root.submit({ type: "input", content: "Continue the review" }, context)).wait(context);
		await harness.waitForTask(await root.compact(undefined, context), context);
		expect((await root.context(context)).messages.map((message) => message.role)).not.toContain("assistant");
		expect(await holdsWork(readerOf(root), root.id, context)).toBe(true);
	});
});

it("finds no work when the only model failed before it started", async () => {
	const fake = createFakeModels();
	fake.provider.setResponses([failed()]);
	await withRoot(fake, async (_harness, root) => {
		await (await root.submit({ type: "input", content: "Review the change" }, context)).wait(context);
		expect(await holdsWork(readerOf(root), root.id, context)).toBe(false);
	});
});

// Pi's context decides which replies the next model is shown, so a reply counts as work exactly when it is there.
it.each([...stopReasons, "unheard-of" as AssistantMessage["stopReason"]])(
	"agrees with Pi's context on a reply that stopped with %s",
	async (stopReason) => {
		await withRoot(createFakeModels(), async (_harness, root) => {
			await (await root.submit(reply(stopReason), context)).wait(context);
			const inContext = (await root.context(context)).messages.some((message) => message.role === "assistant");
			expect({ stopReason, worked: await holdsWork(readerOf(root), root.id, context) }).toEqual({
				stopReason,
				worked: inContext,
			});
		});
	},
);

it("counts a reply Pi shows the next model as work, and one it leaves out as none", async () => {
	await withRoot(createFakeModels(), async (_harness, root) => {
		await (await root.submit(reply("pending"), context)).wait(context);
		expect(await holdsWork(readerOf(root), root.id, context)).toBe(true);
	});
	await withRoot(createFakeModels(), async (_harness, root) => {
		await (await root.submit(reply("aborted"), context)).wait(context);
		expect(await holdsWork(readerOf(root), root.id, context)).toBe(false);
	});
});

it("walks back through two compactions to the work before them", async () => {
	const fake = createFakeModels();
	fake.provider.setResponses([
		fauxAssistantMessage("Reviewed the first file."),
		failed(),
		fauxAssistantMessage("The first summary."),
		failed(),
		fauxAssistantMessage("The second summary."),
	]);
	await withRoot(fake, async (harness, root) => {
		await (await root.submit({ type: "input", content: "Review the first file" }, context)).wait(context);
		await (await root.submit({ type: "input", content: "Continue the review" }, context)).wait(context);
		await harness.waitForTask(await root.compact(undefined, context), context);
		await (await root.submit({ type: "input", content: "Continue again" }, context)).wait(context);
		await harness.waitForTask(await root.compact(undefined, context), context);
		const { items } = await root.entries({}, 50, undefined, context);
		expect(items.filter((entry) => entry.head !== undefined)).toHaveLength(2);
		expect(await holdsWork(readerOf(root), root.id, context)).toBe(true);
	});
});

it("finds no work behind a compaction of inputs no model answered", async () => {
	const fake = createFakeModels();
	fake.provider.setResponses([failed(), failed(), fauxAssistantMessage("A summary of the inputs."), failed()]);
	await withRoot(fake, async (harness, root) => {
		await (await root.submit({ type: "input", content: "Review the change" }, context)).wait(context);
		await (await root.submit({ type: "input", content: "Review the change again" }, context)).wait(context);
		await harness.waitForTask(await root.compact(undefined, context), context);
		await (await root.submit({ type: "input", content: "Continue the review" }, context)).wait(context);
		expect(await holdsWork(readerOf(root), root.id, context)).toBe(false);
	});
});

it("counts the work before a reset as none, since nothing links back past it", async () => {
	const fake = createFakeModels();
	fake.provider.setResponses([fauxAssistantMessage("Reviewed the first file.")]);
	await withRoot(fake, async (_harness, root) => {
		await (await root.submit({ type: "input", content: "Review the first file" }, context)).wait(context);
		expect(await holdsWork(readerOf(root), root.id, context)).toBe(true);
		await root.reset(undefined, context);
		await root.waitForIdle(context);
		expect(await holdsWork(readerOf(root), root.id, context)).toBe(false);
	});
});

it("stops when a compaction leads back to itself", async () => {
	const head = {
		id: 5 as unknown as EntryId,
		conversationId: 1,
		kind: "pi.compaction",
		head: 4 as unknown as EntryId,
		data: { reason: "manual" },
	};
	const views: (EntryId | undefined)[] = [];
	const reader = {
		context: async (_id: ConversationId, _at: Context, options?: { readonly at?: EntryId }) => {
			views.push(options?.at);
			return { head, entries: [head], contributions: [[]], messages: [] } as unknown as Awaited<
				ReturnType<Parameters<typeof holdsWork>[0]["context"]>
			>;
		},
	};
	expect(await holdsWork(reader, 1 as unknown as ConversationId, context)).toBe(false);
	expect(views).toEqual([undefined, 4]);
});

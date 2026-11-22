import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouteTextModel } from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage } from "@melian-agent/pipeline/testing";
import { describe, expect, it, vi } from "vitest";
import { Type } from "../src/harness.ts";

it("forwards cancellation to the model collection and rejects an aborted reply", async () => {
	const fake = createFakeModels({ models: [{ id: "light" }] });
	const model = await RouteTextModel.create(fake.review, [fake.ref("light")]);
	const controller = new AbortController();
	let received: AbortSignal | undefined;
	let finish: (() => void) | undefined;
	const complete = vi.spyOn(fake.models, "complete").mockImplementation(
		(_model, _context, options) =>
			new Promise((resolve) => {
				received = options?.signal;
				finish = () => resolve(fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "cancelled" }));
				received?.addEventListener("abort", finish, { once: true });
			}),
	);
	try {
		const pending = model!.answer(
			{
				system: "Answer with the tool.",
				prompt: "Choose.",
				tool: { name: "answer", description: "Answer", parameters: Type.Object({}) },
			},
			controller.signal,
		);
		const rejected = expect(pending).rejects.toThrow(`${model!.name} failed: cancelled`);
		expect(complete).toHaveBeenCalledOnce();
		expect(received).toBe(controller.signal);
		expect(received!.aborted).toBe(false);
		controller.abort();
		await rejected;
		expect(received!.aborted).toBe(true);
	} finally {
		finish?.();
		complete.mockRestore();
	}
});

it("forwards cancellation with explicit thinking and rejects an aborted reply", async () => {
	const fake = createFakeModels({ models: [{ id: "light" }] });
	const model = await RouteTextModel.create(fake.review, [fake.ref("light")], "high");
	const controller = new AbortController();
	let received: AbortSignal | undefined;
	let finish: (() => void) | undefined;
	const complete = vi.spyOn(fake.models, "completeSimple").mockImplementation(
		(_model, _context, options) =>
			new Promise((resolve) => {
				received = options?.signal;
				finish = () => resolve(fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "cancelled" }));
				received?.addEventListener("abort", finish, { once: true });
			}),
	);
	try {
		const pending = model!.answer(
			{
				system: "Answer with the tool.",
				prompt: "Choose.",
				tool: { name: "answer", description: "Answer", parameters: Type.Object({}) },
			},
			controller.signal,
		);
		const rejected = expect(pending).rejects.toThrow(`${model!.name} failed: cancelled`);
		expect(complete).toHaveBeenCalledOnce();
		expect(received).toBe(controller.signal);
		expect(received!.aborted).toBe(false);
		controller.abort();
		await rejected;
		expect(received!.aborted).toBe(true);
	} finally {
		finish?.();
		complete.mockRestore();
	}
});

it("chooses a route model with a command credential without running the command", async () => {
	const dir = mkdtempSync(join(tmpdir(), "melian-route-"));
	try {
		const marker = join(dir, "ran");
		const fake = createFakeModels({
			provider: "fake-key",
			models: [{ id: "scripted" }],
			credentials: [
				{
					name: "vault",
					provider: "fake-key",
					type: "api_key",
					value: { kind: "command", command: `touch ${marker}; printf key-value` },
					file: "f",
				},
			],
			authPath: join(dir, "auth.json"),
		});
		expect(await RouteTextModel.create(fake.review, [fake.ref("scripted")])).toBeDefined();
		expect(existsSync(marker)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("answers without cancellation when the caller supplies no signal", async () => {
	const fake = createFakeModels();
	const tool = { name: "answer", description: "Answer", parameters: Type.Object({}) };
	fake.provider.setResponses([
		(request, options) => {
			expect(request.messages[0]).toMatchObject({ role: "system", toolsAdded: [tool] });
			expect(options?.signal).toBeUndefined();
			return fauxAssistantMessage(
				[{ type: "toolCall", id: "answer-1", name: "answer", arguments: { choice: "run" } }],
				{ stopReason: "toolUse" },
			);
		},
	]);
	const complete = vi.spyOn(fake.models, "complete");
	const model = await RouteTextModel.create(fake.review, [fake.ref()]);
	expect(await model!.answer({ system: "Use the answer tool.", prompt: "Choose.", tool })).toEqual({
		arguments: { choice: "run" },
		model: model!.name,
	});
	expect(fake.provider.state.callCount).toBe(1);
	expect(complete.mock.calls[0]![2]).not.toHaveProperty("signal");
	complete.mockRestore();
});

describe("a route of several models", () => {
	const tool = { name: "answer", description: "Answer", parameters: Type.Object({}) };
	const request = { system: "Use the answer tool.", prompt: "Choose.", tool };
	const answered = fauxAssistantMessage(
		[{ type: "toolCall", id: "answer-1", name: "answer", arguments: { choice: "run" } }],
		{
			stopReason: "toolUse",
		},
	);
	const limit = "Monthly usage limit reached";

	// A route of a, b and c whose replies come in order, each recording the model it reached.
	async function route(replies: readonly ReturnType<typeof fauxAssistantMessage>[]) {
		const fake = createFakeModels({ models: [{ id: "a" }, { id: "b" }, { id: "c" }] });
		const reached: string[] = [];
		fake.provider.setResponses(
			replies.map((reply) => (_context: unknown, _options: unknown, _state: unknown, model: { id: string }) => {
				reached.push(model.id);
				return reply;
			}),
		);
		const model = (await RouteTextModel.create(fake.review, [fake.ref("a"), fake.ref("b"), fake.ref("c")]))!;
		const name = (id: string) => `${fake.ref(id).provider}/${id}`;
		return { model, reached, name };
	}
	const failed = (errorMessage: string, stopReason: "error" | "aborted" = "error") =>
		fauxAssistantMessage("", { stopReason, errorMessage });

	it("is named for the route's head and answers on the first model that does", async () => {
		const { model, reached, name } = await route([failed(limit), failed("503 overloaded_error"), answered]);

		await expect(model.answer(request)).resolves.toEqual({
			arguments: { choice: "run" },
			model: name("c"),
			refused: [
				{ model: name("a"), reason: limit },
				{ model: name("b"), reason: "503 overloaded_error" },
			],
		});
		expect(reached).toEqual(["a", "b", "c"]);
		expect(model.name).toBe(name("a"));
	});

	it("records no refusal when the head answers", async () => {
		const { model, reached, name } = await route([answered]);

		await expect(model.answer(request)).resolves.toEqual({ arguments: { choice: "run" }, model: name("a") });
		expect(reached).toEqual(["a"]);
	});

	it("never moves past an aborted reply, whatever it says", async () => {
		const { model, reached, name } = await route([failed(limit, "aborted"), answered]);

		await expect(model.answer(request)).rejects.toThrow(`${name("a")} failed: ${limit}`);
		expect(reached).toEqual(["a"]);
	});

	it("stops where a later model fails in a way that moves nothing", async () => {
		const { model, reached, name } = await route([failed(limit), failed("400 invalid_request_error"), answered]);

		await expect(model.answer(request)).rejects.toThrow(`${name("b")} failed: 400 invalid_request_error`);
		expect(reached).toEqual(["a", "b"]);
	});

	it("names the fallback that answered without calling the tool", async () => {
		const { model, name } = await route([failed(limit), fauxAssistantMessage("No.")]);

		await expect(model.answer(request)).rejects.toThrow(`${name("b")} answered without calling answer`);
	});

	it("names every refusal when the whole route refuses", async () => {
		const { model, reached, name } = await route([failed(limit), failed(limit), failed(limit)]);

		await expect(model.answer(request)).rejects.toThrow(
			`every model of the route refused: ${[name("a"), name("b"), name("c")].map((each) => `${each} failed: ${limit}`).join("; ")}`,
		);
		expect(reached).toEqual(["a", "b", "c"]);
	});

	it("skips a model of the route that has no credentials", async () => {
		const fake = createFakeModels({ models: [{ id: "a" }] });
		const model = await RouteTextModel.create(fake.review, [{ provider: "absent", modelId: "x" }, fake.ref("a")]);

		expect(model?.name).toBe(`${fake.ref("a").provider}/a`);
	});

	it("is absent when no model of the route holds credentials", async () => {
		const fake = createFakeModels({ models: [{ id: "a" }] });

		await expect(RouteTextModel.create(fake.review, [{ provider: "absent", modelId: "x" }])).resolves.toBeUndefined();
	});

	it("passes over a model whose credential check throws", async () => {
		const fake = createFakeModels({ models: [{ id: "a" }, { id: "b" }] });
		const checkAuth = vi.spyOn(fake.models, "checkAuth").mockRejectedValueOnce(new Error("store unreadable"));
		const model = await RouteTextModel.create(fake.review, [fake.ref("a"), fake.ref("b")]);
		checkAuth.mockRestore();

		expect(model?.name).toBe(`${fake.ref("b").provider}/b`);
	});

	it("names its models with the route's thinking", async () => {
		const fake = createFakeModels({ models: [{ id: "a" }] });
		const model = await RouteTextModel.create(fake.review, [fake.ref("a")], "high");

		expect(model?.name).toBe(`${fake.ref("a").provider}/a thinking=high`);
	});

	it("answers from the request's tool call after other parts", async () => {
		const { model, name } = await route([
			fauxAssistantMessage(
				[
					{ type: "text", text: "Choosing." },
					{ type: "toolCall", id: "other-1", name: "other", arguments: { choice: "skip" } },
					{ type: "toolCall", id: "answer-1", name: "answer", arguments: { choice: "run" } },
				],
				{ stopReason: "toolUse" },
			),
		]);

		await expect(model.answer(request)).resolves.toEqual({ arguments: { choice: "run" }, model: name("a") });
	});

	it("refuses a reply that calls only another tool", async () => {
		const { model, name } = await route([
			fauxAssistantMessage([{ type: "toolCall", id: "other-1", name: "other", arguments: {} }], {
				stopReason: "toolUse",
			}),
		]);

		await expect(model.answer(request)).rejects.toThrow(`${name("a")} answered without calling answer`);
	});
});

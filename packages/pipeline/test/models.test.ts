import { RouteTextModel } from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage } from "@melian-agent/pipeline/testing";
import { expect, it, vi } from "vitest";
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

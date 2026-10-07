import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

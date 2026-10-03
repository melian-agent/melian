import type { ReviewProvider } from "@melian-agent/core";
import { createMemoryStorage, openPublishHarness, openReviewHarness } from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { describe, expect, it } from "vitest";

function aborted() {
	const controller = new AbortController();
	controller.abort();
	return { abortSignal: controller.signal, value: () => undefined, toString: () => "aborted" };
}

describe("a harness whose open fails", () => {
	it("closes the review harness's storage", async () => {
		const storage = createMemoryStorage();
		await expect(openReviewHarness(storage, createFakeModels().review, {}, aborted())).rejects.toThrow();
		await expect(storage.mintId()).rejects.toThrow("MemoryStorage is closed");
	});

	it("closes the publish harness's storage", async () => {
		const storage = createMemoryStorage();
		const provider = {} as ReviewProvider;
		await expect(openPublishHarness(storage, createFakeModels().review, provider, aborted())).rejects.toThrow();
		await expect(storage.mintId()).rejects.toThrow("MemoryStorage is closed");
	});
});

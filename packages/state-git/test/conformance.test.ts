import { registerStorageConformance } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { changeset, context, Remote, storageOf } from "./fixtures/state.ts";

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Pi's storage conformance on a state branch checkout", () => {
	registerStorageConformance({ describe, expect: (actual) => expect(actual), it }, "state-git", async (use) => {
		const own = new Remote();
		try {
			const checkout = await own.clone().branch().checkout(changeset);
			const storage = await storageOf(checkout);
			try {
				await use(storage);
			} finally {
				await storage.close(context).catch(() => {});
			}
			expect(await checkout.push()).toMatchObject({ kind: "pushed" });
			checkout.close();
		} finally {
			own.close();
		}
	});
});

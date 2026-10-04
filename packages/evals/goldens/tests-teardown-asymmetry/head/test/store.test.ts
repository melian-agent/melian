import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";

// One directory for the file, so each test also proves the one before it released the store.
let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "store-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("Store", () => {
	it("reads back what it stored", () => {
		const store = Store.open(dir);
		try {
			store.put("a", "1");
			expect(store.get("a")).toBe("1");
		} finally {
			store.close();
		}
	});

	it("keeps what it stored across a reopen", () => {
		const store = Store.open(dir);
		try {
			expect(store.get("a")).toBe("1");
		} finally {
			store.close();
		}
	});

	it("forgets a deleted key", () => {
		const store = Store.open(dir);
		store.put("b", "2");
		store.delete("b");
		expect(store.get("b")).toBeUndefined();
		store.close();
	});

	it("keeps a deletion across a reopen", () => {
		const store = Store.open(dir);
		try {
			expect(store.get("b")).toBeUndefined();
		} finally {
			store.close();
		}
	});
});

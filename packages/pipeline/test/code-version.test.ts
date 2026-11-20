import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const table = vi.hoisted(() => ({
	moduleHashes: { "a.ts": "1", "b.ts": "2" } as Record<string, string>,
	producerModules: { lens: ["a.ts", "b.ts"], broken: ["a.ts", "missing.ts"] } as Record<string, string[]>,
}));
vi.mock("../src/code-hashes.ts", () => table);

import { codeVersion } from "../src/code-version.ts";

describe("codeVersion", () => {
	it("hashes each of the producer's modules as a path and its hash, one per line", () => {
		expect(codeVersion("lens")).toBe(createHash("sha256").update("a.ts 1\nb.ts 2\n").digest("hex"));
	});

	it("moves when one of the producer's module hashes moves", () => {
		const before = codeVersion("lens");
		table.moduleHashes["b.ts"] = "3";
		try {
			expect(codeVersion("lens")).not.toBe(before);
		} finally {
			table.moduleHashes["b.ts"] = "2";
		}
	});

	it("refuses a producer the table does not hold, an inherited name included", () => {
		expect(() => codeVersion("other")).toThrow("no code is recorded for the producer other");
		expect(() => codeVersion("toString")).toThrow("no code is recorded for the producer toString");
	});

	it("refuses a module whose hash the table does not hold, an inherited name included", () => {
		expect(() => codeVersion("broken")).toThrow("broken reaches missing.ts, whose hash is not recorded");
		table.producerModules.inherited = ["constructor"];
		expect(() => codeVersion("inherited")).toThrow("inherited reaches constructor, whose hash is not recorded");
	});
});

describe("melianInstall", () => {
	it("reads Melian's install from its own module, once a process", async () => {
		vi.resetModules();
		const { Install } = await import("../src/installed-packages.ts");
		const read = vi.spyOn(Install, "read");
		const { melianInstall } = await import("../src/code-version.ts");
		const first = melianInstall();
		expect(melianInstall()).toBe(first);
		expect(read.mock.calls).toEqual([[new URL("../src/code-version.ts", import.meta.url).href]]);
		expect(first.digest).toBe(Install.read(new URL("../src/code-version.ts", import.meta.url).href).digest);
	});
});

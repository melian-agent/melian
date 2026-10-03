import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const permitted = ["packages/pipeline/src/harness.ts", "packages/pipeline/src/testing.ts"];
const piImport = /["']@earendil-works\/(?:pi-durable|pi-ai|chord)(?:\/[^"']*)?["']/;

// Repository-relative posix paths, so the filters and the permitted paths match on Windows too.
function sources(): string[] {
	return readdirSync(join(root, "packages"), { recursive: true, encoding: "utf8" })
		.map((path) => `packages/${path.split(sep).join("/")}`)
		.filter((path) => /\.[cm]?tsx?$/.test(path))
		.filter((path) => !/(^|\/)(node_modules|dist)\//.test(path));
}

describe("harness boundary", () => {
	it("only the wrapper and its testing entry import Pi Durable, pi-ai, or Chord", () => {
		const importers = sources().filter((path) => piImport.test(readFileSync(join(root, path), "utf8")));
		expect(importers.sort()).toEqual(permitted);
	});
});

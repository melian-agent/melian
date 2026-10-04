import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const permitted = ["packages/pipeline/src/harness.ts", "packages/pipeline/src/testing.ts"];
// Every way a module names another: `from "x"`, a side-effect `import "x"`, `import("x")` with any quote, and require.
const piImport =
	/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]@earendil-works\/(?:pi-durable|pi-ai|chord)(?:\/[^"'`]*)?["'`]/;

// Repository-relative posix paths, so the filters and the permitted paths match on Windows too. A golden's trees are
// another repository's code, which may have a wrapper of its own.
function sources(): string[] {
	return readdirSync(join(root, "packages"), { recursive: true, encoding: "utf8" })
		.map((path) => `packages/${path.split(sep).join("/")}`)
		.filter((path) => /\.[cm]?[jt]sx?$/.test(path))
		.filter((path) => !/(^|\/)(node_modules|dist)\//.test(path))
		.filter((path) => !path.startsWith("packages/evals/goldens/"));
}

describe("harness boundary", () => {
	it("only the wrapper and its testing entry import Pi Durable, pi-ai, or Chord", () => {
		const importers = sources().filter((path) => piImport.test(readFileSync(join(root, path), "utf8")));
		expect(importers.sort()).toEqual(permitted);
	});
});

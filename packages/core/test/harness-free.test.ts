import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../src", import.meta.url));
// Every way a module names another: `from "x"`, a side-effect `import "x"`, `import("x")` with any quote, and require.
// A bare string match would flag core's own `packageName`.
const forbidden =
	/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`](@earendil-works\/[^"'`]+|@melian-agent\/[^"'`]+)["'`]/g;

describe("core", () => {
	it("imports neither Pi nor another Melian package", () => {
		const imports = readdirSync(src, { recursive: true, encoding: "utf8" })
			.filter((path) => /\.[cm]?[jt]sx?$/.test(path))
			.flatMap((path) =>
				[...readFileSync(join(src, path), "utf8").matchAll(forbidden)].map((match) => `${path}: ${match[1]}`),
			);
		expect(imports).toEqual([]);
	});
});

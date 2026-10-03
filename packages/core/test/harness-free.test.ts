import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../src", import.meta.url));
const forbidden = /from\s+["'](@earendil-works\/[^"']+|@melian-agent\/[^"']+)["']/g;

describe("core", () => {
	it("imports neither Pi nor another Melian package", () => {
		const imports = readdirSync(src, { recursive: true, encoding: "utf8" })
			.filter((path) => path.endsWith(".ts"))
			.flatMap((path) =>
				[...readFileSync(join(src, path), "utf8").matchAll(forbidden)].map((match) => `${path}: ${match[1]}`),
			);
		expect(imports).toEqual([]);
	});
});

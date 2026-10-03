import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const wrapper = "packages/pipeline/src/harness.ts";
const piImport = /["']@earendil-works\/(?:pi-durable|chord)(?:\/[^"']*)?["']/;

function sources(): string[] {
	const packages = join(root, "packages");
	return readdirSync(packages, { recursive: true, encoding: "utf8" })
		.filter((path) => /\.[cm]?tsx?$/.test(path))
		.filter((path) => !/(^|\/)(node_modules|dist)\//.test(path))
		.map((path) => relative(root, join(packages, path)));
}

describe("harness boundary", () => {
	it("only the wrapper imports Pi Durable or Chord", () => {
		const files = sources();
		expect(files).toContain(wrapper);
		const offenders = files.filter(
			(path) => path !== wrapper && piImport.test(readFileSync(join(root, path), "utf8")),
		);
		expect(offenders).toEqual([]);
	});
});

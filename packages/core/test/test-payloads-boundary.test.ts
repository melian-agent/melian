import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const permitted = ["packages/core/src/testing.ts"];

// Every product source file, as a repository-relative posix path. A test file or a testing entry may name the value.
function sources(): string[] {
	return readdirSync(join(root, "packages"), { recursive: true, encoding: "utf8" })
		.map((path) => `packages/${path.split(sep).join("/")}`)
		.filter((path) => /^packages\/[^/]+\/src\/.*\.[cm]?[jt]sx?$/.test(path));
}

// A file that names the identifier at all is refused: an import, a re-export, or a property read alike.
function naming(files: { path: string; text: string }[]): string[] {
	return files.filter(({ text }) => /\btestPayloads\b/.test(text)).map(({ path }) => path);
}

describe("testPayloads stays in tests", () => {
	it("is named by no product source but core's testing entry", () => {
		const files = sources().map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
		expect(naming(files).sort()).toEqual(permitted);
	});

	it("trips on a product source that imports it", () => {
		const planted = [
			{ path: "packages/cli/src/review.ts", text: 'import { testPayloads } from "@melian-agent/core/testing";' },
			{ path: "packages/pipeline/src/review.ts", text: "const checks = testing.testPayloads;" },
			{ path: "packages/github/src/ledger.ts", text: "const checks = myTestPayloadsCopy;" },
		];
		expect(naming(planted)).toEqual(["packages/cli/src/review.ts", "packages/pipeline/src/review.ts"]);
	});
});

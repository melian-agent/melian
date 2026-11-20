import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as nodeModule from "node:module";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/**
 * Runs `build` with Node's resolver answering `name`, wherever it is resolved from, with a copy of its installed manifest
 * that names `version`, so the code under test reads an install where that one package moved. Modules are reloaded
 * inside, so `build` imports what it tests itself.
 */
export async function withMovedPackage<T>(name: string, version: string, build: () => Promise<T>): Promise<T> {
	const real = findPackageJSON(name, import.meta.url);
	if (real === undefined) throw new Error(`${name} is not installed`);
	const scratch = mkdtempSync(join(tmpdir(), "melian-moved-package-"));
	const moved = join(scratch, "package.json");
	mkdirSync(scratch, { recursive: true });
	writeFileSync(moved, JSON.stringify({ ...JSON.parse(readFileSync(real, "utf8")), version }));
	vi.resetModules();
	vi.doMock("node:module", async (original) => {
		const actual = await original<typeof nodeModule>();
		const answer = (specifier: string, base?: string | URL) =>
			specifier === name ? moved : actual.findPackageJSON(specifier, base);
		return { ...actual, default: { ...actual, findPackageJSON: answer }, findPackageJSON: answer };
	});
	try {
		return await build();
	} finally {
		vi.doUnmock("node:module");
		vi.resetModules();
		rmSync(scratch, { recursive: true, force: true });
	}
}

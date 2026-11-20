import type * as nodeFs from "node:fs";
import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { vi } from "vitest";

/**
 * Runs `build` with `name`'s installed manifest reading as one that names `version`, at the place it is installed, so
 * the code under test reads an install where only that package's release moved. Modules are reloaded inside, so
 * `build` imports what it tests itself.
 */
export async function withMovedPackage<T>(name: string, version: string, build: () => Promise<T>): Promise<T> {
	const found = findPackageJSON(name, import.meta.url);
	if (found === undefined) throw new Error(`${name} is not installed`);
	const real = realpathSync(found);
	const moved = JSON.stringify({ ...JSON.parse(readFileSync(real, "utf8")), version });
	vi.resetModules();
	vi.doMock("node:fs", async (original) => {
		const actual = await original<typeof nodeFs>();
		const read = ((path: nodeFs.PathOrFileDescriptor, options?: unknown) =>
			path === real ? moved : actual.readFileSync(path, options as never)) as typeof actual.readFileSync;
		return { ...actual, default: { ...actual, readFileSync: read }, readFileSync: read };
	});
	try {
		return await build();
	} finally {
		vi.doUnmock("node:fs");
		vi.resetModules();
	}
}

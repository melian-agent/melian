import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError, stateDirectory } from "../src/repository.ts";

describe("stateDirectory", () => {
	it("reports a directory git refuses as a CliError, which carries no numeric code", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "melian-not-a-repo-")));
		try {
			// macOS's git shim keeps a cache in TMPDIR where it cannot reach the per-user temporary directory, as inside
			// Melian's sandbox, and without one it warns on stderr ahead of git's own message.
			const failure = await stateDirectory(directory, {
				GIT_CEILING_DIRECTORIES: directory,
				TMPDIR: tmpdir(),
			}).catch((error) => error);
			expect(failure).toBeInstanceOf(CliError);
			expect((failure as { code?: unknown }).code).toBeUndefined();
			expect((failure as Error).message).toMatch(/^git rev-parse failed: fatal: /);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError, stateDirectory } from "../src/repository.ts";

describe("stateDirectory", () => {
	it("reports a directory git refuses as a CliError, which carries no numeric code", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "melian-not-a-repo-")));
		try {
			const failure = await stateDirectory(directory, { GIT_CEILING_DIRECTORIES: directory }).catch((error) => error);
			expect(failure).toBeInstanceOf(CliError);
			expect((failure as { code?: unknown }).code).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

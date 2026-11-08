import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { changeset, note, Remote, storageOf } from "./fixtures/state.ts";

vi.mock("node:fs/promises", { spy: true });

let remote: Remote;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	remote = new Remote();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	remote.close();
});

it("expires its own lease when restoring the copy fails after taking it", async () => {
	const writer = await remote.clone().branch().checkout(changeset);
	await note(await storageOf(writer), "stored");
	await writer.push();
	const actual = await vi.importActual<typeof fsp>("node:fs/promises");
	vi.mocked(fsp.writeFile).mockImplementation(async (path, ...rest) => {
		if (String(path).endsWith(".synced"))
			throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		return actual.writeFile(path, ...rest);
	});
	await expect(remote.clone().branch().checkout(changeset)).rejects.toThrow("no space left on device");
	vi.mocked(fsp.writeFile).mockRestore();
	const lease = (
		remote.index() as { changesets: Record<string, { lease: { generation: number; expiresAt: string } }> }
	).changesets[changeset]!.lease;
	expect(lease.generation).toBe(2);
	expect(Date.parse(lease.expiresAt)).toBeLessThanOrEqual(Date.now());
	await expect(remote.clone().branch().checkout(changeset)).resolves.toBeDefined();
});

it("says the lease stays on the branch when expiring it fails too", async () => {
	const writer = await remote.clone().branch().checkout(changeset);
	await note(await storageOf(writer), "stored");
	await writer.push();
	const actual = await vi.importActual<typeof fsp>("node:fs/promises");
	vi.mocked(fsp.writeFile).mockImplementation(async (path, ...rest) => {
		if (String(path).endsWith(".synced")) {
			// The branch refuses every push from here, so the lease cannot be expired.
			const hook = join(remote.bare, "hooks", "pre-receive");
			await actual.writeFile(hook, "#!/bin/sh\nexit 1\n");
			await actual.chmod(hook, 0o755);
			throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		}
		return actual.writeFile(path, ...rest);
	});
	await expect(remote.clone().branch().checkout(changeset)).rejects.toThrow(
		/^no space left on device; the lease, generation 2, stays on melian\/state until \S+, since expiring it failed: git push of melian\/state failed: /,
	);
});

import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { changeset, note, Remote, storageOf } from "./fixtures/state.ts";

// Every test here runs git against real repositories, which takes seconds on a loaded host.
vi.setConfig({ testTimeout: 60_000 });

vi.mock("node:fs/promises", { spy: true });

let remote: Remote;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	remote = new Remote();
});

afterEach(() => {
	// A module spied with `spy: true` keeps a test's implementation through restoreAllMocks.
	vi.mocked(fsp.writeFile).mockReset();
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

it("leaves alone a lease another run took before the restore failed", async () => {
	const start = Date.parse("2026-11-08T00:00:00Z");
	const hour = 60 * 60 * 1000;
	const writer = await remote
		.clone({ now: () => start })
		.branch()
		.checkout(changeset);
	await note(await storageOf(writer), "stored");
	await writer.push();
	const actual = await vi.importActual<typeof fsp>("node:fs/promises");
	vi.mocked(fsp.writeFile).mockImplementation(async (path, ...rest) => {
		if (String(path).endsWith(".synced") && String(path).includes("clone-2")) {
			// Another run takes the lease once it has expired, before this restore fails.
			vi.mocked(fsp.writeFile).mockImplementation(actual.writeFile as never);
			await remote
				.clone({ now: () => start + 6 * hour })
				.branch()
				.checkout(changeset);
			throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		}
		return actual.writeFile(path, ...rest);
	});
	await expect(
		remote
			.clone({ now: () => start + 3 * hour })
			.branch()
			.checkout(changeset),
	).rejects.toThrow(/^no space left on device$/);
	const lease = (
		remote.index() as { changesets: Record<string, { lease: { generation: number; expiresAt: string } }> }
	).changesets[changeset]!.lease;
	expect(lease.generation).toBe(3);
	expect(lease.expiresAt).toBe(new Date(start + 8 * hour).toISOString());
});

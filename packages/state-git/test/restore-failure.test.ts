import { readFileSync } from "node:fs";
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
	vi.mocked(fsp.link).mockReset();
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
	// After the writer's push released its lease, so this clone can take it.
	const start = Date.now() + 60 * 60 * 1000;
	const until = new Date(start + 2 * 60 * 60 * 1000).toISOString().replaceAll(".", "\\.");
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
	await expect(
		remote
			.clone({ now: () => start })
			.branch()
			.checkout(changeset),
	).rejects.toThrow(
		new RegExp(
			`^no space left on device; the lease, generation 2, stays on melian/state until ${until}, since expiring it failed: git push of melian/state failed: `,
		),
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

it("gives two first checkouts of a copies directory the one clone ID, though the first is slow to write it", async () => {
	const actual = await vi.importActual<typeof fsp>("node:fs/promises");
	let held = false;
	vi.mocked(fsp.writeFile).mockImplementation(async (path, data, options) => {
		// The first writer of the ID creates its file, then pauses before the ID is in it, as a slow disk lets another
		// reader in between.
		if (!held && String(path).includes(".clone-id")) {
			held = true;
			await actual.writeFile(path, "", options);
			await new Promise((resolve) => setTimeout(resolve, 300));
			return actual.writeFile(path, data);
		}
		return actual.writeFile(path, data, options);
	});
	const clone = remote.clone();
	const ids = ["pull-0000000000000001", "pull-0000000000000002"];
	const checkouts = await Promise.all(ids.map((id) => clone.branch().checkout(id)));
	expect(checkouts.map((checkout) => checkout.changeset)).toEqual(ids);
	expect(readFileSync(join(clone.directory, ".clone-id"), "utf8").trim()).toMatch(/^[0-9a-f-]{36}$/);
});

it("reports a failure to link the clone ID into place as itself, not as a missing ID", async () => {
	vi.mocked(fsp.link).mockImplementation(async () => {
		throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
	});
	const clone = remote.clone();
	await expect(clone.branch().checkout(changeset)).rejects.toMatchObject({
		code: "EPERM",
		message: "operation not permitted",
	});
	vi.mocked(fsp.link).mockRestore();
	expect(remote.tip()).toBeUndefined();
});

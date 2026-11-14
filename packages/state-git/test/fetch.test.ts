import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeset, check, keys, other, Remote } from "./fixtures/remote.ts";

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await remote.close();
});

describe("reading the branch", { timeout: 60_000 }, () => {
	it("fails the call when the fetch dies part-way through the pack, and answers once it does not", async () => {
		const writer = await remote.open();
		await writer.add(
			Array.from({ length: 30 }, (_, n) => check(`k${n}`, changeset, { noise: randomBytes(512).toString("hex") })),
		);
		// Git honours this hook only from protected configuration, so the test's own global file carries it.
		const hook = join(remote.root, "cut-pack.sh");
		await writeFile(hook, '#!/bin/sh\n"$@" | head -c 2000\n');
		await chmod(hook, 0o755);
		const global = join(remote.root, "global-config");
		await writeFile(global, `[uploadpack]\n\tpackObjectsHook = ${hook}\n`);
		vi.stubEnv("GIT_CONFIG_GLOBAL", global);
		const reader = await remote.open();
		await expect(reader.list(changeset)).rejects.toMatchObject({ code: "unreachable" });
		vi.unstubAllEnvs();
		expect(keys(await reader.list(changeset))).toHaveLength(30);
	});

	it("reads an absent branch as an empty store", async () => {
		const store = await remote.open();
		expect(await store.list(changeset)).toEqual([]);
		expect(await store.readCell(changeset)).toEqual({});
		expect(remote.tip()).toBeUndefined();
	});

	it("fetches the tip alone into its own repository, and never touches the clone", async () => {
		const writer = await remote.open();
		for (const key of ["a", "b", "c"]) await writer.add([check(key)]);
		const clone = join(remote.root, "clone");
		remote.git(["clone", "--quiet", remote.url, clone], remote.root);
		const refs = remote.git(["for-each-ref"], clone);
		const store = await remote.open({ directory: join(clone, ".git", "melian") });
		expect(keys(await store.list(changeset))).toEqual(["a", "b", "c"]);
		expect(existsSync(join(clone, ".git", "shallow"))).toBe(false);
		expect(existsSync(join(clone, ".git", "FETCH_HEAD"))).toBe(false);
		expect(remote.git(["for-each-ref"], clone)).toBe(refs);
		const records = join(clone, ".git", "melian", "records.git");
		expect(remote.git(["--git-dir", records, "rev-list", "--all", "--count"], records)).toBe("0");
		expect(remote.git(["--git-dir", records, "rev-list", "--count", remote.tip()!], records)).toBe("1");
		expect(remote.git(["rev-list", "--count", remote.tip()!])).toBe("3");
	});

	it("answers each call from the tip as it is then, on any handle", async () => {
		const reader = await remote.open();
		expect(await reader.list(other)).toEqual([]);
		await (await remote.open()).add([check("late", other)]);
		expect(keys(await reader.list(other))).toEqual(["late"]);
	});
});

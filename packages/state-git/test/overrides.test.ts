import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Configuration from "../src/configuration.ts";
import { changeset, check, Remote } from "./fixtures/remote.ts";

// The overrides must hold on their own, so this file switches the configuration check off.
vi.mock("../src/configuration.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Configuration>()),
	checkConfiguration: async () => {},
}));

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	await remote.close();
});

async function script(path: string, marker: string): Promise<void> {
	await writeFile(path, `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null\nexit 1\n`);
	await chmod(path, 0o755);
}

async function configure(directory: string, settings: string): Promise<void> {
	await writeFile(
		join(directory, "records.git", "config"),
		`[core]\n\trepositoryformatversion = 0\n\tbare = true\n${settings}`,
	);
}

describe("the settings Melian passes on every command", { timeout: 60_000 }, () => {
	it("keep a hook in the repository's configuration from running", async () => {
		const directory = remote.host();
		const store = await remote.open({ directory });
		const hooks = join(remote.root, "hooks");
		await mkdir(hooks);
		const marker = join(remote.root, "hook-ran");
		for (const hook of ["reference-transaction", "post-update", "pre-push"]) await script(join(hooks, hook), marker);
		await configure(directory, `\thooksPath = ${hooks}\n`);
		await store.add([check("a")]);
		expect(await store.list(changeset)).toHaveLength(1);
		expect(existsSync(marker)).toBe(false);
	});

	it("keep a commit or a push from being signed", async () => {
		const directory = remote.host();
		const store = await remote.open({ directory });
		const marker = join(remote.root, "signed");
		const program = join(remote.root, "gpg");
		await script(program, marker);
		await configure(
			directory,
			`[commit]\n\tgpgSign = true\n[push]\n\tgpgSign = true\n[gpg]\n\tprogram = ${program}\n`,
		);
		await store.add([check("a")]);
		expect(remote.files()).toHaveLength(1);
		expect(existsSync(marker)).toBe(false);
	});

	it("refuse an ext:: remote that the repository's configuration allows", async () => {
		const directory = remote.host();
		const marker = join(remote.root, "ext-ran");
		const store = await remote.open({ directory, remote: `ext::sh -c touch% ${marker}` });
		await configure(directory, `[protocol "ext"]\n\tallow = always\n`);
		await expect(store.list(changeset)).rejects.toMatchObject({ code: "unreachable" });
		expect(existsSync(marker)).toBe(false);
	});
});

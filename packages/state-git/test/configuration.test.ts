import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryConfiguration } from "../src/configuration.ts";
import { GitRecordStore } from "../src/index.ts";
import { changeset, check, Remote } from "./fixtures/remote.ts";

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	await remote.close();
});

describe("the repository's configuration", { timeout: 60_000 }, () => {
	it("is written as Melian's bytes alone", async () => {
		const directory = remote.host();
		await GitRecordStore.open({ directory, remote: remote.url });
		expect(await readFile(join(directory, "records.git", "config"), "utf8")).toBe(repositoryConfiguration);
	});

	for (const added of [
		"[credential]\n\thelper = !touch /tmp/never\n",
		"[include]\n\tpath = /tmp/never\n",
		'[url "file:///tmp/never"]\n\tinsteadOf = file://\n',
	])
		it(`refuses every call once the file gains ${added.split("\n")[0]}`, async () => {
			const directory = remote.host();
			const store = await remote.open({ directory });
			await store.add([check("before")]);
			const config = join(directory, "records.git", "config");
			await appendFile(config, added);
			await expect(store.list(changeset)).rejects.toMatchObject({ code: "unreachable", path: config });
			await expect(store.add([check("after")])).rejects.toMatchObject({ code: "unreachable" });
			expect(remote.files().some((path) => path.includes("after"))).toBe(false);
		});

	it("refuses to open a repository whose configuration changed", async () => {
		const directory = remote.host();
		await GitRecordStore.open({ directory, remote: remote.url });
		await writeFile(join(directory, "records.git", "config"), `${repositoryConfiguration}\tbare = false\n`);
		await expect(GitRecordStore.open({ directory, remote: remote.url })).rejects.toMatchObject({
			code: "unreachable",
		});
	});

	it("refuses a repository path that is a file", async () => {
		const directory = remote.host();
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "records.git"), "");
		await expect(GitRecordStore.open({ directory, remote: remote.url })).rejects.toMatchObject({
			code: "unreachable",
		});
	});

	it("opens one repository when many handles open it at once", async () => {
		const directory = remote.host();
		const stores = await Promise.all(Array.from({ length: 6 }, () => remote.open({ directory })));
		await Promise.all(stores.map((store, n) => store.add([check(`k${n}`)])));
		expect(await readFile(join(directory, "records.git", "config"), "utf8")).toBe(repositoryConfiguration);
		expect((await readdir(directory)).sort()).toEqual(["records.git"]);
	});
});

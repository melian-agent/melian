import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordRepository } from "../src/repository.ts";
import { changeset, check, keys, Remote } from "./fixtures/remote.ts";

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await remote.close();
});

const hint = "refs/melian/last";

const many = Array.from({ length: 60 }, (_, n) => check(`record-${n}`));

// Runs `call` with git's trace on, and counts the objects in every pack a fetch received, from the pack's header as
// git hands it to the command that stores the pack.
async function received(call: () => Promise<unknown>): Promise<number> {
	const trace = join(remote.root, `trace-${Date.now()}`);
	vi.stubEnv("GIT_TRACE", trace);
	try {
		await call();
	} finally {
		vi.unstubAllEnvs();
	}
	const text = await readFile(trace, "utf8").catch(() => "");
	return [...text.matchAll(/trace: built-in: git (?:index-pack|unpack-objects) .*--pack_header=2,(\d+)/g)].reduce(
		(total, [, count]) => total + Number(count),
		0,
	);
}

async function reader(): Promise<{
	add(key: string): Promise<void>;
	list(): Promise<string[]>;
	records: string;
}> {
	const directory = remote.host();
	const store = await remote.open({ directory });
	return {
		add: async (key) => {
			await store.add([check(key)]);
		},
		list: async () => keys(await store.list(changeset)),
		records: join(directory, "records.git"),
	};
}

function refs(gitDir: string): string[] {
	return remote
		.git(["--git-dir", gitDir, "for-each-ref", "--format=%(refname)"], remote.root)
		.split("\n")
		.filter(Boolean);
}

describe("the last tip a handle fetched", { timeout: 60_000 }, () => {
	it("fetches no objects again for a branch that has not moved", async () => {
		const writer = await remote.open();
		await writer.add(many);
		await writer.add([check("second commit")]);
		const handle = await reader();
		expect(await received(handle.list)).toBeGreaterThan(many.length);
		expect(await received(handle.list)).toBe(0);
	});

	it("fetches one record's objects for a branch grown by one record, not the tip again", async () => {
		const writer = await remote.open();
		await writer.add(many);
		const handle = await reader();
		await handle.list();
		const before = remote.tip() as string;
		await writer.add([check("one more")]);
		const grown = remote.git(["rev-list", "--objects", remote.tip() as string, `^${before}`]).split("\n").length;
		expect(grown).toBeLessThan(10);
		expect(await received(handle.list)).toBe(grown);
		expect(await handle.list()).toContain("one more");
	});

	it("stays in the handle's own repository, never pushed to the remote", async () => {
		const handle = await reader();
		await handle.add("a");
		await handle.list();
		expect(refs(handle.records)).toEqual([hint]);
		expect(refs(remote.path)).toEqual([`refs/heads/${remote.branch}`]);
	});

	it("decides nothing a call returns, absent, stale or unrelated", async () => {
		const writer = await remote.open();
		const handle = await reader();
		await writer.add([check("a")]);
		await handle.list();
		const stale = remote.tip() as string;
		await writer.add([check("b")]);
		const expected = await (await reader()).list();
		expect(expected).toEqual(["a", "b"]);
		await handle.list();
		const unrelated = remote.git(
			[
				"--git-dir",
				handle.records,
				"commit-tree",
				remote.git(["--git-dir", handle.records, "mktree"], remote.root, { input: "" }),
				"-m",
				"unrelated",
			],
			remote.root,
		);
		for (const target of [undefined, stale, unrelated]) {
			if (target === undefined) remote.git(["--git-dir", handle.records, "update-ref", "-d", hint], remote.root);
			else remote.git(["--git-dir", handle.records, "update-ref", hint, target], remote.root);
			expect(await handle.list()).toEqual(expected);
		}
	});

	it("updates it once for each fetch when nothing holds its lock", async () => {
		const handle = await reader();
		await (await remote.open()).add([check("a")]);
		const run = vi.spyOn(RecordRepository.prototype, "run");
		expect(await handle.list()).toEqual(["a"]);
		expect(run.mock.calls.filter(([args]) => args[0] === "update-ref" && args[1] === hint)).toHaveLength(1);
	});

	it("gives up updating it after twenty tries at a held lock, and the call still answers", async () => {
		const handle = await reader();
		await (await remote.open()).add([check("a")]);
		await mkdir(join(handle.records, "refs", "melian"), { recursive: true });
		await writeFile(join(handle.records, `${hint}.lock`), "");
		const run = vi.spyOn(RecordRepository.prototype, "run");
		expect(await handle.list()).toEqual(["a"]);
		expect(run.mock.calls.filter(([args]) => args[0] === "update-ref" && args[1] === hint)).toHaveLength(20);
		expect(refs(handle.records)).toEqual([]);
	});

	it("updates it on the twentieth try once the lock is let go", async () => {
		const handle = await reader();
		await (await remote.open()).add([check("a")]);
		await mkdir(join(handle.records, "refs", "melian"), { recursive: true });
		const lock = join(handle.records, `${hint}.lock`);
		await writeFile(lock, "");
		const run = RecordRepository.prototype.run;
		let tries = 0;
		vi.spyOn(RecordRepository.prototype, "run").mockImplementation(async function (
			this: RecordRepository,
			args,
			...rest
		) {
			if (args[0] === "update-ref" && args[1] === hint && ++tries === 20) await rm(lock);
			return run.call(this, args, ...rest);
		});
		expect(await handle.list()).toEqual(["a"]);
		expect(tries).toBe(20);
		expect(refs(handle.records)).toEqual([hint]);
	});
});

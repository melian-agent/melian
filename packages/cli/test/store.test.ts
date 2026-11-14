import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository, gitIn, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import { stateDirectory } from "../src/repository.ts";
import { size } from "../src/store.ts";

const day = 24 * 60 * 60 * 1000;
let repo: string;
let scratch: string;
let state: string;
const worktrees: string[] = [];

beforeEach(async () => {
	repo = createRepository();
	scratch = await mkdtemp(join(await realpath(tmpdir()), "melian-store-cli-"));
	state = await stateDirectory(repo, { MELIAN_STATE_DIR: scratch });
});
afterEach(async () => {
	for (const path of worktrees.splice(0)) {
		gitIn(repo, "worktree", "unlock", path);
		gitIn(repo, "worktree", "remove", "--force", path);
	}
	removeRepository(repo);
	await rm(scratch, { recursive: true, force: true });
});

function output(): Io & { lines: string[]; errors: string[] } {
	const lines: string[] = [];
	const errors: string[] = [];
	return {
		cwd: repo,
		env: { MELIAN_STATE_DIR: scratch, XDG_CONFIG_HOME: join(scratch, "config"), PATH: process.env.PATH },
		stdout: (text) => lines.push(text),
		stderr: (text) => errors.push(text),
		color: false,
		lines,
		errors,
	};
}

async function write(path: string, text: string, ageMs = 0): Promise<void> {
	await mkdir(join(state, path, ".."), { recursive: true });
	await writeFile(join(state, path), text);
	if (ageMs > 0) {
		const when = new Date(Date.now() - ageMs);
		await utimes(join(state, path), when, when);
		await utimes(join(state, path, ".."), when, when);
	}
}

async function seed(): Promise<{ pinned: string }> {
	const hex = (digit: string) => digit.repeat(64);
	await write("pull-1.sqlite", "changeset");
	await write("pull-1.sqlite-wal", "wal");
	await write(`graphs/${hex("a")}/partial`, "x", 2 * day);
	await write(`coverage/${hex("b")}/index.json`, "0123456789");
	await write(`mutation/${hex("c")}/report.json`, "old", 15 * day);
	await write("tools/gone/1.0.0/linux-x64/file", "tool");
	await write("notes.txt", "mine");
	await write("todo.txt", "also");
	const pinned = `tools/enola/0.4.40/linux-x64/${hex("e")}/binary`;
	await write(pinned, "pinned");
	return { pinned };
}

async function exists(path: string): Promise<boolean> {
	return readdir(join(state, path, "..")).then(
		(names) => names.includes(path.split("/").at(-1)!),
		() => false,
	);
}

describe("melian store prune", { timeout: 60_000 }, () => {
	it("lists what it would remove and the space it frees, and removes nothing without --apply", async () => {
		const { pinned } = await seed();
		const io = output();
		expect(await main(["store", "prune"], io)).toBe(0);
		expect(io.lines).toEqual([
			[
				`State directory: ${state}`,
				"Would remove 3 entries, freeing 14 B. Nothing is removed without --apply.",
				`  unreadable graph  1 B  graphs/${"a".repeat(64)}`,
				`  orphan coverage  10 B  coverage/${"b".repeat(64)}`,
				`  mutation partition  3 B  mutation/${"c".repeat(64)}`,
				"  unreadable graph: 1, 1 B",
				"  orphan coverage: 1, 10 B",
				"  mutation partition: 1, 3 B",
				"Kept 1 changeset file, 12 B, and scripted/.",
				"Kept, not recognised: notes.txt, todo.txt",
				"",
			].join("\n"),
		]);
		expect(io.errors).toEqual([]);
		for (const path of [`graphs/${"a".repeat(64)}`, `coverage/${"b".repeat(64)}`, "tools/gone", pinned])
			expect(await exists(path)).toBe(true);
	});

	it("removes the listed cache with --apply and keeps changesets, tools and unrecognised names", async () => {
		const { pinned } = await seed();
		const io = output();
		expect(await main(["store", "prune", "--apply"], io)).toBe(0);
		expect(io.lines.join("")).toContain("Removed 3 entries, freeing 14 B.\n");
		for (const path of [`graphs/${"a".repeat(64)}`, `coverage/${"b".repeat(64)}`, `mutation/${"c".repeat(64)}`])
			expect(await exists(path)).toBe(false);
		expect(await readFile(join(state, "tools/gone/1.0.0/linux-x64/file"), "utf8")).toBe("tool");
		expect(await readFile(join(state, "pull-1.sqlite"), "utf8")).toBe("changeset");
		expect(await readFile(join(state, "pull-1.sqlite-wal"), "utf8")).toBe("wal");
		expect(await readFile(join(state, pinned), "utf8")).toBe("pinned");
		expect(await readFile(join(state, "notes.txt"), "utf8")).toBe("mine");
		const again = output();
		expect(await main(["store", "prune"], again)).toBe(0);
		expect(again.lines.join("")).toContain("Would remove 0 entries, freeing 0 B.");
	});

	it("counts one entry and many changeset files, lists every path an entry takes, and omits an empty kept line", async () => {
		const name = "d".repeat(64);
		await write("pull-1.sqlite", "one");
		await write("pull-2.sqlite", "two");
		await write(
			`graphs/${name}/entry.json`,
			JSON.stringify({
				format_version: 1,
				key: name,
				parts: { tree: "e".repeat(40) },
				created: new Date(Date.now() - 8 * day).toISOString(),
			}),
		);
		await write(`coverage/${name}/index.json`, "12345");
		const bytes = (await readFile(join(state, `graphs/${name}/entry.json`))).length + 5;
		const shown = `${bytes} B`;
		for (const apply of [false, true]) {
			const io = output();
			expect(await main(apply ? ["store", "prune", "--apply"] : ["store", "prune"], io)).toBe(0);
			expect(io.lines).toEqual([
				[
					`State directory: ${state}`,
					apply
						? `Removed 1 entry, freeing ${shown}.`
						: `Would remove 1 entry, freeing ${shown}. Nothing is removed without --apply.`,
					`  graph  ${shown}  graphs/${name}, coverage/${name}`,
					`  graph: 1, ${shown}`,
					"Kept 2 changeset files, 6 B, and scripted/.",
					"",
				].join("\n"),
			]);
		}
		expect(await exists(`graphs/${name}`)).toBe(false);
		expect(await exists(`coverage/${name}`)).toBe(false);
	});

	it("removes nothing beside a live static check, names every one and exits 1", async () => {
		await seed();
		gitIn(repo, "commit", "--quiet", "--allow-empty", "-m", "base");
		const paths = [join(scratch, "worktree-a"), join(scratch, "worktree-b")];
		for (const path of paths) {
			gitIn(
				repo,
				"worktree",
				"add",
				"--quiet",
				"--detach",
				"--lock",
				"--reason",
				`melian-static pid ${process.pid}`,
				path,
			);
			worktrees.push(path);
		}
		const refusal = (order: string[]) =>
			`melian: a static check is running (${order.map((path) => `pid ${process.pid} at ${path}`).join("; ")}), so prune removes nothing; run it again once the review ends\n`;
		for (const args of [
			["store", "prune"],
			["store", "prune", "--apply"],
		]) {
			const io = output();
			expect(await main(args, io)).toBe(1);
			expect([refusal(paths), refusal([...paths].reverse())]).toContain(io.errors.join(""));
		}
		expect(await exists(`graphs/${"a".repeat(64)}`)).toBe(true);
		expect(await exists("tools/gone")).toBe(true);
	});

	it.each([
		[["store"], "store takes prune"],
		[["store", "compact"], "store takes prune"],
		[["store", "prune", "extra"], "store takes prune"],
		[["doctor", "--apply"], "--apply is only available for store prune"],
	])("refuses %j as a command line it cannot read", async (args, message) => {
		await seed();
		const io = output();
		expect(await main(args, io)).toBe(64);
		expect(io.errors[0]).toBe(`melian: ${message}\n`);
		expect(await exists("tools/gone")).toBe(true);
	});

	it.each([
		[0, "0 B"],
		[1023, "1023 B"],
		[1024, "1.0 KiB"],
		[1536, "1.5 KiB"],
		[1024 ** 2, "1.0 MiB"],
		[1024 ** 3 * 2.5, "2.5 GiB"],
		[1024 ** 4, "1.0 TiB"],
		[1024 ** 5, "1.0 PiB"],
		[Number.MAX_SAFE_INTEGER, "8.0 PiB"],
	])("prints %d bytes as %s", (bytes, shown) => {
		expect(size(bytes)).toBe(shown);
	});
});

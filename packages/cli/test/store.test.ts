import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolProvisioning } from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository, gitIn, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import { stateDirectory } from "../src/repository.ts";

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
	const [name, pin] = Object.entries((await ToolProvisioning.manifest()).toJSON().tools)[0]!;
	const [platform, artifact] = Object.entries(pin.platforms)[0]!;
	const pinned = `tools/${name}/${pin.version}/${platform}/${artifact.sha256}/binary`;
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
		const text = io.lines.join("");
		expect(text).toContain(`State directory: ${state}\n`);
		expect(text).toContain("Would remove 4 entries, freeing 18 B. Nothing is removed without --apply.\n");
		expect(text).toContain(`  unreadable graph  1 B  graphs/${"a".repeat(64)}\n`);
		expect(text).toContain(`  orphan coverage  10 B  coverage/${"b".repeat(64)}\n`);
		expect(text).toContain(`  mutation partition  3 B  mutation/${"c".repeat(64)}\n`);
		expect(text).toContain("  unpinned tool  4 B  tools/gone\n");
		expect(text).toContain("  orphan coverage: 1, 10 B\n");
		expect(text).toContain("Kept 1 changeset file, 12 B, and scripted/.\n");
		expect(text).toContain("Kept, not recognised: notes.txt\n");
		expect(io.errors).toEqual([]);
		for (const path of [`graphs/${"a".repeat(64)}`, `coverage/${"b".repeat(64)}`, "tools/gone", pinned])
			expect(await exists(path)).toBe(true);
	});

	it("removes the listed cache with --apply and keeps changesets, pinned tools and unrecognised names", async () => {
		const { pinned } = await seed();
		const io = output();
		expect(await main(["store", "prune", "--apply"], io)).toBe(0);
		expect(io.lines.join("")).toContain("Removed 4 entries, freeing 18 B.\n");
		for (const path of [`graphs/${"a".repeat(64)}`, `coverage/${"b".repeat(64)}`, `mutation/${"c".repeat(64)}`])
			expect(await exists(path)).toBe(false);
		expect(await exists("tools/gone")).toBe(false);
		expect(await readFile(join(state, "pull-1.sqlite"), "utf8")).toBe("changeset");
		expect(await readFile(join(state, "pull-1.sqlite-wal"), "utf8")).toBe("wal");
		expect(await readFile(join(state, pinned), "utf8")).toBe("pinned");
		expect(await readFile(join(state, "notes.txt"), "utf8")).toBe("mine");
		const again = output();
		expect(await main(["store", "prune"], again)).toBe(0);
		expect(again.lines.join("")).toContain("Would remove 0 entries, freeing 0 B.");
	});

	it("removes nothing beside a live static check, names it and exits 1", async () => {
		await seed();
		const path = join(scratch, "worktree");
		gitIn(repo, "commit", "--quiet", "--allow-empty", "-m", "base");
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
		for (const args of [
			["store", "prune"],
			["store", "prune", "--apply"],
		]) {
			const io = output();
			expect(await main(args, io)).toBe(1);
			expect(io.errors.join("")).toBe(
				`melian: a static check is running (pid ${process.pid} at ${path}), so prune removes nothing; run it again once the review ends\n`,
			);
		}
		expect(await exists(`graphs/${"a".repeat(64)}`)).toBe(true);
		expect(await exists("tools/gone")).toBe(true);
	});

	it.each([[["store"]], [["store", "compact"]], [["store", "prune", "extra"]], [["doctor", "--apply"]]])(
		"refuses %j as a command line it cannot read",
		async (args) => {
			await seed();
			const io = output();
			expect(await main(args, io)).toBe(64);
			expect(await exists("tools/gone")).toBe(true);
		},
	);
});

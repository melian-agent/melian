import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WithheldOutput, withheldOutputAge } from "../src/withheld-output.ts";
import { createRepository, removeRepository } from "./fixtures/repo.ts";

let repo: string;
let state: string;
beforeEach(() => {
	repo = createRepository();
	state = realpathSync(mkdtempSync(join(tmpdir(), "melian-withheld-")));
});
afterEach(() => {
	vi.restoreAllMocks();
	removeRepository(repo);
	rmSync(state, { recursive: true, force: true });
});

it("keeps under the clone's state directory, or the one the environment names", async () => {
	expect((await WithheldOutput.open(repo, {})).directory).toBe(join(repo, ".git/melian/withheld"));
	const elsewhere = (await WithheldOutput.open(repo, { MELIAN_STATE_DIR: state })).directory;
	expect(elsewhere.startsWith(`${state}/`)).toBe(true);
	expect(elsewhere.endsWith("/withheld")).toBe(true);
});

it("writes a file only its owner can read, whatever the umask, and never through a file already there", async () => {
	const kept = await WithheldOutput.open(repo, {});
	const previous = process.umask(0o000);
	try {
		const path = await kept.keep("static.tsc", "a".repeat(40), "what tsc said\n", 1_000);
		expect(path).toBe(join(kept.directory, `static.tsc-${"a".repeat(12)}-1000-${process.pid}.log`));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(kept.directory).mode & 0o777).toBe(0o700);
		expect(readFileSync(path, "utf8")).toBe("what tsc said\n");
		await expect(kept.keep("static.tsc", "a".repeat(40), "again", 1_000)).rejects.toMatchObject({ code: "EEXIST" });
		expect(readFileSync(path, "utf8")).toBe("what tsc said\n");
	} finally {
		process.umask(previous);
	}
});

it("removes a kept file past seven days, and not one at seven days", async () => {
	const kept = await WithheldOutput.open(repo, {});
	const now = Date.now();
	const at = await kept.keep("static.biome", "b".repeat(40), "at the bound", now - 2);
	const past = await kept.keep("static.biome", "c".repeat(40), "past the bound", now - 1);
	utimesSync(at, new Date(now - withheldOutputAge), new Date(now - withheldOutputAge));
	utimesSync(past, new Date(now - withheldOutputAge - 1000), new Date(now - withheldOutputAge - 1000));
	const fresh = await kept.keep("static.biome", "d".repeat(40), "new", now);
	expect(readdirSync(kept.directory).sort()).toEqual(
		[at, fresh].map((path) => path.slice(kept.directory.length + 1)).sort(),
	);
	expect(withheldOutputAge).toBe(7 * 24 * 60 * 60 * 1000);
});

it("lists what was kept at or after a time, oldest first, and nothing where nothing was kept", async () => {
	const kept = await WithheldOutput.open(repo, {});
	expect(await kept.since(0)).toEqual([]);
	const now = Date.now();
	const [first, second, third] = [
		await kept.keep("static.tsc", "a".repeat(40), "1", now - 3),
		await kept.keep("static.tsc", "b".repeat(40), "2", now - 2),
		await kept.keep("static.tsc", "c".repeat(40), "3", now - 1),
	];
	for (const [path, seconds] of [
		[first, 300],
		[second, 100],
		[third, 200],
	] as const)
		utimesSync(path!, new Date(now - seconds * 1000), new Date(now - seconds * 1000));
	expect(await kept.since(now - 400_000)).toEqual([first, third, second]);
	expect(await kept.since(now - 200_000)).toEqual([third, second]);
	expect(await kept.since(now - 199_000)).toEqual([second]);
	expect(await kept.since(now)).toEqual([]);
	// A directory that cannot be listed for another reason is an error, not an empty answer.
	rmSync(kept.directory, { recursive: true });
	writeFileSync(kept.directory, "not a directory");
	await expect(kept.since(0)).rejects.toMatchObject({ code: "ENOTDIR" });
});

import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Clock, Deadline, systemClock } from "../src/deadline.ts";
import { RecordRepository } from "../src/repository.ts";
import { changeset, check, Remote } from "./fixtures/remote.ts";

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await remote.close();
});

// Core's git resolves the moment its timer fires, without waiting for git to exit, so a stopped command costs only the
// timer's lateness. This allows for that and for the temporary index a stopped commit removes.
const killMs = 250;

// Puts a git first on PATH that logs each command's arguments and waits `delayMs` before running it.
async function shimGit(delayMs = 0): Promise<() => Promise<string[]>> {
	const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
	const bin = join(remote.root, "shim-bin");
	const log = join(remote.root, "git.log");
	await mkdir(bin, { recursive: true });
	await writeFile(log, "");
	await writeFile(join(bin, "git"), `#!/bin/sh\necho "$*" >> '${log}'\nsleep ${delayMs / 1000}\nexec ${real} "$@"\n`);
	await chmod(join(bin, "git"), 0o755);
	vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
	return async () => (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
}

// A clock that reads `left` ms before a 10 s deadline once `stop` is called, and stands still otherwise.
function heldClock(): Clock & { slept: number[]; stop(left: number): void } {
	let now = 0;
	const slept: number[] = [];
	return {
		slept,
		now: () => now,
		sleep: async (ms) => {
			slept.push(ms);
		},
		stop: (left) => {
			now = 10_000 - left;
		},
	};
}

function deadlineAt(left: number): Deadline {
	const clock = heldClock();
	const deadline = Deadline.after(clock, 10_000);
	clock.stop(left);
	return deadline;
}

const refused = /ran past its deadline$/;

describe("one deadline for a whole call", { timeout: 60_000 }, () => {
	it("ends a call whose every git command is slow within the deadline and one command's kill time", async () => {
		const deadlineMs = 1_500;
		await (await remote.open()).add([check("first")]);
		for (const call of ["add", "list"] as const) {
			const store = await remote.open({ deadlineMs });
			await shimGit(300);
			const started = Date.now();
			const done = call === "add" ? store.add([check("slow")]) : store.list(changeset);
			await expect(done).rejects.toMatchObject({ code: "unreachable" });
			expect(Date.now() - started).toBeLessThan(deadlineMs + killMs);
			vi.unstubAllEnvs();
		}
	});
});

describe("a step the deadline cannot start late", { timeout: 60_000 }, () => {
	async function fetched(): Promise<{ repository: RecordRepository; tip: string }> {
		await (await remote.open()).add([check("a")]);
		const repository = await RecordRepository.open(
			join(remote.host(), "records.git"),
			Deadline.after(systemClock, 30_000),
		);
		const tip = (await repository.fetch(remote.url, remote.branch, Deadline.after(systemClock, 30_000))) as string;
		return { repository, tip };
	}

	it("starts a local read with a millisecond left, and refuses it, starting nothing, with none", async () => {
		const { repository, tip } = await fetched();
		const commands = await shimGit();
		await expect(repository.run(["rev-parse", tip], deadlineAt(1))).resolves.toBeDefined();
		expect(await commands()).toHaveLength(1);
		await expect(repository.run(["rev-parse", tip], deadlineAt(0))).rejects.toMatchObject({
			code: "unreachable",
			message: expect.stringMatching(refused),
		});
		expect(await commands()).toHaveLength(1);
	});

	it("starts a push with a millisecond left, and refuses it, starting nothing, with none", async () => {
		const { repository, tip } = await fetched();
		const commit = await repository.commit(tip, [], Deadline.after(systemClock, 30_000));
		const commands = await shimGit();
		expect(["timedOut", "landed"]).toContain(
			await repository.push(remote.url, remote.branch, commit, tip, deadlineAt(1)),
		);
		const pushes = async () => (await commands()).filter((line) => line.includes(" push "));
		expect(await pushes()).toHaveLength(1);
		vi.unstubAllEnvs();
		const before = remote.tip();
		const after = await repository.commit(before, [], Deadline.after(systemClock, 30_000));
		await shimGit();
		await expect(repository.push(remote.url, remote.branch, after, before, deadlineAt(0))).rejects.toMatchObject({
			code: "unreachable",
			message: expect.stringMatching(refused),
		});
		expect(await pushes()).toHaveLength(0);
		expect(remote.tip()).toBe(before);
	});

	it("sleeps what is left when that is less than the backoff, and not at all with none", async () => {
		const sleeps = async (left: number, ms: number) => {
			const clock = heldClock();
			const deadline = Deadline.after(clock, 10_000);
			clock.stop(left);
			await deadline.sleep(ms);
			return clock.slept;
		};
		expect(await sleeps(100, 50)).toEqual([50]);
		expect(await sleeps(50, 50)).toEqual([50]);
		expect(await sleeps(1, 50)).toEqual([1]);
		expect(await sleeps(0, 50)).toEqual([]);
		expect(await sleeps(-1, 50)).toEqual([]);
	});

	it("waits after a lost race only for what is left of the call, and with none fails without reading again", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		for (const [left, slept, fetches] of [
			[1, [1], 2],
			[0, [], 1],
		] as const) {
			vi.restoreAllMocks();
			vi.spyOn(Math, "random").mockReturnValue(0.5);
			const clock = heldClock();
			const store = await remote.open({ clock, deadlineMs: 10_000 });
			const push = RecordRepository.prototype.push;
			vi.spyOn(RecordRepository.prototype, "push").mockImplementationOnce(async function (
				this: RecordRepository,
				...args
			) {
				remote.plant({ [`changesets/rival-${left}/cell.json`]: null });
				const outcome = await push.apply(this, args);
				clock.stop(left);
				return outcome;
			});
			const fetch = vi.spyOn(RecordRepository.prototype, "fetch");
			await expect(store.add([check(`late-${left}`)])).rejects.toMatchObject({ code: "unreachable" });
			expect(clock.slept).toEqual(slept);
			expect(fetch).toHaveBeenCalledTimes(fetches);
		}
	});
});

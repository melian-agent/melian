import type * as Fs from "node:fs/promises";
import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type * as Core from "@melian-agent/core";
import { git, RecordError } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordRepository } from "../src/repository.ts";
import { Remote } from "./fixtures/remote.ts";

// Creating the repository fails in ways a real disk rarely gives on demand, so these two stand in for git and rename.
vi.mock("@melian-agent/core", async (importOriginal) => {
	const actual = await importOriginal<typeof Core>();
	return { ...actual, git: vi.fn(actual.git) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return { ...actual, rename: vi.fn(actual.rename) };
});

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	vi.mocked(git).mockReset();
	vi.mocked(rename).mockReset();
	await remote.close();
});

function failure(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe("creating the repository", { timeout: 60_000 }, () => {
	it("fails as unreachable, quoting git, when git init fails", async () => {
		const path = join(remote.host(), "records.git");
		vi.mocked(git).mockResolvedValueOnce({ code: 128, stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "boom\n" });
		await expect(RecordRepository.open(path)).rejects.toMatchObject({
			code: "unreachable",
			message: `${path} cannot be created: boom`,
		});
	});

	it("fails as unreachable, keeping the cause, when the rename fails", async () => {
		const host = remote.host();
		const path = join(host, "records.git");
		vi.mocked(rename).mockRejectedValueOnce(failure("EXDEV"));
		const error = await RecordRepository.open(path).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(RecordError);
		expect(error).toMatchObject({ code: "unreachable", message: `${path} cannot be created` });
		expect(((error as RecordError).cause as NodeJS.ErrnoException).code).toBe("EXDEV");
		expect(await readdir(host)).toEqual([]);
	});

	for (const code of ["EEXIST", "ENOTEMPTY"])
		it(`opens the repository another process made first, when the rename fails with ${code}`, async () => {
			const host = remote.host();
			const path = join(host, "records.git");
			const actual = vi.mocked(rename).getMockImplementation() as typeof rename;
			vi.mocked(rename).mockImplementationOnce(async (from, to) => {
				await actual(from, to);
				throw failure(code);
			});
			expect((await RecordRepository.open(path)).path).toBe(path);
			expect(await readdir(host)).toEqual(["records.git"]);
		});
});

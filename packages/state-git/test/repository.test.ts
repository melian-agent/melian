import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RecordError } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordRepository } from "../src/repository.ts";
import { check, Remote } from "./fixtures/remote.ts";

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await remote.close();
});

const absent = "0".repeat(40);

async function opened(): Promise<RecordRepository> {
	return RecordRepository.open(join(remote.host(), "records.git"));
}

// A repository holding the branch's tip, fetched, with the branch holding one record.
async function fetched(): Promise<{ repository: RecordRepository; tip: string }> {
	await (await remote.open()).add([check("a")]);
	const repository = await opened();
	const tip = (await repository.fetch(remote.url, remote.branch, 30_000)) as string;
	return { repository, tip };
}

function unreachable(message: RegExp) {
	return (error: unknown) => {
		expect(error).toBeInstanceOf(RecordError);
		expect((error as RecordError).code).toBe("unreachable");
		expect((error as RecordError).message).toMatch(message);
		return true;
	};
}

describe("opening the repository", { timeout: 60_000 }, () => {
	it("fails as unreadable, keeping the cause, when its directory sits under a file", async () => {
		const host = remote.host();
		await mkdir(remote.root, { recursive: true });
		await writeFile(host, "");
		const error = await RecordRepository.open(join(host, "records.git")).catch((caught: unknown) => caught);
		expect(error).toSatisfy(unreachable(/records\.git cannot be read$/));
		expect(((error as RecordError).cause as NodeJS.ErrnoException).code).toBe("ENOTDIR");
	});

	it("fails as not a directory when its path is a file", async () => {
		const host = remote.host();
		await mkdir(host, { recursive: true });
		await writeFile(join(host, "records.git"), "");
		await expect(RecordRepository.open(join(host, "records.git"))).rejects.toSatisfy(
			unreachable(/records\.git is not a directory$/),
		);
	});

	it("fails as unreadable, naming the file, when its configuration is gone", async () => {
		const repository = await opened();
		const config = join(repository.path, "config");
		await rm(config);
		await expect(repository.run(["rev-parse", "--git-dir"])).rejects.toMatchObject({
			code: "unreachable",
			path: config,
			message: `${config} cannot be read`,
		});
	});
});

describe("fetching the tip", { timeout: 60_000 }, () => {
	it("gives up at its deadline while another process holds the shallow file's lock", async () => {
		await (await remote.open()).add([check("a")]);
		const repository = await opened();
		await writeFile(join(repository.path, "shallow.lock"), "");
		const started = Date.now();
		await expect(repository.fetch(remote.url, remote.branch, 500)).rejects.toSatisfy(
			unreachable(/ran past its deadline$/),
		);
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("says it ran past its deadline when git is stopped at it", async () => {
		await (await remote.open()).add([check("a")]);
		const repository = await opened();
		await expect(repository.fetch(remote.url, remote.branch, 1)).rejects.toSatisfy(
			unreachable(/ran past its deadline$/),
		);
	});

	// Holds `packed-refs.lock` from the first ref deletion on, which fails only deletions, for `failures` of them.
	function holdRefLock(repository: RecordRepository, failures: number) {
		const run = RecordRepository.prototype.run;
		const lock = join(repository.path, "packed-refs.lock");
		let deletions = 0;
		vi.spyOn(RecordRepository.prototype, "run").mockImplementation(async function (this: RecordRepository, ...args) {
			if (args[0][0] !== "update-ref") return run.apply(this, args);
			if (deletions === 0) await writeFile(lock, "");
			const result = await run.apply(this, args);
			if (++deletions === failures) await rm(lock, { force: true });
			return result;
		});
	}

	it("retries deleting its ref while another process holds a lock for a moment, and leaves no ref", async () => {
		const { repository } = await fetched();
		holdRefLock(repository, 3);
		expect(await repository.fetch(remote.url, remote.branch, 30_000)).toBe(remote.tip());
		vi.restoreAllMocks();
		expect((await repository.run(["for-each-ref", "refs/melian"])).stdout).toBe("");
	});

	it("fails as unreachable once a lock outlasts its retries", async () => {
		const { repository } = await fetched();
		holdRefLock(repository, Number.POSITIVE_INFINITY);
		await expect(repository.fetch(remote.url, remote.branch, 30_000)).rejects.toSatisfy(
			unreachable(/^deleting refs\/melian\/fetch\/\S+ failed in /),
		);
	});
});

describe("reading objects", { timeout: 60_000 }, () => {
	it("fails as unreachable on a commit it does not hold", async () => {
		const { repository } = await fetched();
		await expect(repository.entries(absent)).rejects.toSatisfy(unreachable(/^listing /));
		await expect(repository.depth(absent)).rejects.toSatisfy(unreachable(/^git rev-list failed/));
		await expect(repository.isAncestor(absent, absent)).rejects.toSatisfy(unreachable(/^comparing /));
	});

	it("refuses an object that is missing or is no blob", async () => {
		const { repository, tip } = await fetched();
		await expect(repository.blobs([absent])).rejects.toSatisfy(unreachable(/is no blob/));
		const tree = (await repository.run(["rev-parse", `${tip}^{tree}`])).stdout.trim();
		await expect(repository.blobs([tree])).rejects.toSatisfy(unreachable(/is no blob/));
	});

	it("fails as unreachable when git cannot read the blobs", async () => {
		const { repository, tip } = await fetched();
		const [entry] = await repository.entries(tip);
		const run = RecordRepository.prototype.run;
		vi.spyOn(RecordRepository.prototype, "run").mockImplementation(async function (this: RecordRepository, ...args) {
			const result = await run.apply(this, args);
			return args[0][0] === "cat-file" && args[0][1] === "--batch" ? { ...result, code: 128 } : result;
		});
		await expect(repository.blobs([entry!.oid])).rejects.toSatisfy(unreachable(/^reading blobs failed/));
	});
});

describe("building a commit", { timeout: 60_000 }, () => {
	it("fails as unreachable on a parent it does not hold", async () => {
		const repository = await opened();
		await expect(repository.commit(absent, [])).rejects.toSatisfy(unreachable(/^git read-tree failed/));
	});

	it("leaves no index behind", async () => {
		const { repository, tip } = await fetched();
		await repository.commit(tip, [{ path: "changesets/x/cell.json", bytes: "{}" }]);
		expect((await readdir(repository.path)).filter((name) => name.startsWith("melian-index"))).toEqual([]);
	});

	it("is Melian's, by its author and committer", async () => {
		const { repository, tip } = await fetched();
		const commit = await repository.commit(tip, []);
		expect((await repository.run(["log", "-1", "--format=%an <%ae>|%cn <%ce>", commit])).stdout.trim()).toBe(
			"Melian <melian@invalid>|Melian <melian@invalid>",
		);
	});
});

describe("pushing", { timeout: 60_000 }, () => {
	it("answers timedOut when git is stopped at its deadline", async () => {
		const { repository, tip } = await fetched();
		const commit = await repository.commit(tip, []);
		expect(await repository.push(remote.url, remote.branch, commit, tip, 1)).toBe("timedOut");
	});

	it("fails as unreachable, with git's own words trimmed, when the remote is not there", async () => {
		const { repository, tip } = await fetched();
		const error = await repository
			.push(`file://${join(remote.root, "absent.git")}`, remote.branch, tip, tip, 30_000)
			.catch((caught: unknown) => caught);
		expect(error).toSatisfy(unreachable(/^pushing to melian\/state at file:\S+ failed: \S/));
		expect((error as RecordError).message).not.toMatch(/\s$/);
	});

	it("fails as unreachable, quoting the refusal, when the remote refuses for another reason than a race", async () => {
		const { repository, tip } = await fetched();
		const run = RecordRepository.prototype.run;
		vi.spyOn(RecordRepository.prototype, "run").mockImplementation(async function (this: RecordRepository, ...args) {
			if (args[0][0] !== "push") return run.apply(this, args);
			return {
				code: 1,
				stdout: `To ${remote.url}\n!\t${tip}:refs/heads/melian/state\t[remote rejected] (pre-receive hook declined)\nDone\n`,
				stdoutBytes: Buffer.from(""),
				stderr: "error: failed to push some refs\n",
			};
		});
		await expect(repository.push(remote.url, remote.branch, tip, tip, 30_000)).rejects.toMatchObject({
			code: "unreachable",
			message: `pushing to melian/state at ${remote.url} failed: [remote rejected] (pre-receive hook declined)\nerror: failed to push some refs`,
		});
	});
});

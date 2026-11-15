import { access, chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { RecordError } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deadline, systemClock } from "../src/deadline.ts";
import { RecordRepository } from "../src/repository.ts";
import { listingLimit } from "../src/state-tree.ts";
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

function within(ms: number): Deadline {
	return Deadline.after(systemClock, ms);
}

const time = () => within(30_000);

// A deadline whose clock stands still, so it has 1 ms left when git starts and core's git stops it at that millisecond.
const oneMillisecond = () => Deadline.after({ now: () => 0, sleep: async () => {} }, 1);

async function opened(): Promise<RecordRepository> {
	return RecordRepository.open(join(remote.host(), "records.git"), time());
}

// A repository holding the branch's tip, fetched, with the branch holding one record.
async function fetched(): Promise<{ repository: RecordRepository; tip: string }> {
	await (await remote.open()).add([check("a")]);
	const repository = await opened();
	const tip = (await repository.fetch(remote.url, remote.branch, time())) as string;
	return { repository, tip };
}

// A program that leaves a file when it runs, for a remote spelled as an option that would make git run it.
async function marker(): Promise<{ program: string; ran: () => Promise<boolean> }> {
	await mkdir(remote.root, { recursive: true });
	const program = join(remote.root, "marker.sh");
	const ran = join(remote.root, "ran");
	await writeFile(program, `#!/bin/sh\ntouch '${ran}'\nexit 1\n`);
	await chmod(program, 0o755);
	return {
		program,
		ran: () =>
			access(ran).then(
				() => true,
				() => false,
			),
	};
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
		const error = await RecordRepository.open(join(host, "records.git"), time()).catch((caught: unknown) => caught);
		expect(error).toSatisfy(unreachable(/records\.git cannot be read$/));
		expect(((error as RecordError).cause as NodeJS.ErrnoException).code).toBe("ENOTDIR");
	});

	it("fetches through a path relative to the process's directory, as it does through an absolute one", async () => {
		await (await remote.open()).add([check("a")]);
		const repository = await RecordRepository.open(
			relative(process.cwd(), join(remote.host(), "records.git")),
			time(),
		);
		expect(await repository.fetch(remote.url, remote.branch, time())).toBe(remote.tip());
	});

	it("fails as not a directory when its path is a file", async () => {
		const host = remote.host();
		await mkdir(host, { recursive: true });
		await writeFile(join(host, "records.git"), "");
		await expect(RecordRepository.open(join(host, "records.git"), time())).rejects.toSatisfy(
			unreachable(/records\.git is not a directory$/),
		);
	});

	it("refuses a repository an earlier build fetched one commit deep, and opens one that holds the whole history", async () => {
		const store = await remote.open();
		await store.add([check("a")]);
		await store.add([check("b")]);
		const whole = await opened();
		await whole.fetch(remote.url, remote.branch, time());
		await expect(RecordRepository.open(whole.path, time())).resolves.toBeInstanceOf(RecordRepository);
		const shallow = await opened();
		remote.git([
			"--git-dir",
			shallow.path,
			"fetch",
			"--quiet",
			"--depth=1",
			remote.url,
			`+refs/heads/${remote.branch}:refs/old`,
		]);
		await expect(RecordRepository.open(shallow.path, time())).rejects.toSatisfy(
			unreachable(
				/records\.git holds a shallow history an earlier Melian fetched; delete it, and the next call fetches the whole branch$/,
			),
		);
	});

	it("fails as unreadable, naming the file, when its configuration is gone", async () => {
		const repository = await opened();
		const config = join(repository.path, "config");
		await rm(config);
		await expect(repository.run(["rev-parse", "--git-dir"], time())).rejects.toMatchObject({
			code: "unreachable",
			path: config,
			message: `${config} cannot be read`,
		});
	});
});

describe("fetching the tip", { timeout: 60_000 }, () => {
	it("runs no program a remote spelled as an option names, and fails as unreachable", async () => {
		const { program, ran } = await marker();
		const repository = await opened();
		await expect(repository.fetch(`--upload-pack=${program}`, remote.branch, time())).rejects.toSatisfy(
			unreachable(/^fetching melian\/state from --upload-pack=\S+ failed: \S/),
		);
		expect(await ran()).toBe(false);
	});

	it("says it ran past its deadline when git is stopped at it", async () => {
		await (await remote.open()).add([check("a")]);
		const repository = await opened();
		await expect(repository.fetch(remote.url, remote.branch, oneMillisecond())).rejects.toSatisfy(
			unreachable(/ran past its deadline$/),
		);
	});

	// Holds `packed-refs.lock` from the first ref deletion on, which fails only deletions, for `failures` of them.
	function holdRefLock(repository: RecordRepository, failures: number) {
		const run = RecordRepository.prototype.run;
		const lock = join(repository.path, "packed-refs.lock");
		let deletions = 0;
		vi.spyOn(RecordRepository.prototype, "run").mockImplementation(async function (this: RecordRepository, ...args) {
			if (args[0][0] !== "update-ref" || args[0][1] !== "-d") return run.apply(this, args);
			if (deletions === 0) await writeFile(lock, "");
			const result = await run.apply(this, args);
			if (++deletions === failures) await rm(lock, { force: true });
			return result;
		});
	}

	it("retries deleting its ref while another process holds a lock for a moment, and leaves no ref", async () => {
		const { repository } = await fetched();
		holdRefLock(repository, 3);
		expect(await repository.fetch(remote.url, remote.branch, time())).toBe(remote.tip());
		vi.restoreAllMocks();
		expect((await repository.run(["for-each-ref", "refs/melian/fetch"], time())).stdout).toBe("");
	});

	// Answers `answer` in place of the first git command `matches` picks, and runs every other command as it is.
	function failFirst(matches: (args: readonly string[]) => boolean, answer: () => never | Promise<never>) {
		const run = RecordRepository.prototype.run;
		let failed = false;
		vi.spyOn(RecordRepository.prototype, "run").mockImplementation(async function (this: RecordRepository, ...args) {
			if (failed || !matches(args[0])) return run.apply(this, args);
			failed = true;
			return answer();
		});
	}

	const fetchRefs = async (repository: RecordRepository) =>
		(await repository.run(["for-each-ref", "refs/melian/fetch"], time())).stdout;

	it("deletes its ref when reading the fetched tip fails", async () => {
		const { repository } = await fetched();
		failFirst(
			(args) => args[0] === "rev-parse",
			() => {
				throw new RecordError("unreachable", "rev-parse ran past its deadline");
			},
		);
		await expect(repository.fetch(remote.url, remote.branch, time())).rejects.toThrow(
			"rev-parse ran past its deadline",
		);
		vi.restoreAllMocks();
		expect(await fetchRefs(repository)).toBe("");
	});

	it("reports the read's failure, not the deletion's, when it cannot delete its ref either", async () => {
		const { repository } = await fetched();
		const run = RecordRepository.prototype.run;
		vi.spyOn(RecordRepository.prototype, "run").mockImplementation(async function (this: RecordRepository, ...args) {
			if (args[0][0] === "rev-parse") throw new RecordError("unreachable", "rev-parse ran past its deadline");
			if (args[0][0] === "update-ref" && args[0][1] === "-d")
				throw new RecordError("unreachable", "deleting ran past its deadline");
			return run.apply(this, args);
		});
		await expect(repository.fetch(remote.url, remote.branch, time())).rejects.toThrow(
			"rev-parse ran past its deadline",
		);
	});

	it("deletes its ref before it points the hint at the tip, so a hint that runs out of time leaves no ref", async () => {
		const { repository } = await fetched();
		failFirst(
			(args) => args[0] === "update-ref" && args[1] === "refs/melian/last",
			() => {
				throw new RecordError("unreachable", "the hint ran past its deadline");
			},
		);
		await expect(repository.fetch(remote.url, remote.branch, time())).rejects.toThrow(
			"the hint ran past its deadline",
		);
		vi.restoreAllMocks();
		expect(await fetchRefs(repository)).toBe("");
	});

	it("fails as unreachable once a lock outlasts its retries", async () => {
		const { repository } = await fetched();
		holdRefLock(repository, Number.POSITIVE_INFINITY);
		await expect(repository.fetch(remote.url, remote.branch, time())).rejects.toSatisfy(
			unreachable(/^deleting refs\/melian\/fetch\/\S+ failed in /),
		);
	});
});

describe("naming the remote", { timeout: 60_000 }, () => {
	const named = /https:\/\/127\.0\.0\.1:9\/x\.git/;
	const hidden = /melian:|FAKESECRET/;

	it("names a remote whose fetch failed without its user and password", async () => {
		const repository = await opened();
		const error = await repository
			.fetch("https://melian:FAKESECRET@127.0.0.1:9/x.git", remote.branch, time())
			.catch((caught: unknown) => caught);
		expect(error).toSatisfy(unreachable(new RegExp(`^fetching melian/state from ${named.source} failed: `)));
		expect((error as RecordError).message).not.toMatch(hidden);
	});

	it("names a remote whose fetch ran past its deadline without its user and password", async () => {
		const repository = await opened();
		const error = await repository
			.fetch("https://melian:FAKESECRET@127.0.0.1:9/x.git", remote.branch, oneMillisecond())
			.catch((caught: unknown) => caught);
		expect(error).toSatisfy(
			unreachable(new RegExp(`^fetching melian/state from ${named.source} ran past its deadline$`)),
		);
	});

	it("names a remote whose push failed without its user and password", async () => {
		const { repository, tip } = await fetched();
		const error = await repository
			.push("https://melian:FAKESECRET@127.0.0.1:9/x.git", remote.branch, tip, tip, time())
			.catch((caught: unknown) => caught);
		expect(error).toSatisfy(
			unreachable(
				new RegExp(`^pushing to melian/state at ${named.source} failed, and may have landed; repeat the call: `),
			),
		);
		expect((error as RecordError).message).not.toMatch(hidden);
	});

	it("names a remote that carries a password alone without it", async () => {
		const repository = await opened();
		const error = await repository
			.fetch("https://:FAKESECRET@127.0.0.1:9/x.git", remote.branch, time())
			.catch((caught: unknown) => caught);
		expect(error).toSatisfy(unreachable(new RegExp(`^fetching melian/state from ${named.source} failed: `)));
		expect((error as RecordError).message).not.toMatch(hidden);
	});

	it("names a remote with no user or password exactly as it was given", async () => {
		const repository = await opened();
		await expect(repository.fetch("HTTPS://127.0.0.1:9/x.git", remote.branch, time())).rejects.toSatisfy(
			unreachable(/^fetching melian\/state from HTTPS:\/\/127\.0\.0\.1:9\/x\.git failed: /),
		);
	});

	it("names a remote that carries a token as its user alone without it", async () => {
		const repository = await opened();
		const error = await repository
			.fetch("https://FAKESECRET@127.0.0.1:9/x.git", remote.branch, time())
			.catch((caught: unknown) => caught);
		expect(error).toSatisfy(unreachable(new RegExp(`^fetching melian/state from ${named.source} failed: `)));
		expect((error as RecordError).message).not.toMatch(hidden);
	});
});

describe("reading objects", { timeout: 60_000 }, () => {
	it("fails as unreachable on a commit it does not hold", async () => {
		const { repository } = await fetched();
		await expect(repository.entries(absent, time(), listingLimit)).rejects.toSatisfy(unreachable(/^listing /));
		await expect(repository.isAncestor(absent, absent, time())).rejects.toSatisfy(unreachable(/^comparing /));
	});

	it("refuses an object that is missing or is no blob", async () => {
		const { repository, tip } = await fetched();
		await expect(repository.blobs(new Map([[absent, 0]]), time())).rejects.toSatisfy(unreachable(/is no blob/));
		const tree = (await repository.run(["rev-parse", `${tip}^{tree}`], time())).stdout.trim();
		await expect(repository.blobs(await repository.sizes([tree], time()), time())).rejects.toSatisfy(
			unreachable(/is no blob/),
		);
	});

	it("fails as unreachable when git cannot read the blobs", async () => {
		const { repository, tip } = await fetched();
		const [entry] = (await repository.entries(tip, time(), listingLimit))!;
		const run = RecordRepository.prototype.run;
		vi.spyOn(RecordRepository.prototype, "run").mockImplementation(async function (this: RecordRepository, ...args) {
			const result = await run.apply(this, args);
			return args[0][0] === "cat-file" && args[0][1] === "--batch" ? { ...result, code: 128 } : result;
		});
		await expect(repository.blobs(await repository.sizes([entry!.oid], time()), time())).rejects.toSatisfy(
			unreachable(/^reading blobs failed/),
		);
	});
});

describe("building a commit", { timeout: 60_000 }, () => {
	it("fails as unreachable on a parent it does not hold", async () => {
		const repository = await opened();
		await expect(repository.commit(absent, [], time())).rejects.toSatisfy(unreachable(/^git read-tree failed/));
	});

	it("leaves no index behind", async () => {
		const { repository, tip } = await fetched();
		await repository.commit(tip, [{ path: "changesets/x/cell.json", bytes: "{}" }], time());
		expect((await readdir(repository.path)).filter((name) => name.startsWith("melian-index"))).toEqual([]);
	});

	it("is Melian's, by its author and committer", async () => {
		const { repository, tip } = await fetched();
		const commit = await repository.commit(tip, [], time());
		expect((await repository.run(["log", "-1", "--format=%an <%ae>|%cn <%ce>", commit], time())).stdout.trim()).toBe(
			"Melian <melian@invalid>|Melian <melian@invalid>",
		);
	});
});

describe("pushing", { timeout: 60_000 }, () => {
	it("answers timedOut when git is stopped at its deadline", async () => {
		const { repository, tip } = await fetched();
		const commit = await repository.commit(tip, [], time());
		expect(await repository.push(remote.url, remote.branch, commit, tip, oneMillisecond())).toBe("timedOut");
	});

	it("runs no program a remote spelled as an option names, and fails as unreachable", async () => {
		const { repository, tip } = await fetched();
		const commit = await repository.commit(tip, [], time());
		const { program, ran } = await marker();
		await expect(repository.push(`--receive-pack=${program}`, remote.branch, commit, tip, time())).rejects.toSatisfy(
			unreachable(
				/^pushing to melian\/state at --receive-pack=\S+ failed, and may have landed; repeat the call: \S/,
			),
		);
		expect(await ran()).toBe(false);
	});

	it("fails as unreachable, with git's own words trimmed, when the remote is not there", async () => {
		const { repository, tip } = await fetched();
		const error = await repository
			.push(`file://${join(remote.root, "absent.git")}`, remote.branch, tip, tip, time())
			.catch((caught: unknown) => caught);
		expect(error).toSatisfy(
			unreachable(/^pushing to melian\/state at file:\S+ failed, and may have landed; repeat the call: \S/),
		);
		expect((error as RecordError).message).not.toMatch(/\s$/);
	});

	for (const race of [
		"[rejected] (stale info)",
		"[rejected] (fetch first)",
		"[rejected] (non-fast-forward)",
		"[rejected] (already exists)",
		"[remote rejected] (failed to update ref)",
		"[remote rejected] (cannot lock ref 'refs/heads/melian/state': is at 0123 but expected 4567)",
		"[remote rejected] (incorrect old value provided)",
		"[remote rejected] (reference already exists)",
	])
		it(`answers stale for a race the push reports as ${race}`, async () => {
			const { repository, tip } = await fetched();
			const run = RecordRepository.prototype.run;
			vi.spyOn(RecordRepository.prototype, "run").mockImplementation(async function (
				this: RecordRepository,
				...args
			) {
				if (args[0][0] !== "push") return run.apply(this, args);
				return {
					code: 1,
					stdout: `To ${remote.url}\n!\t${tip}:refs/heads/melian/state\t${race}\nDone\n`,
					stdoutBytes: Buffer.from(""),
					stderr: "error: failed to push some refs\n",
				};
			});
			expect(await repository.push(remote.url, remote.branch, tip, tip, time())).toBe("stale");
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
		await expect(repository.push(remote.url, remote.branch, tip, tip, time())).rejects.toMatchObject({
			code: "unreachable",
			message: `pushing to melian/state at ${remote.url} failed: [remote rejected] (pre-receive hook declined)\nerror: failed to push some refs`,
		});
	});

	it("fails as unreachable, saying it may have landed, when git reports no refusal of the ref", async () => {
		const { repository, tip } = await fetched();
		const run = RecordRepository.prototype.run;
		vi.spyOn(RecordRepository.prototype, "run").mockImplementation(async function (this: RecordRepository, ...args) {
			if (args[0][0] !== "push") return run.apply(this, args);
			return {
				code: 128,
				stdout: "",
				stdoutBytes: Buffer.from(""),
				stderr: "fatal: the remote end hung up unexpectedly\n",
			};
		});
		await expect(repository.push(remote.url, remote.branch, tip, tip, time())).rejects.toMatchObject({
			code: "unreachable",
			message: `pushing to melian/state at ${remote.url} failed, and may have landed; repeat the call: fatal: the remote end hung up unexpectedly`,
		});
	});
});

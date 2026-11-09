import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as core from "@melian-agent/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { changeset, note, notes, Remote, storageOf } from "./fixtures/state.ts";

// Every test here runs git against real repositories, which takes seconds on a loaded host.
vi.setConfig({ testTimeout: 60_000 });

// Another run's push lands between this run's fetch and its push, as many times as `moves` says.
let moves = 0;
const environments: {
	command: string;
	env: Readonly<Record<string, string>> | undefined;
	deadlineMs: number | undefined;
}[] = [];
// Answers the next push as git does when it ran past its deadline.
let stalled = false;
// Lands the next push, then answers as git does when it ran past its deadline: the transport finished after git stopped.
let landedLate = false;
// Fails the next fetch, as an unreachable remote does.
let unreachable = false;
let unreachableAfter = false;
let interloper: (() => Promise<void>) | undefined;
// Answers the next push with the remote's lock error, worded as a newer git words it, as when another push created the
// branch at the same moment.
let locked = 0;
// Answers the next push as git does when the remote refuses the credential: no porcelain line at all.
let denied = false;
// Answers the next hash-object as git does when the object database cannot be written.
let unwritable = false;

vi.mock("@melian-agent/core", async (original) => {
	const actual = await original<typeof core>();
	return {
		...actual,
		git: async (cwd: string, args: readonly string[], options?: core.GitOptions) => {
			environments.push({ command: args[0]!, env: options?.env, deadlineMs: options?.deadlineMs });
			if (args[0] === "fetch" && unreachable) {
				unreachable = false;
				return {
					code: 128,
					stdout: "",
					stdoutBytes: Buffer.from(""),
					stderr: "fatal: unable to access 'remote'\n",
				};
			}
			if (args[0] === "push" && landedLate) {
				landedLate = false;
				await actual.git(cwd, args, options);
				return { code: -1, stdout: "", stdoutBytes: Buffer.from(""), stderr: "", timedOut: true };
			}
			if (args[0] === "push" && stalled) {
				stalled = false;
				unreachable = unreachableAfter;
				return { code: -1, stdout: "", stdoutBytes: Buffer.from(""), stderr: "", timedOut: true };
			}
			if (args[0] === "hash-object" && unwritable) {
				unwritable = false;
				return {
					code: 128,
					stdout: "",
					stdoutBytes: Buffer.from(""),
					stderr: "error: insufficient permission for adding an object to repository database .git/objects\n",
				};
			}
			if (args[0] === "push" && denied) {
				denied = false;
				return {
					code: 128,
					stdout: "",
					stdoutBytes: Buffer.from(""),
					stderr:
						"remote: Permission to melian-agent/melian.git denied to reader.\nfatal: unable to access 'remote': The requested URL returned error: 403\n",
				};
			}
			if (args[0] === "push" && locked > 0) {
				locked--;
				const refspec = args.find((arg) => arg.endsWith(":refs/heads/melian/state"))!;
				const reason = "cannot lock ref 'refs/heads/melian/state': reference already exists";
				return {
					code: 1,
					stdout: `To remote\n!\t${refspec}\t[remote rejected] (${reason})\nDone\n`,
					stdoutBytes: Buffer.from(""),
					stderr: `remote: error: ${reason}\nerror: failed to push some refs to 'remote'\n`,
				};
			}
			if (args[0] === "push" && moves > 0 && interloper !== undefined) {
				moves--;
				const run = interloper;
				interloper = undefined;
				await run();
				interloper = run;
			}
			return actual.git(cwd, args, options);
		},
	};
});

let remote: Remote;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	remote = new Remote();
	let count = 0;
	const other = remote.clone();
	interloper = async () => {
		const checkout = await other.branch().checkout(`pull-${String(++count).padStart(16, "0")}`);
		await note(await storageOf(checkout), "theirs");
		await checkout.push();
	};
});

afterEach(() => {
	vi.unstubAllEnvs();
	moves = 0;
	locked = 0;
	denied = false;
	unwritable = false;
	stalled = false;
	landedLate = false;
	unreachable = false;
	unreachableAfter = false;
	interloper = undefined;
	remote.close();
});

it("pushes again when the remote could not lock the branch, however the rejection is worded", async () => {
	const checkout = await remote.clone().branch().checkout(changeset);
	await note(await storageOf(checkout), "mine");
	locked = 1;
	expect(await checkout.push()).toEqual({ kind: "pushed", commit: remote.tip() });
	expect(await notes(await storageOf(await remote.clone().branch().checkout(changeset)))).toEqual(["mine"]);
});

it("pushes again from a fresh fetch when another changeset's push lands first", async () => {
	const checkout = await remote.clone().branch().checkout(changeset);
	await note(await storageOf(checkout), "mine");
	moves = 1;
	expect(await checkout.push()).toEqual({ kind: "pushed", commit: remote.tip() });
	expect(remote.stored("pull-0000000000000001")).toMatch(/^[0-9a-f]{40}$/);
	expect(await notes(await storageOf(await remote.clone().branch().checkout(changeset)))).toEqual(["mine"]);
});

it("takes the lease when the branch moves under two pushes in a row", async () => {
	moves = 2;
	await remote.clone().branch().checkout(changeset);
	expect((remote.index() as { changesets: Record<string, unknown> }).changesets[changeset]).toBeDefined();
});

it("pushes on the tenth attempt when the branch moves under nine pushes in a row", async () => {
	moves = 9;
	const checkout = await remote.clone().branch().checkout(changeset);
	await note(await storageOf(checkout), "mine");
	expect(await checkout.push()).toEqual({ kind: "pushed", commit: remote.tip() });
});

it("waits a random time below a bound that doubles to a second between lost races", async () => {
	moves = 9;
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const delays: number[] = [];
	const wait = globalThis.setTimeout;
	// Only the waits between attempts, which are at most a second; git's deadline keeps its own timer.
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) => {
		if ((ms ?? 0) > 1000) return wait(callback, ms);
		delays.push(ms ?? 0);
		return wait(callback, 0);
	}) as typeof setTimeout);
	await remote.clone().branch().checkout(changeset);
	vi.restoreAllMocks();
	expect(delays).toEqual([50, 100, 200, 400, 500, 500, 500, 500, 500]);
});

it("gives up when the branch moves under ten pushes in a row", async () => {
	moves = 10;
	await expect(remote.clone().branch().checkout(changeset)).rejects.toMatchObject({
		code: "pushFailed",
		message: "the state branch moved under 10 pushes in a row",
	});
});

it("names a lock the remote never grants, rather than a moving branch", async () => {
	locked = 10;
	await expect(remote.clone().branch().checkout(changeset)).rejects.toMatchObject({
		code: "pushFailed",
		message: "the remote could not lock melian/state under 10 pushes in a row",
	});
});

it("does not retry a push the remote refused for another reason", async () => {
	const hook = join(remote.bare, "hooks", "pre-receive");
	writeFileSync(hook, "#!/bin/sh\necho 'state branch is protected' >&2\nexit 1\n");
	chmodSync(hook, 0o755);
	const error = await remote
		.clone()
		.branch()
		.checkout(changeset)
		.catch((caught: unknown) => caught);
	expect(error).toMatchObject({
		code: "pushFailed",
		message: expect.stringMatching(/^git push of melian\/state failed: [\s\S]*state branch is protected/),
	});
});

it("never lets a fetch or push wait on a credential prompt", async () => {
	environments.length = 0;
	await (await remote.clone().branch().checkout(changeset)).push();
	const network = environments.filter(({ command }) => command === "fetch" || command === "push");
	expect(network.length).toBeGreaterThanOrEqual(4);
	for (const { env } of network) expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: "0" });
});

it("has git abort a fetch or push that stalls for a minute", async () => {
	environments.length = 0;
	await (await remote.clone().branch().checkout(changeset)).push();
	const network = environments.filter(({ command }) => command === "fetch" || command === "push");
	expect(network.length).toBeGreaterThanOrEqual(4);
	for (const { env } of network) {
		const read = (key: string) =>
			execFileSync("git", ["config", "--get", key], { env: { ...process.env, ...env }, encoding: "utf8" }).trim();
		expect([read("http.lowSpeedLimit"), read("http.lowSpeedTime")]).toEqual(["1", "60"]);
	}
});

it("reads git's fetch and push output in the C locale, which git does not translate", async () => {
	environments.length = 0;
	await (await remote.clone().branch().checkout(changeset)).push();
	const classified = environments.filter(({ command }) => command === "fetch" || command === "push");
	expect(classified.length).toBeGreaterThanOrEqual(4);
	for (const { env } of classified) expect(env).toMatchObject({ LC_ALL: "C", LANGUAGE: "C" });
});

it("names a push the remote refused with no porcelain line, as a refused credential gives", async () => {
	denied = true;
	await expect(remote.clone().branch().checkout(changeset)).rejects.toMatchObject({
		code: "pushFailed",
		message:
			"git push of melian/state failed: remote: Permission to melian-agent/melian.git denied to reader.\nfatal: unable to access 'remote': The requested URL returned error: 403",
	});
});

it("fails a push whose objects cannot be written, rather than push a tree that names them", async () => {
	const checkout = await remote.clone().branch().checkout(changeset);
	await note(await storageOf(checkout), "mine");
	const tip = remote.tip();
	unwritable = true;
	await expect(checkout.push()).rejects.toMatchObject({
		code: "gitFailed",
		message:
			"git hash-object failed: error: insufficient permission for adding an object to repository database .git/objects",
	});
	expect(remote.tip()).toBe(tip);
});

it("gives every fetch and push a deadline of two minutes by default", async () => {
	environments.length = 0;
	await (await remote.clone().branch().checkout(changeset)).push();
	const network = environments.filter(({ command }) => command === "fetch" || command === "push");
	expect(network.length).toBeGreaterThanOrEqual(4);
	expect(new Set(network.map(({ deadlineMs }) => deadlineMs))).toEqual(new Set([120_000]));
});

it("names a push that ran past its deadline", async () => {
	stalled = true;
	await expect(remote.clone().branch({ transferMs: 900 }).checkout(changeset)).rejects.toMatchObject({
		code: "pushFailed",
		message: "git push of melian/state ran past its deadline of 900 ms",
	});
});

it("counts a push its deadline stopped as landed when the branch's tip is the commit it sent", async () => {
	const checkout = await remote.clone().branch().checkout(changeset);
	await note(await storageOf(checkout), "mine");
	landedLate = true;
	expect(await checkout.push()).toEqual({ kind: "pushed", commit: remote.tip() });
	expect(await notes(await storageOf(await remote.clone().branch().checkout(changeset)))).toEqual(["mine"]);
});

it("names a push its deadline stopped when the branch cannot be read again to see whether it landed", async () => {
	stalled = true;
	unreachableAfter = true;
	await expect(remote.clone().branch({ transferMs: 900 }).checkout(changeset)).rejects.toMatchObject({
		code: "pushFailed",
		message: "git push of melian/state ran past its deadline of 900 ms",
	});
});

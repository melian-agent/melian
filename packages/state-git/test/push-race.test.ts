import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as core from "@melian-agent/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { changeset, note, notes, Remote, storageOf } from "./fixtures/state.ts";

// Another run's push lands between this run's fetch and its push, as many times as `moves` says.
let moves = 0;
const environments: { command: string; env: Readonly<Record<string, string>> | undefined }[] = [];
let interloper: (() => Promise<void>) | undefined;

vi.mock("@melian-agent/core", async (original) => {
	const actual = await original<typeof core>();
	return {
		...actual,
		git: async (cwd: string, args: readonly string[], options?: core.GitOptions) => {
			environments.push({ command: args[0]!, env: options?.env });
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
	interloper = undefined;
	remote.close();
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

it("gives up when the branch moves under three pushes in a row", async () => {
	moves = 3;
	await expect(remote.clone().branch().checkout(changeset)).rejects.toMatchObject({
		code: "pushFailed",
		message: "the state branch moved under 3 pushes in a row",
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

it("reads git's fetch and push output in the C locale, which git does not translate", async () => {
	environments.length = 0;
	await (await remote.clone().branch().checkout(changeset)).push();
	const classified = environments.filter(({ command }) => command === "fetch" || command === "push");
	expect(classified.length).toBeGreaterThanOrEqual(4);
	for (const { env } of classified) expect(env).toMatchObject({ LC_ALL: "C", LANGUAGE: "C" });
});

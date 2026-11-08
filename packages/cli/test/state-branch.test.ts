import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Changeset, pullRequestChangesetId, Revision } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	DismissHarness,
	defineDoc,
	openJsonlStorage,
	openSqliteStorage,
	publishReview,
	readVerdict,
	recordDismissal,
} from "@melian-agent/pipeline";
import { createSession } from "@melian-agent/pipeline/testing";
import { StateCheckout } from "@melian-agent/state-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import {
	emptyName,
	gitIn,
	isolatedGitEnv,
	lensScript,
	moveTo,
	openPublishHarness,
	pullRequestState,
	reviewScenario,
	scenarioModels,
	scenarioRepository,
	unsafeManager,
} from "../../github/test/fixtures/scenario.ts";
import { LedgerDocument, PublisherDocument } from "../../pipeline/src/publish.ts";
import type { Io } from "../src/commands.ts";
import * as repository from "../src/repository.ts";
import { ChangesetStore } from "../src/state.ts";

const pullRequest = pullRequestChangesetId("github", { owner: "melian-agent", name: "example" }, 7);
const keyVariable = "MELIAN_STATE_TEST_KEY";
const cleanups: string[] = [];

let origin: string;
let first: string;
let config: string;
let key: string;
let stderr: string[];

function io(cwd: string, env: Record<string, string> = {}): Io {
	return {
		cwd,
		env: { ...process.env, XDG_CONFIG_HOME: config, [keyVariable]: key, ...env },
		color: false,
		stdout: () => {},
		stderr: (text) => {
			stderr.push(text);
		},
	};
}

// A second clone of the origin, as a fresh machine or an Actions job has.
function clone(): string {
	const path = `${first}-clone-${cleanups.length}`;
	gitIn(first, "clone", "--quiet", origin, path);
	cleanups.push(path);
	return path;
}

beforeEach(() => {
	for (const [name, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(name, value);
	vi.stubEnv("MELIAN_STATE_DIR", undefined);
	first = scenarioRepository();
	origin = `${first}-origin.git`;
	gitIn(first, "clone", "--quiet", "--bare", first, origin);
	gitIn(first, "remote", "add", "origin", origin);
	config = `${first}-config`;
	mkdirSync(join(config, "melian"), { recursive: true, mode: 0o700 });
	const secrets = join(config, "melian", "secrets.yaml");
	writeFileSync(secrets, `credentials:\n  state:\n    provider: melian-state\n    env: ${keyVariable}\n`);
	chmodSync(secrets, 0o600);
	key = randomBytes(32).toString("hex");
	stderr = [];
	cleanups.push(first, origin, config);
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("a pull request's storage on the state branch", () => {
	it("keeps the marker secret, the ledger comment and every dismissal for a fresh clone", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "t",
			fetch: fakeGitHub(state),
		});

		const reviewing = await ChangesetStore.write(io(first), first, pullRequest);
		const harness = await openPublishHarness(reviewing.storage, fake, provider);
		let changeset: Changeset;
		let secret: string | undefined;
		let ledger: string | undefined;
		try {
			const reviewed = await reviewScenario(first, harness, fake, lensScript(unsafeManager, emptyName));
			await reviewed.review;
			changeset = reviewed.changeset;
			moveTo(state, changeset);
			await publishReview({
				trustedWriters: true,
				harness,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
				walkthrough: { enabled: false, collapsed: true, diagrams: true },
			});
			const root = (await harness.root(context)).id;
			secret = (await harness.snapshot(PublisherDocument, root, context))?.secret;
			ledger = (await harness.snapshot(LedgerDocument, root, context))?.comment?.id;
		} finally {
			await harness.close(context);
			await reviewing.close();
		}
		expect(secret).toMatch(/^[0-9a-f]{64}$/);
		expect(ledger).toBe(String(state.ledgers[0]!.id));

		const dismissing = await ChangesetStore.write(io(first), first, pullRequest);
		const dismissHarness = await DismissHarness.open(dismissing.storage, fake.review);
		try {
			const verdict = await readVerdict(
				dismissHarness.harness,
				(await dismissHarness.harness.root(context)).id,
				Revision.key(changeset.revision),
				context,
			);
			const id = Object.values(verdict!.findings).flat()[0]!.properties.id;
			await recordDismissal({
				harness: dismissHarness.harness,
				revision: changeset.revision,
				id,
				dismissal: { by: "Maintainer <m@example.invalid>", reason: "Checked by hand.", at: "2026-11-07T00:00:00Z" },
				only: false,
				repoRoot: first,
			});
		} finally {
			await dismissHarness.close(context);
			await dismissing.close();
		}

		const fresh = clone();
		const restored = await ChangesetStore.write(io(fresh), fresh, pullRequest);
		const restoredHarness = await DismissHarness.open(restored.storage, fake.review);
		try {
			const root = (await restoredHarness.harness.root(context)).id;
			expect((await restoredHarness.harness.snapshot(PublisherDocument, root, context))?.secret).toBe(secret);
			expect((await restoredHarness.harness.snapshot(LedgerDocument, root, context))?.comment?.id).toBe(ledger);
			const verdict = await readVerdict(restoredHarness.harness, root, Revision.key(changeset.revision), context);
			expect(verdict!.dismissals().map(({ dismissal }) => dismissal?.reason)).toEqual(["Checked by hand."]);
		} finally {
			await restoredHarness.close(context);
			await restored.close();
		}
		expect(stderr).toEqual([]);
	});
});

// Writes a note into the store's root conversation, as a review's commits do, and reads them back.
async function writeNote(store: ChangesetStore, text: string): Promise<void> {
	const session = createSession(store.storage);
	await session.commit(async (tx) => {
		(await tx.doc(noteDoc)).notes.push(text);
	}, context);
	await session.close(context);
}

async function readNotes(store: ChangesetStore): Promise<readonly string[]> {
	const session = createSession(store.storage);
	try {
		return (await session.snapshot(noteDoc, context))?.notes ?? [];
	} finally {
		await session.close(context);
	}
}

const noteDoc = defineDoc({
	kind: "test.note",
	version: 1,
	scope: "session",
	initial: (): { notes: string[] } => ({ notes: [] }),
});

const branchTip = () => gitIn(origin, "rev-parse", "--verify", "--quiet", "refs/heads/melian/state");

describe("ChangesetStore", () => {
	it("restores the branch's copy over one whose document sidecar was deleted since it synced", async () => {
		const store = await ChangesetStore.write(io(first), first, pullRequest);
		await writeNote(store, "stored");
		await store.storage.close(context);
		await store.close();
		const copy = join(
			gitIn(first, "rev-parse", "--path-format=absolute", "--git-common-dir"),
			"melian",
			"state",
			pullRequest,
		);
		rmSync(join(copy, readdirSync(copy).find((name) => name.startsWith("doc-"))!));
		const again = await ChangesetStore.write(io(first), first, pullRequest);
		expect(await readNotes(again)).toEqual(["stored"]);
		await again.storage.close(context);
		await again.close();
		expect(stderr).toEqual([expect.stringMatching(/its copy is set aside at .*\.set-aside-\d+/)]);
	});

	it("refuses a pull request another clone holds, naming the run", async () => {
		const held = await ChangesetStore.write(io(first), first, pullRequest);
		const other = clone();
		await expect(ChangesetStore.write(io(other), other, pullRequest)).rejects.toMatchObject({
			name: "CliError",
			message: expect.stringMatching(/^another run holds pull-[0-9a-f]{16} on the state branch: run /),
		});
		await held.storage.close(context);
		await held.close();
	});

	it("refuses a second command in this clone while the first holds the copy", async () => {
		const held = await ChangesetStore.write(io(first), first, pullRequest);
		await expect(ChangesetStore.read(io(first), first, pullRequest)).rejects.toMatchObject({
			name: "CliError",
			message: `another melian process in this clone is working on ${pullRequest}; wait for it to finish`,
		});
		await held.storage.close(context);
		await held.close();
	});

	it("keeps a pull request's SQLite storage from before the state branch, and says so", async () => {
		const directory = join(gitIn(first, "rev-parse", "--path-format=absolute", "--git-common-dir"), "melian");
		mkdirSync(directory, { recursive: true });
		const legacy = await openSqliteStorage(join(directory, `${pullRequest}.sqlite`));
		await legacy.close(context);
		const store = await ChangesetStore.write(io(first), first, pullRequest);
		await writeNote(store, "legacy");
		await store.close();
		expect(stderr).toEqual([
			`melian: ${pullRequest} keeps the SQLite storage it had before the state branch, in this clone alone\n`,
		]);
		expect(existsSync(join(directory, "state", pullRequest))).toBe(false);
		expect(() => branchTip()).toThrow();
	});

	it("works in this clone's copy when no writers' key is set, and says so", async () => {
		const store = await ChangesetStore.write(io(first, { [keyVariable]: "" }), first, pullRequest);
		await writeNote(store, "local");
		await store.close();
		expect(stderr).toEqual([
			"melian: no writers' key is configured for the state branch; this command works in this clone's copy of the pull request's storage, and a later command that reaches melian/state stores it\n",
		]);
		expect(() => branchTip()).toThrow();
		const again = (await ChangesetStore.read(io(first), first, pullRequest))!;
		expect(await readNotes(again)).toEqual(["local"]);
		await again.close();
	});

	it.each([
		["too short", "ab".repeat(31)],
		["base64 of 31 bytes", randomBytes(31).toString("base64")],
		["not base64", "!".repeat(44)],
	])("refuses a writers' key that is %s", async (_name, value) => {
		await expect(ChangesetStore.write(io(first, { [keyVariable]: value }), first, pullRequest)).rejects.toMatchObject(
			{
				name: "CliError",
				message: expect.stringMatching(
					/^credential state in .*secrets\.yaml is not a state key: give 64 hex digits or 32 bytes in base64$/,
				),
			},
		);
	});

	it("takes a writers' key in base64", async () => {
		const store = await ChangesetStore.write(
			io(first, { [keyVariable]: Buffer.from(key, "hex").toString("base64") }),
			first,
			pullRequest,
		);
		await writeNote(store, "kept");
		await store.close();
		expect(stderr).toEqual([]);
		const fresh = clone();
		const restored = await ChangesetStore.write(io(fresh), fresh, pullRequest);
		expect(await readNotes(restored)).toEqual(["kept"]);
		await restored.close();
	});

	it("keeps a refused store in this clone, and carries on from the branch's copy next time", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
			const loser = await ChangesetStore.write(io(first), first, pullRequest);
			await writeNote(loser, "loser");
			vi.setSystemTime(new Date("2026-11-07T03:00:00Z"));
			const other = clone();
			const winner = await ChangesetStore.write(io(other), other, pullRequest);
			await writeNote(winner, "winner");
			await winner.close();
			await loser.close();
			expect(stderr).toEqual([
				"melian: melian/state refused this command's storage: another run took the changeset's lease, at generation 2, after this one's 1; this clone keeps it, and the next command carries on from the branch's copy\n",
			]);
			stderr.length = 0;
			const resumed = await ChangesetStore.write(io(first), first, pullRequest);
			expect(stderr).toEqual([
				expect.stringMatching(
					/^melian: another run stored this pull request on melian\/state since this clone did; its copy is set aside at .*\.set-aside-\d+, and this command carries on from the branch's\n$/,
				),
			]);
			expect(await readNotes(resumed)).toEqual(["winner"]);
			await resumed.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("says when the branch goes out of reach before the store is pushed", async () => {
		const store = await ChangesetStore.write(io(first), first, pullRequest);
		await writeNote(store, "kept");
		rmSync(origin, { recursive: true, force: true });
		await store.close();
		expect(stderr).toEqual([
			expect.stringMatching(
				/^melian: melian\/state is out of reach: git fetch of melian\/state failed: .*; this clone keeps the pull request's storage, and a later command that reaches the branch stores it\n$/s,
			),
		]);
	});

	it("reads this clone's copy without the branch, and finds none in a fresh clone", async () => {
		const store = await ChangesetStore.write(io(first), first, pullRequest);
		await writeNote(store, "stored");
		await store.close();
		rmSync(origin, { recursive: true, force: true });
		const read = (await ChangesetStore.read(io(first), first, pullRequest))!;
		expect(await readNotes(read)).toEqual(["stored"]);
		await read.close();
		expect(stderr).toEqual([]);
	});

	it("says whether a store may hold a review", async () => {
		expect(await ChangesetStore.exists(io(first), first, pullRequest)).toBe(true);
		expect(await ChangesetStore.exists(io(first), first, "range-0123456789abcdef")).toBe(false);
		const range = await ChangesetStore.write(io(first), first, "range-0123456789abcdef");
		await range.storage.close(context);
		await range.close();
		expect(await ChangesetStore.exists(io(first), first, "range-0123456789abcdef")).toBe(true);
	});
});

describe("Codex's review of a35d88c", () => {
	it("fails a command whose copy cannot be stored, rather than call it offline", async () => {
		const store = await ChangesetStore.write(io(first), first, pullRequest);
		await writeNote(store, "kept");
		const copy = join(
			gitIn(first, "rev-parse", "--path-format=absolute", "--git-common-dir"),
			"melian",
			"state",
			pullRequest,
		);
		writeFileSync(join(copy, "stray.txt"), "");
		await expect(store.close()).rejects.toMatchObject({ code: "invalidCopy" });
		expect(stderr).toEqual([]);
		await expect(ChangesetStore.read(io(first), first, pullRequest)).resolves.toBeDefined();
	});

	it("restores a pull request's copy from the branch into a fresh clone, and releases the lease", async () => {
		const store = await ChangesetStore.write(io(first), first, pullRequest);
		await writeNote(store, "stored");
		await store.close();
		const fresh = clone();
		expect(await ChangesetStore.read(io(fresh), fresh, pullRequest)).toBeUndefined();
		await ChangesetStore.restore(io(fresh), fresh, pullRequest);
		const read = (await ChangesetStore.read(io(fresh), fresh, pullRequest))!;
		expect(await readNotes(read)).toEqual(["stored"]);
		await read.close();
		const index = JSON.parse(gitIn(origin, "cat-file", "blob", "refs/heads/melian/state:index.json"));
		expect(Date.parse(index.changesets[pullRequest].lease.expiresAt)).toBeLessThanOrEqual(Date.now());
	});
});

describe("Codex's review of 26338cc", () => {
	it.each([
		[
			"no writers' key is set",
			() => ({ env: { [keyVariable]: "" } }),
			"no writers' key is configured for the state branch",
		],
		[
			"the branch is out of reach",
			() => {
				rmSync(origin, { recursive: true, force: true });
				return { env: {} };
			},
			"git fetch of melian/state failed: ",
		],
	])("refuses an authoritative store when %s, before any command can use it", async (_name, setup, reason) => {
		const { env } = setup();
		const error = await ChangesetStore.write(io(first, env), first, pullRequest, undefined, {
			authoritative: true,
		}).catch((caught: unknown) => caught);
		expect(error).toMatchObject({
			name: "CliError",
			message: expect.stringContaining(
				`melian publish needs the pull request's storage from melian/state, which this clone could not lease: ${reason}`,
			),
		});
		await expect(ChangesetStore.read(io(first), first, pullRequest)).resolves.not.toBeUndefined();
	});

	it("opens an authoritative store when the branch is leased", async () => {
		const store = await ChangesetStore.write(io(first), first, pullRequest, undefined, { authoritative: true });
		await writeNote(store, "leased");
		await store.close();
		expect(stderr).toEqual([]);
	});
});

describe("Codex's review of a0756fc", () => {
	const authoritative = { authoritative: true } as const;
	const legacyIn = async (repo: string) => {
		const directory = join(gitIn(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), "melian");
		mkdirSync(directory, { recursive: true });
		await (await openSqliteStorage(join(directory, `${pullRequest}.sqlite`))).close(context);
	};

	it("stores the copy on the branch before posting, and keeps the lease", async () => {
		const store = await ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative);
		await writeNote(store, "secret");
		await store.checkpoint();
		expect(gitIn(origin, "ls-tree", "--name-only", "refs/heads/melian/state:changesets")).toBe(pullRequest);
		const index = () => JSON.parse(gitIn(origin, "cat-file", "blob", "refs/heads/melian/state:index.json"));
		const held = index().changesets[pullRequest];
		expect(held).toMatchObject({ lease: { generation: 1 }, written: 1 });
		expect(Date.parse(held.lease.expiresAt)).toBeGreaterThan(Date.now());
		await store.close();
		expect(Date.parse(index().changesets[pullRequest].lease.expiresAt)).toBeLessThanOrEqual(Date.now());
	});

	it("refuses to post when the copy cannot be stored first", async () => {
		const store = await ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative);
		rmSync(origin, { recursive: true, force: true });
		await expect(store.checkpoint()).rejects.toMatchObject({
			name: "CliError",
			message: expect.stringMatching(
				/^melian publish could not store the pull request's storage on melian\/state before posting: git fetch of melian\/state failed: .*; nothing more was posted$/s,
			),
		});
		await store.storage.close(context);
		await store.close().catch(() => {});
	});

	it("fails a publication whose storage the branch refuses afterwards", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
			const publishing = await ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative);
			await writeNote(publishing, "posted");
			vi.setSystemTime(new Date("2026-11-08T03:00:00Z"));
			const other = clone();
			const taker = await ChangesetStore.write(io(other), other, pullRequest);
			await taker.storage.close(context);
			await taker.close();
			await expect(publishing.close()).rejects.toMatchObject({
				name: "CliError",
				message:
					"GitHub has this publication, but melian/state did not take its storage: another run took the changeset's lease, at generation 2, after this one's 1; this clone keeps it, and melian publish run again here stores it",
			});
			await expect(ChangesetStore.read(io(first), first, pullRequest)).resolves.toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses to publish legacy SQLite storage of a pull request the branch also holds", async () => {
		const other = clone();
		const branchCopy = await ChangesetStore.write(io(other), other, pullRequest);
		await writeNote(branchCopy, "newer round");
		await branchCopy.close();
		await legacyIn(first);
		await expect(ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative)).rejects.toMatchObject(
			{
				name: "CliError",
				message: `${pullRequest} has SQLite storage in this clone from before the state branch, and melian/state holds the pull request too; publish it from a clone that holds the branch's copy`,
			},
		);
	});

	it("publishes legacy SQLite storage of a pull request the branch does not hold", async () => {
		await legacyIn(first);
		const store = await ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative);
		await store.storage.close(context);
		await store.close();
		expect(stderr).toEqual([
			`melian: ${pullRequest} keeps the SQLite storage it had before the state branch, in this clone alone\n`,
		]);
	});

	it("refuses to publish legacy SQLite storage when it cannot read the branch", async () => {
		await legacyIn(first);
		rmSync(origin, { recursive: true, force: true });
		await expect(ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative)).rejects.toMatchObject(
			{
				name: "CliError",
				message: expect.stringMatching(
					/^melian publish needs the pull request's storage from melian\/state, which this clone could not lease: git fetch of melian\/state failed: /,
				),
			},
		);
	});
});

describe("Codex's review of ff4b2e1", () => {
	const authoritative = { authoritative: true } as const;
	const legacyIn = async (repo: string) => {
		const directory = join(gitIn(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), "melian");
		mkdirSync(directory, { recursive: true });
		await (await openSqliteStorage(join(directory, `${pullRequest}.sqlite`))).close(context);
	};
	const index = () => JSON.parse(gitIn(origin, "cat-file", "blob", "refs/heads/melian/state:index.json"));

	it("holds the pull request's lease while legacy SQLite storage publishes, and releases it", async () => {
		await legacyIn(first);
		const store = await ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative);
		expect(index().changesets[pullRequest].lease.generation).toBe(1);
		const other = clone();
		await expect(ChangesetStore.write(io(other), other, pullRequest)).rejects.toMatchObject({
			name: "CliError",
			message: expect.stringMatching(/^another run holds pull-[0-9a-f]{16} on the state branch: /),
		});
		await store.checkpoint();
		await store.storage.close(context);
		await store.close();
		expect(Date.parse(index().changesets[pullRequest].lease.expiresAt)).toBeLessThanOrEqual(Date.now());
		expect(gitIn(origin, "ls-tree", "--name-only", "refs/heads/melian/state:changesets")).toBe("");
	});

	it("posts nothing from legacy SQLite storage once another clone stored a newer round after the check", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
			await legacyIn(first);
			const legacy = await ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative);
			vi.setSystemTime(new Date("2026-11-08T03:00:00Z"));
			const other = clone();
			const newer = await ChangesetStore.write(io(other), other, pullRequest);
			await writeNote(newer, "newer round");
			await newer.close();
			await expect(legacy.checkpoint()).rejects.toMatchObject({
				name: "CliError",
				message: expect.stringMatching(
					/^melian publish could not store the pull request's storage on melian\/state before posting: another run took the changeset's lease, at generation 2, after this one's 1; nothing more was posted$/,
				),
			});
			await legacy.storage.close(context);
			await legacy.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses a second publication of legacy SQLite storage in the same clone while the first holds it", async () => {
		await legacyIn(first);
		const store = await ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative);
		await expect(ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative)).rejects.toMatchObject(
			{
				name: "CliError",
				message: expect.stringMatching(
					/^another melian process in this clone is working on pull-[0-9a-f]{16}; wait for it to finish$/,
				),
			},
		);
		await store.storage.close(context);
		await store.close();
		const again = await ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative);
		expect(index().changesets[pullRequest].lease.generation).toBe(2);
		await again.storage.close(context);
		await again.close();
	});

	it("releases the reservation when legacy SQLite storage cannot be opened", async () => {
		await legacyIn(first);
		vi.spyOn(repository, "openStorage").mockRejectedValueOnce(new Error("database disk image is malformed"));
		await expect(ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative)).rejects.toThrow(
			/^database disk image is malformed$/,
		);
		expect(Date.parse(index().changesets[pullRequest].lease.expiresAt)).toBeLessThanOrEqual(Date.now());
		const again = await ChangesetStore.write(io(first), first, pullRequest, undefined, authoritative);
		await again.storage.close(context);
		await again.close();
	});

	it("refuses to publish legacy SQLite storage without the writers' key", async () => {
		await legacyIn(first);
		await expect(
			ChangesetStore.write(io(first, { [keyVariable]: "" }), first, pullRequest, undefined, authoritative),
		).rejects.toMatchObject({
			name: "CliError",
			message:
				"melian publish needs the pull request's storage from melian/state, which this clone could not lease: no writers' key is configured for the state branch; set the writers' key in a secrets file, and publish where the branch is in reach",
		});
	});
});

describe("Codex's review of a4de0552", () => {
	it("takes a checkpoint's snapshot only between Pi's commits, never during one", async () => {
		const store = await ChangesetStore.write(io(first), first, pullRequest);
		const scratch = await openJsonlStorage(join(first, ".git", "probe"), context);
		const prototype = Object.getPrototypeOf(scratch) as { commit: (...args: never[]) => Promise<unknown> };
		await scratch.close(context);
		const events: string[] = [];
		const commit = prototype.commit;
		vi.spyOn(prototype, "commit").mockImplementation(async function (this: unknown, ...args: never[]) {
			events.push("commit started");
			await new Promise((resolve) => setTimeout(resolve, 100));
			const done = await commit.apply(this, args);
			events.push("commit finished");
			return done;
		});
		const push = StateCheckout.prototype.push;
		vi.spyOn(StateCheckout.prototype, "push").mockImplementation(async function (this: StateCheckout, options) {
			events.push("snapshot");
			return push.call(this, options);
		});
		const writing = writeNote(store, "in flight");
		await new Promise((resolve) => setTimeout(resolve, 20));
		await Promise.all([writing, store.checkpoint()]);
		vi.restoreAllMocks();
		expect(events.slice(0, 3)).toEqual(["commit started", "commit finished", "snapshot"]);
		await store.storage.close(context);
		await store.close();
	});

	it("commits after a checkpoint that failed", async () => {
		const store = await ChangesetStore.write(io(first), first, pullRequest);
		vi.spyOn(StateCheckout.prototype, "push").mockRejectedValueOnce(new Error("no space left on device"));
		await expect(store.checkpoint()).rejects.toThrow(/^no space left on device$/);
		await expect(writeNote(store, "after")).resolves.toBeUndefined();
		await store.close();
		const again = await ChangesetStore.write(io(first), first, pullRequest);
		expect(await readNotes(again)).toEqual(["after"]);
		await again.close();
	});
});

import { existsSync, readdirSync } from "node:fs";
import type * as fs from "node:fs/promises";
import { join } from "node:path";
import { DirectoryRecordStore, type RecordEnvelope, RecordError, SharedRecord } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rejection, removeDirectory, temporaryDirectory } from "./fixtures/repo.ts";

type Held = "mkdir" | "rename" | "readdir" | "link" | "lstat" | "readFile" | "writeFile" | "rm";

// Holds the next call of one fs function on a matching path until the test releases it, so another handle's call can
// land while this one is in flight.
const held: { call?: Held; path?: string; reached?: () => void; release?: Promise<void> } = {};

// Makes the next call of one fs function on a matching path fail with an errno code, as a failing disk would.
const fault: { call?: Held; path?: string; code?: string } = {};

async function intercept(call: Held, path: string): Promise<void> {
	if (fault.call === call && fault.path !== undefined && path.includes(fault.path)) {
		fault.call = undefined;
		throw Object.assign(new Error(`${fault.code}: injected`), { code: fault.code });
	}
	const { reached, release } = held;
	if (held.call !== call || !path.includes(held.path ?? "/check/") || reached === undefined || release === undefined)
		return;
	held.call = undefined;
	reached();
	await release;
}

vi.mock("node:fs/promises", async (original) => {
	const real = await original<typeof fs>();
	// The path an fs call acts on: the destination for link and rename, the first argument for the rest.
	const wrap =
		<A extends unknown[], R>(call: Held, run: (...args: A) => Promise<R>, at = 0) =>
		async (...args: A): Promise<R> => {
			await intercept(call, String(args[at]));
			return run(...args);
		};
	return {
		...real,
		mkdir: wrap("mkdir", real.mkdir),
		readdir: wrap("readdir", real.readdir),
		link: wrap("link", real.link, 1),
		rename: wrap("rename", real.rename, 1),
		lstat: wrap("lstat", real.lstat),
		readFile: wrap("readFile", real.readFile),
		writeFile: wrap("writeFile", real.writeFile),
		rm: wrap("rm", real.rm),
	};
});

describe("DirectoryRecordStore with an add in flight", () => {
	let root: string;
	const changeset = "pull-0123456789abcdef";
	const envelope: RecordEnvelope = { v: 1, changeset, kind: "check", key: "static.biome", payload: {} };

	beforeEach(() => {
		root = temporaryDirectory();
	});

	afterEach(() => {
		removeDirectory(root);
	});

	function pause(call: Held, path?: string): { reached: Promise<void>; release: () => void } {
		let release = () => {};
		const reached = new Promise<void>((resolve) => {
			held.call = call;
			held.path = path;
			held.reached = resolve;
			held.release = new Promise<void>((done) => {
				release = done;
			});
		});
		return { reached, release: () => release() };
	}

	it.each([
		["list", (store: DirectoryRecordStore) => store.list(changeset), `/${changeset}`],
		["readCell", (store: DirectoryRecordStore) => store.readCell(changeset), "/.cell"],
	] as const)("fails %s unreachable when the store vanishes mid-call", async (_name, call, path) => {
		const store = await DirectoryRecordStore.open(root);
		await store.add([envelope]);
		await store.writeCell(changeset, undefined, "lease");
		const { reached, release } = pause("readdir", path);
		const answer = call(store);
		await reached;
		removeDirectory(join(root, "changesets"));
		release();
		expect((await rejection(answer, RecordError)).code).toBe("unreachable");
	});

	it.each([
		["before it makes the record's directory, so its file lands after dispose's sweep", "mkdir"],
		["before it renames its file, after dispose swept the directory away", "rename"],
	] as const)("refuses an add a dispose overtook %s, and leaves no record", async (_name, call) => {
		const adding = await DirectoryRecordStore.open(root);
		const disposing = await DirectoryRecordStore.open(root);
		const { reached, release } = pause(call, call === "mkdir" ? "/check" : undefined);
		const add = adding.add([envelope]);
		await reached;
		await disposing.dispose(changeset);
		release();
		expect((await rejection(add, RecordError)).code).toBe("disposed");
		expect(existsSync(join(root, SharedRecord.parse(envelope).path))).toBe(false);
		expect(await disposing.list(changeset)).toEqual([]);
	});

	it.each([
		["a cell it cannot list", "readdir", "/.cell", true, (store: DirectoryRecordStore) => store.readCell(changeset)],
		[
			"a cell it cannot link",
			"link",
			"/.cell/1",
			false,
			(store: DirectoryRecordStore) => store.writeCell(changeset, undefined, "lease"),
		],
		["a directory it cannot make", "mkdir", "/check", false, (store: DirectoryRecordStore) => store.add([envelope])],
		["a cell it cannot stat", "lstat", "/.cell", true, (store: DirectoryRecordStore) => store.readCell(changeset)],
		[
			"a cell it cannot read",
			"readFile",
			"/.cell/1",
			true,
			(store: DirectoryRecordStore) => store.readCell(changeset),
		],
	] as const)("fails unreachable on %s, with the cause", async (_name, call, path, seeded, act) => {
		const store = await DirectoryRecordStore.open(root);
		if (seeded) await store.writeCell(changeset, undefined, "seed");
		Object.assign(fault, { call, path, code: "EIO" });
		const error = await rejection(act(store), RecordError);
		expect(error.code).toBe("unreachable");
		const named = call === "readFile" ? path.slice(1) : path.replace("/1", "").slice(1);
		expect(error.path).toBe(join(root, "changesets", changeset, named));
		expect((error.cause as { code?: string }).code).toBe("EIO");
		expect(fault.call).toBeUndefined();
	});

	it("fails unreachable when it cannot write a temporary file, and leaves none", async () => {
		const store = await DirectoryRecordStore.open(root);
		Object.assign(fault, { call: "writeFile", path: "/tmp/", code: "EIO" });
		const error = await rejection(store.writeCell(changeset, undefined, "lease"), RecordError);
		expect(error.code).toBe("unreachable");
		expect(error.path?.startsWith(join(root, "tmp"))).toBe(true);
		expect((error.cause as { code?: string }).code).toBe("EIO");
		expect(readdirSync(join(root, "tmp"))).toEqual([]);
	});

	it("fails an add unreachable, not disposed, when its rename fails on a live changeset", async () => {
		const store = await DirectoryRecordStore.open(root);
		Object.assign(fault, { call: "rename", path: "/check/", code: "EIO" });
		const error = await rejection(store.add([envelope]), RecordError);
		expect(error.code).toBe("unreachable");
		expect(error.path).toBe(join(root, SharedRecord.parse(envelope).path));
		expect((error.cause as { code?: string }).code).toBe("EIO");
		expect(readdirSync(join(root, "tmp"))).toEqual([]);
		expect(await store.list(changeset)).toEqual([]);
	});

	it("lists nothing when a dispose lands while it walks", async () => {
		const store = await DirectoryRecordStore.open(root);
		const disposing = await DirectoryRecordStore.open(root);
		await store.add([envelope]);
		const { reached, release } = pause("readdir", "/check/");
		const listing = store.list(changeset);
		await reached;
		await disposing.dispose(changeset);
		release();
		expect(await listing).toEqual([]);
	});

	it("lets two disposes at once both finish", async () => {
		const first = await DirectoryRecordStore.open(root);
		const second = await DirectoryRecordStore.open(root);
		await first.add([envelope]);
		const { reached, release } = pause("rm", "/check");
		const disposing = first.dispose(changeset);
		await reached;
		await second.dispose(changeset);
		release();
		await disposing;
		expect(readdirSync(join(root, "changesets", changeset))).toEqual([".cell"]);
	});

	it("still refuses as disposed when a second dispose sweeps the record it is taking back", async () => {
		const adding = await DirectoryRecordStore.open(root);
		const disposing = await DirectoryRecordStore.open(root);
		const first = pause("mkdir", "/check");
		const add = adding.add([envelope]);
		await first.reached;
		await disposing.dispose(changeset);
		const second = pause("rm", "/check/");
		first.release();
		await second.reached;
		await disposing.dispose(changeset);
		second.release();
		expect((await rejection(add, RecordError)).code).toBe("disposed");
		expect(existsSync(join(root, SharedRecord.parse(envelope).path))).toBe(false);
	});

	it("leaves no temporary file when it loses a cell write to a writer that read the same version", async () => {
		const losing = await DirectoryRecordStore.open(root);
		const winning = await DirectoryRecordStore.open(root);
		const { reached, release } = pause("writeFile", "/tmp/");
		const lost = losing.writeCell(changeset, undefined, "lease A");
		await reached;
		expect(await winning.writeCell(changeset, undefined, "lease B")).toBe(true);
		release();
		expect(await lost).toBe(false);
		expect(await winning.readCell(changeset)).toEqual({ value: "lease B", version: "1" });
		expect(readdirSync(join(root, "tmp"))).toEqual([]);
	});
});

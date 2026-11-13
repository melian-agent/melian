import { existsSync } from "node:fs";
import type * as fs from "node:fs/promises";
import { join } from "node:path";
import { DirectoryRecordStore, type RecordEnvelope, RecordError, SharedRecord } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rejection, removeDirectory, temporaryDirectory } from "./fixtures/repo.ts";

// Holds the next call of one fs function on a record's path until the test releases it, so a dispose can land while
// an add is in flight.
const held: { call?: Held; path?: string; reached?: () => void; release?: Promise<void> } = {};

type Held = "mkdir" | "rename" | "readdir" | "link";

// Makes the next call of one fs function on a path fail with an errno code, as a failing disk would.
const fault: { call?: Held; path?: string; code?: string } = {};

function injected(call: Held, path: string): void {
	if (fault.call !== call || fault.path === undefined || !path.endsWith(fault.path)) return;
	const code = fault.code;
	fault.call = undefined;
	throw Object.assign(new Error(`${code}: injected`), { code });
}

async function hold(call: Held, path: string): Promise<void> {
	const { reached, release } = held;
	const target = held.path ?? "/check/";
	if (held.call !== call || !path.includes(target) || reached === undefined || release === undefined) return;
	held.call = undefined;
	reached();
	await release;
}

vi.mock("node:fs/promises", async (original) => {
	const real = await original<typeof fs>();
	return {
		...real,
		mkdir: async (path: string, options: Parameters<typeof real.mkdir>[1]) => {
			injected("mkdir", path);
			await hold("mkdir", path);
			return real.mkdir(path, options);
		},
		readdir: async (path: string, options: Parameters<typeof real.readdir>[1]) => {
			injected("readdir", path);
			await hold("readdir", path);
			return real.readdir(path, options);
		},
		link: async (from: string, to: string) => {
			injected("link", to);
			return real.link(from, to);
		},
		rename: async (from: string, to: string) => {
			await hold("rename", to);
			return real.rename(from, to);
		},
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
	] as const)("fails unreachable on %s, with the cause", async (_name, call, path, seeded, act) => {
		const store = await DirectoryRecordStore.open(root);
		if (seeded) await store.writeCell(changeset, undefined, "seed");
		Object.assign(fault, { call, path, code: "EIO" });
		const error = await rejection(act(store), RecordError);
		expect(error.code).toBe("unreachable");
		expect(error.path).toBe(join(root, "changesets", changeset, path.replace("/1", "").slice(1)));
		expect((error.cause as { code?: string }).code).toBe("EIO");
		expect(fault.call).toBeUndefined();
	});
});

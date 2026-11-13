import { existsSync } from "node:fs";
import type * as fs from "node:fs/promises";
import { join } from "node:path";
import { DirectoryRecordStore, type RecordEnvelope, RecordError, SharedRecord } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rejection, removeDirectory, temporaryDirectory } from "./fixtures/repo.ts";

// Holds the next call of one fs function on a record's path until the test releases it, so a dispose can land while
// an add is in flight.
const held: { call?: "mkdir" | "rename"; reached?: () => void; release?: Promise<void> } = {};

async function hold(call: "mkdir" | "rename", path: string): Promise<void> {
	const { reached, release } = held;
	if (held.call !== call || !path.includes("/check/") || reached === undefined || release === undefined) return;
	held.call = undefined;
	reached();
	await release;
}

vi.mock("node:fs/promises", async (original) => {
	const real = await original<typeof fs>();
	return {
		...real,
		mkdir: async (path: string, options: Parameters<typeof real.mkdir>[1]) => {
			await hold("mkdir", path);
			return real.mkdir(path, options);
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

	it.each([
		["before it makes the record's directory, so its file lands after dispose's sweep", "mkdir"],
		["before it renames its file, after dispose swept the directory away", "rename"],
	] as const)("refuses an add a dispose overtook %s, and leaves no record", async (_name, call) => {
		const adding = await DirectoryRecordStore.open(root);
		const disposing = await DirectoryRecordStore.open(root);
		let release = () => {};
		const reached = new Promise<void>((resolve) => {
			held.call = call;
			held.reached = resolve;
			held.release = new Promise<void>((done) => {
				release = done;
			});
		});
		const add = adding.add([envelope]);
		await reached;
		await disposing.dispose(changeset);
		release();
		expect((await rejection(add, RecordError)).code).toBe("disposed");
		expect(existsSync(join(root, SharedRecord.parse(envelope).path))).toBe(false);
		expect(await disposing.list(changeset)).toEqual([]);
	});
});

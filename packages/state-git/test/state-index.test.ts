import { Lease } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { StateIndex } from "../src/index.ts";

const at = Date.parse("2026-11-08T00:00:00Z");
const hour = 60 * 60 * 1000;
const lease = Lease.take(undefined, { clone: "clone-1", run: "run-1" }, at, hour);
const stored = lease.toJSON();
const indexOf = (changesets: unknown, version: unknown = 1) => JSON.stringify({ version, changesets });

describe("StateIndex", () => {
	it("reads what it writes, in changeset order", () => {
		const index = StateIndex.empty()
			.leased("pull-b", lease)
			.leased("pull-a", Lease.take(lease, lease.holder, at, hour));
		const json = JSON.stringify(index);
		expect(JSON.parse(json)).toEqual({
			version: 1,
			changesets: { "pull-a": { lease: { ...stored, generation: 2 } }, "pull-b": { lease: stored } },
		});
		expect(Object.keys(JSON.parse(json).changesets)).toEqual(["pull-a", "pull-b"]);
		expect(StateIndex.parse(json).toJSON()).toEqual(index.toJSON());
	});

	it("records a write under the lease's generation, and keeps it through a release", () => {
		const index = StateIndex.empty()
			.leased("pull-a", lease)
			.wrote("pull-a")
			.released("pull-a", at + 1);
		expect(index.toJSON().changesets).toEqual({
			"pull-a": { lease: { ...stored, expiresAt: "2026-11-08T00:00:00.001Z" }, written: 1 },
		});
		expect(index.written("pull-a")).toBe(1);
		expect(index.lease("pull-a")?.live(at + 1)).toBe(false);
		const retaken = index.leased("pull-a", Lease.take(index.lease("pull-a"), lease.holder, at + 2, hour));
		expect(retaken.lease("pull-a")?.generation).toBe(2);
		expect(retaken.written("pull-a")).toBe(1);
		expect(StateIndex.parse(JSON.stringify(retaken)).written("pull-a")).toBe(1);
	});

	it("leaves other changesets as they were", () => {
		const other = Lease.take(undefined, { clone: "clone-2", run: "run-2" }, at, hour);
		const index = StateIndex.empty().leased("pull-a", lease).leased("pull-b", other).released("pull-a", at);
		expect(index.lease("pull-b")?.toJSON()).toEqual(other.toJSON());
		expect(index.written("pull-b")).toBeUndefined();
	});

	it.each([
		["not JSON", "{", "it is not JSON"],
		["not an object", "null", "it is not an object"],
		["a number", "5", "it is not an object"],
		["another version", indexOf({}, 2), "its version is 2, and this build of Melian reads version 1"],
		[
			"no version",
			JSON.stringify({ changesets: {} }),
			"its version is undefined, and this build of Melian reads version 1",
		],
		["changesets as an array", indexOf([]), "its changesets are not an object"],
		["changesets absent", JSON.stringify({ version: 1 }), "its changesets are not an object"],
		["a record that is not an object", indexOf({ a: 1 }), "the record of a is not an object"],
		["a record with no lease", indexOf({ a: {} }), "the lease of a: a lease is not an object"],
		[
			"a lease of generation zero",
			indexOf({ a: { lease: { ...stored, generation: 0 } } }),
			"the lease of a: a lease's generation is not a count",
		],
		[
			"a written generation past the lease's",
			indexOf({ a: { lease: stored, written: 2 } }),
			"the written generation of a is not one its lease has reached",
		],
		[
			"a written generation of zero",
			indexOf({ a: { lease: stored, written: 0 } }),
			"the written generation of a is not one its lease has reached",
		],
		[
			"a fractional written generation",
			indexOf({ a: { lease: stored, written: 0.5 } }),
			"the written generation of a is not one its lease has reached",
		],
		[
			"a key that is no commitment",
			JSON.stringify({ version: 1, key: "f".repeat(63), changesets: {} }),
			"its key is not a commitment",
		],
		["a numeric key", JSON.stringify({ version: 1, key: 7, changesets: {} }), "its key is not a commitment"],
		[
			"a key that is a list holding a commitment",
			JSON.stringify({ version: 1, key: ["f".repeat(64)], changesets: {} }),
			"its key is not a commitment",
		],
		["changesets of null", indexOf(null), "its changesets are not an object"],
		[
			"a key this build does not know at its root",
			JSON.stringify({ version: 1, changesets: {}, epoch: 2 }),
			'it holds the key "epoch", which this build of Melian does not know',
		],
		[
			"a key this build does not know in a changeset's record",
			indexOf({ a: { lease: stored, written: 1, epoch: 2 } }),
			'the record of a holds the key "epoch", which this build of Melian does not know',
		],
		[
			"a key this build does not know in a lease",
			indexOf({ a: { lease: { ...stored, epoch: 2 } } }),
			'the lease of a holds the key "epoch", which this build of Melian does not know',
		],
		[
			"a key this build does not know in a lease's holder",
			indexOf({ a: { lease: { ...stored, holder: { ...stored.holder, host: "h" } } } }),
			'the holder of a\'s lease holds the key "host", which this build of Melian does not know',
		],
		["a record of null", indexOf({ a: null }), "the record of a is not an object"],
		[
			"a key with a commitment at its end",
			JSON.stringify({ version: 1, key: `x${"f".repeat(64)}`, changesets: {} }),
			"its key is not a commitment",
		],
		[
			"a key with a commitment at its start",
			JSON.stringify({ version: 1, key: `${"f".repeat(64)}x`, changesets: {} }),
			"its key is not a commitment",
		],
	])("refuses %s", (_name, json, reason) => {
		expect(() => StateIndex.parse(json)).toThrow(
			expect.objectContaining({
				code: "invalidBranch",
				message: `the state branch's index.json cannot be read: ${reason}`,
			}),
		);
	});

	it("reads a written generation equal to its lease's", () => {
		expect(StateIndex.parse(indexOf({ a: { lease: stored, written: 1 } })).written("a")).toBe(1);
	});

	it("keeps the key commitment it reads, and adds one it is given", () => {
		const key = "a".repeat(64);
		expect(StateIndex.parse(JSON.stringify({ version: 1, key, changesets: {} })).key).toBe(key);
		expect(StateIndex.empty().key).toBeUndefined();
		expect(StateIndex.empty().keyed(key).toJSON()).toEqual({ version: 1, key, changesets: {} });
		expect(StateIndex.empty().toJSON()).toEqual({ version: 1, changesets: {} });
	});
});

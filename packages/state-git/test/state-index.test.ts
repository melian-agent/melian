import { describe, expect, it } from "vitest";
import { StateIndex } from "../src/index.ts";

const lease = { run: "run-1", holder: "clone-1", heartbeat: "2026-11-07T00:00:00.000Z", attempts: 1 };
const indexOf = (changesets: unknown, version: unknown = 1) => JSON.stringify({ version, changesets });

describe("StateIndex", () => {
	it("reads what it writes, in changeset order", () => {
		const index = StateIndex.empty()
			.leased("pull-b", lease)
			.leased("pull-a", { ...lease, attempts: 2 });
		const json = JSON.stringify(index);
		expect(JSON.parse(json)).toEqual({
			version: 1,
			changesets: { "pull-a": { lease: { ...lease, attempts: 2 } }, "pull-b": { lease } },
		});
		expect(Object.keys(JSON.parse(json).changesets)).toEqual(["pull-a", "pull-b"]);
		expect(StateIndex.parse(json).toJSON()).toEqual(index.toJSON());
	});

	it("releases one changeset and keeps the rest", () => {
		const index = StateIndex.empty().leased("pull-a", lease).leased("pull-b", lease).released("pull-a");
		expect(index.lease("pull-a")).toBeUndefined();
		expect(index.lease("pull-b")).toEqual(lease);
		expect(index.toJSON()).toEqual({ version: 1, changesets: { "pull-b": { lease } } });
	});

	it.each([
		["not JSON", "{", "it is not JSON"],
		["not an object", "null", "it is not an object"],
		["another version", indexOf({}, 2), "its version is 2, and this build of Melian reads version 1"],
		[
			"no version",
			JSON.stringify({ changesets: {} }),
			"its version is undefined, and this build of Melian reads version 1",
		],
		["changesets as an array", indexOf([]), "its changesets are not an object"],
		["changesets absent", JSON.stringify({ version: 1 }), "its changesets are not an object"],
		["a record that is not an object", indexOf({ a: 1 }), "the record of a is not an object"],
		["a record with no lease", indexOf({ a: {} }), "a lease is not an object"],
		["attempts of zero", indexOf({ a: { lease: { ...lease, attempts: 0 } } }), "a lease's attempts is not a count"],
		[
			"fractional attempts",
			indexOf({ a: { lease: { ...lease, attempts: 1.5 } } }),
			"a lease's attempts is not a count",
		],
		[
			"a heartbeat that is no time",
			indexOf({ a: { lease: { ...lease, heartbeat: "soon" } } }),
			"a lease's heartbeat is not a time",
		],
		["an empty run", indexOf({ a: { lease: { ...lease, run: "" } } }), "its run is not a short string"],
		[
			"a long holder",
			indexOf({ a: { lease: { ...lease, holder: "x".repeat(201) } } }),
			"its holder is not a short string",
		],
		[
			"a numeric heartbeat",
			indexOf({ a: { lease: { ...lease, heartbeat: 5 } } }),
			"its heartbeat is not a short string",
		],
	])("refuses %s", (_name, json, reason) => {
		expect(() => StateIndex.parse(json)).toThrow(
			expect.objectContaining({
				code: "invalidBranch",
				message: `the state branch's index.json cannot be read: ${reason}`,
			}),
		);
	});

	it("reads a holder of exactly 200 characters", () => {
		const long = { ...lease, holder: "x".repeat(200) };
		expect(StateIndex.parse(indexOf({ a: { lease: long } })).lease("a")).toEqual(long);
	});
});

it("keeps the key commitment it reads, and adds one it is given", () => {
	const key = "a".repeat(64);
	expect(StateIndex.parse(JSON.stringify({ version: 1, key, changesets: {} })).key).toBe(key);
	expect(StateIndex.empty().key).toBeUndefined();
	expect(StateIndex.empty().leased("pull-a", lease).keyed(key).released("pull-a").toJSON()).toEqual({
		version: 1,
		key,
		changesets: {},
	});
	expect(StateIndex.empty().toJSON()).toEqual({ version: 1, changesets: {} });
});

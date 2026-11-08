import { Lease, LeaseError } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const holder = { clone: "clone-1", run: "run-1" };
const at = Date.parse("2026-11-08T00:00:00Z");
const hour = 60 * 60 * 1000;

describe("Lease", () => {
	it("takes its first generation, and one more than the lease it supersedes", () => {
		const first = Lease.take(undefined, holder, at, hour);
		expect(first.toJSON()).toEqual({
			holder,
			takenAt: "2026-11-08T00:00:00.000Z",
			expiresAt: "2026-11-08T01:00:00.000Z",
			incarnation: expect.stringMatching(/^[0-9a-f-]{36}$/),
			generation: 1,
		});
		const next = Lease.take(first, { clone: "clone-2", run: "run-2" }, at + 2 * hour, hour);
		expect(next.generation).toBe(2);
		expect(next.holder).toEqual({ clone: "clone-2", run: "run-2" });
	});

	it("is live until its expiry, and not at it", () => {
		const lease = Lease.take(undefined, holder, at, hour);
		expect(lease.live(at + hour - 1)).toBe(true);
		expect(lease.live(at + hour)).toBe(false);
	});

	it("knows its holder by clone and run alike", () => {
		const lease = Lease.take(undefined, holder, at, hour);
		expect(lease.heldBy(holder)).toBe(true);
		expect(lease.heldBy({ clone: "clone-1", run: "run-2" })).toBe(false);
		expect(lease.heldBy({ clone: "clone-2", run: "run-1" })).toBe(false);
	});

	it("renews its expiry and keeps its generation, and releases at once", () => {
		const lease = Lease.take(Lease.take(undefined, holder, at, hour), holder, at, hour);
		const renewed = lease.renewed(at + 30 * 60 * 1000, hour);
		expect(renewed.toJSON()).toEqual({ ...lease.toJSON(), expiresAt: "2026-11-08T01:30:00.000Z" });
		const released = renewed.released(at + hour);
		expect(released.toJSON()).toEqual({ ...lease.toJSON(), expiresAt: "2026-11-08T01:00:00.000Z" });
		expect(released.live(at + hour)).toBe(false);
		expect(Lease.take(released, holder, at + hour, hour).generation).toBe(3);
	});

	it("admits a write made under its own incarnation and generation, and refuses an older or newer one", () => {
		const lease = Lease.take(Lease.take(undefined, holder, at, hour), holder, at, hour);
		expect(lease.admits(lease.incarnation, 2)).toBe(true);
		expect(lease.admits(lease.incarnation, 1)).toBe(false);
		expect(lease.admits(lease.incarnation, 3)).toBe(false);
	});

	it("keeps its incarnation across takings, and mints a new one for a record created afresh", () => {
		const first = Lease.take(undefined, holder, at, hour);
		const second = Lease.take(first, holder, at, hour);
		expect(second.incarnation).toBe(first.incarnation);
		const recreated = Lease.take(undefined, holder, at, hour);
		expect(recreated.incarnation).not.toBe(first.incarnation);
		expect(recreated.generation).toBe(1);
		// A write from the disposed record is refused, though its generation is higher.
		expect(recreated.admits(second.incarnation, second.generation)).toBe(false);
		expect(recreated.admits(recreated.incarnation, 1)).toBe(true);
		// And one from the disposed record at the same generation, so only the incarnation decides.
		expect(recreated.admits(first.incarnation, 1)).toBe(false);
	});

	it("reads what it writes", () => {
		const lease = Lease.take(undefined, holder, at, hour);
		expect(Lease.parse(JSON.parse(JSON.stringify(lease))).toJSON()).toEqual(lease.toJSON());
	});

	it.each([
		["not an object", null],
		[
			"no holder",
			{
				takenAt: "2026-11-08T00:00:00.000Z",
				expiresAt: "2026-11-08T01:00:00.000Z",
				incarnation: "i",
				generation: 1,
			},
		],
		[
			"an empty clone",
			{
				holder: { clone: "", run: "r" },
				takenAt: "2026-11-08T00:00:00.000Z",
				expiresAt: "2026-11-08T01:00:00.000Z",
				generation: 1,
				incarnation: "i",
			},
		],
		[
			"a long run",
			{
				holder: { clone: "c", run: "x".repeat(201) },
				takenAt: "2026-11-08T00:00:00.000Z",
				expiresAt: "2026-11-08T01:00:00.000Z",
				generation: 1,
				incarnation: "i",
			},
		],
		[
			"a takenAt that is no time",
			{ holder, takenAt: "soon", expiresAt: "2026-11-08T01:00:00.000Z", incarnation: "i", generation: 1 },
		],
		[
			"an expiresAt that is no time",
			{ holder, takenAt: "2026-11-08T00:00:00.000Z", expiresAt: 5, incarnation: "i", generation: 1 },
		],
		[
			"generation zero",
			{
				holder,
				takenAt: "2026-11-08T00:00:00.000Z",
				expiresAt: "2026-11-08T01:00:00.000Z",
				generation: 0,
				incarnation: "i",
			},
		],
		[
			"a fractional generation",
			{
				holder,
				takenAt: "2026-11-08T00:00:00.000Z",
				expiresAt: "2026-11-08T01:00:00.000Z",
				generation: 1.5,
				incarnation: "i",
			},
		],
	])("refuses %s", (_name, value) => {
		expect(() => Lease.parse(value)).toThrow(LeaseError);
	});

	it.each([
		["no incarnation", undefined],
		["an empty incarnation", ""],
		["an incarnation of 201 characters", "x".repeat(201)],
		["an incarnation that is no string", 7],
	])("refuses %s", (_name, incarnation) => {
		const stored = { ...Lease.take(undefined, holder, at, hour).toJSON(), incarnation };
		expect(() => Lease.parse(stored)).toThrow("a lease's incarnation is not a short string");
	});

	it("reads an incarnation of exactly 200 characters", () => {
		const stored = { ...Lease.take(undefined, holder, at, hour).toJSON(), incarnation: "x".repeat(200) };
		expect(Lease.parse(stored).incarnation).toBe("x".repeat(200));
	});

	it("reads a run of exactly 200 characters", () => {
		const long = { clone: "c", run: "x".repeat(200) };
		expect(Lease.parse(Lease.take(undefined, long, at, hour).toJSON()).holder).toEqual(long);
	});

	it("refuses a holder it could not read back", () => {
		expect(() => Lease.take(undefined, { clone: "", run: "r" }, at, hour)).toThrow(
			expect.objectContaining({
				code: "invalidLease",
				message: "a lease's holder must name a clone and a run of 1 to 200 characters each",
			}),
		);
	});
});

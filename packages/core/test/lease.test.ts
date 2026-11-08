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

	it("admits a write made under its own generation, and refuses an older or newer one", () => {
		const lease = Lease.take(Lease.take(undefined, holder, at, hour), holder, at, hour);
		expect(lease.admits(2)).toBe(true);
		expect(lease.admits(1)).toBe(false);
		expect(lease.admits(3)).toBe(false);
	});

	it("reads what it writes", () => {
		const lease = Lease.take(undefined, holder, at, hour);
		expect(Lease.parse(JSON.parse(JSON.stringify(lease))).toJSON()).toEqual(lease.toJSON());
	});

	it.each([
		["not an object", null],
		["no holder", { takenAt: "2026-11-08T00:00:00.000Z", expiresAt: "2026-11-08T01:00:00.000Z", generation: 1 }],
		[
			"an empty clone",
			{
				holder: { clone: "", run: "r" },
				takenAt: "2026-11-08T00:00:00.000Z",
				expiresAt: "2026-11-08T01:00:00.000Z",
				generation: 1,
			},
		],
		[
			"a long run",
			{
				holder: { clone: "c", run: "x".repeat(201) },
				takenAt: "2026-11-08T00:00:00.000Z",
				expiresAt: "2026-11-08T01:00:00.000Z",
				generation: 1,
			},
		],
		["a takenAt that is no time", { holder, takenAt: "soon", expiresAt: "2026-11-08T01:00:00.000Z", generation: 1 }],
		["an expiresAt that is no time", { holder, takenAt: "2026-11-08T00:00:00.000Z", expiresAt: 5, generation: 1 }],
		[
			"generation zero",
			{ holder, takenAt: "2026-11-08T00:00:00.000Z", expiresAt: "2026-11-08T01:00:00.000Z", generation: 0 },
		],
		[
			"a fractional generation",
			{ holder, takenAt: "2026-11-08T00:00:00.000Z", expiresAt: "2026-11-08T01:00:00.000Z", generation: 1.5 },
		],
	])("refuses %s", (_name, value) => {
		expect(() => Lease.parse(value)).toThrow(LeaseError);
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

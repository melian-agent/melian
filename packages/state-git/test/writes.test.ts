import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../src/index.ts";
import { RecordRepository } from "../src/repository.ts";
import { changeset, check, keys, Remote } from "./fixtures/remote.ts";

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await remote.close();
});

// A clock that stands still until a store sleeps, and then moves to the next time `after` names.
function steppedClock(after: (slept: number) => number): Clock & { slept: number[] } {
	let now = 0;
	const slept: number[] = [];
	return {
		slept,
		now: () => now,
		sleep: async (ms) => {
			slept.push(ms);
			now = after(slept.length);
		},
	};
}

// Makes the next `count` pushes lose a race for real: another writer's commit lands just before each.
function loseRaces(count: number) {
	const push = RecordRepository.prototype.push;
	let lost = 0;
	return vi.spyOn(RecordRepository.prototype, "push").mockImplementation(async function (
		this: RecordRepository,
		...args
	) {
		if (lost < count) remote.plant({ [`changesets/other-writer-${++lost}/cell.json`]: null });
		return push.apply(this, args);
	});
}

describe("concurrent writers", { timeout: 120_000 }, () => {
	it("two clones adding at once lose no record", async () => {
		const first = await remote.open();
		const second = await remote.open();
		const batches = Array.from({ length: 6 }, (_, n) =>
			[first, second].map((store, s) => store.add([check(`${s}-${n}`)])),
		);
		await Promise.all(batches.flat());
		const expected = [0, 1].flatMap((s) => Array.from({ length: 6 }, (_, n) => `${s}-${n}`)).sort();
		expect(keys(await (await remote.open()).list(changeset))).toEqual(expected);
	});

	it("two handles sharing one repository fetch at once without a lock failing either", async () => {
		const directory = remote.host();
		const first = await remote.open({ directory });
		const second = await remote.open({ directory });
		await first.add([check("shared")]);
		const lists = await Promise.all(Array.from({ length: 8 }, (_, n) => (n % 2 ? first : second).list(changeset)));
		for (const listed of lists) expect(keys(listed)).toEqual(["shared"]);
	});

	it("a lost race reads the newer tip and pushes again, leased on it", async () => {
		const store = await remote.open();
		await store.add([check("first")]);
		const before = remote.tip();
		const push = loseRaces(1);
		await store.add([check("second")]);
		expect(push).toHaveBeenCalledTimes(2);
		expect(push.mock.calls[0]![3]).toBe(before);
		expect(push.mock.calls[1]![3]).not.toBe(before);
		expect(keys(await store.list(changeset))).toEqual(["first", "second"]);
	});

	it("a cell write whose version moved during its race returns false and pushes nothing more", async () => {
		const store = await remote.open();
		const rival = await remote.open();
		await store.writeCell(changeset, undefined, '"A"');
		const { version } = await store.readCell(changeset);
		const push = RecordRepository.prototype.push;
		const spy = vi.spyOn(RecordRepository.prototype, "push").mockImplementationOnce(async function (
			this: RecordRepository,
			...args
		) {
			expect(await rival.writeCell(changeset, version, '"B"')).toBe(true);
			return push.apply(this, args);
		});
		expect(await store.writeCell(changeset, version, '"C"')).toBe(false);
		// The store's one push, and the rival's inside it.
		expect(spy).toHaveBeenCalledTimes(2);
		expect((await store.readCell(changeset)).value).toBe('"B"');
	});
});

describe("the retry deadline", { timeout: 120_000 }, () => {
	// After one lost race the clock reads `after`; the store reads the tip again only while time is left.
	async function retriesAt(after: number, deadlineMs?: number): Promise<number> {
		const store = await remote.open({ clock: steppedClock(() => after), ...(deadlineMs ? { deadlineMs } : {}) });
		loseRaces(1);
		const fetch = vi.spyOn(RecordRepository.prototype, "fetch");
		await expect(store.add([check("late")])).rejects.toMatchObject({ code: "unreachable" });
		return fetch.mock.calls.length;
	}

	it("reads the tip again a millisecond before the default two minutes pass, with that millisecond to fetch in", async () => {
		const fetch = vi.spyOn(RecordRepository.prototype, "fetch");
		expect(await retriesAt(119_999)).toBe(2);
		expect(fetch.mock.calls[1]![2]).toBe(1);
	});

	it("fails without reading again once the default two minutes have passed", async () => {
		expect(await retriesAt(120_000)).toBe(1);
	});

	it("takes a deadline it is given, at the bound and one past it", async () => {
		expect(await retriesAt(4_999, 5_000)).toBe(2);
		vi.restoreAllMocks();
		expect(await retriesAt(5_000, 5_000)).toBe(1);
	});

	it("gives each transfer the time left before the deadline", async () => {
		let now = 1_000;
		const clock: Clock = { now: () => now, sleep: async () => {} };
		const store = await remote.open({ clock, deadlineMs: 10_000 });
		const fetch = vi.spyOn(RecordRepository.prototype, "fetch");
		const push = vi.spyOn(RecordRepository.prototype, "push");
		const commit = RecordRepository.prototype.commit;
		vi.spyOn(RecordRepository.prototype, "commit").mockImplementation(async function (
			this: RecordRepository,
			...args
		) {
			now = 4_000;
			return commit.apply(this, args);
		});
		await store.add([check("timed")]);
		expect(fetch.mock.calls[0]![2]).toBe(10_000);
		expect(push.mock.calls[0]![4]).toBe(7_000);
	});

	it("waits a random time below a bound that doubles from 50 ms and stops growing at 8 s", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const clock = steppedClock(() => 0);
		const store = await remote.open({ clock });
		loseRaces(10);
		await store.add([check("patient")]);
		expect(clock.slept).toEqual([25, 50, 100, 200, 400, 800, 1_600, 3_200, 4_000, 4_000]);
	});
});

describe("a push stopped at its deadline", { timeout: 120_000 }, () => {
	// The next push runs `before`, then pushes for real only when `lands`, and answers that it ran past its deadline.
	function stopPush(lands: boolean, before: () => void = () => {}) {
		const push = RecordRepository.prototype.push;
		return vi.spyOn(RecordRepository.prototype, "push").mockImplementationOnce(async function (
			this: RecordRepository,
			...args
		) {
			if (lands) expect(await push.apply(this, args)).toBe("landed");
			before();
			return "timedOut";
		});
	}

	it("counts as landed when its commit is the tip, and pushes no second commit", async () => {
		const store = await remote.open();
		const push = stopPush(true);
		await store.add([check("landed")]);
		expect(push).toHaveBeenCalledTimes(1);
		expect(remote.git(["rev-list", "--count", "refs/heads/melian/state"])).toBe("1");
	});

	it("counts as landed when later commits sit on top of it, deepening the fetch to find it", async () => {
		const store = await remote.open();
		await store.add([check("first")]);
		const push = stopPush(true, () => {
			for (let n = 0; n < 5; n++) remote.plant({ [`changesets/later-${n}/cell.json`]: null });
		});
		const fetch = vi.spyOn(RecordRepository.prototype, "fetch");
		await store.add([check("landed")]);
		expect(push).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls.map((call) => call[3] ?? 1)).toEqual([1, 1, 2, 4, 8]);
		expect(keys(await store.list(changeset))).toEqual(["first", "landed"]);
	});

	it("counts as lost when the tip it was built on is in the history without it, and pushes again", async () => {
		const store = await remote.open();
		await store.add([check("first")]);
		const push = stopPush(false, () => {
			for (let n = 0; n < 3; n++) remote.plant({ [`changesets/later-${n}/cell.json`]: null });
		});
		await store.add([check("retried")]);
		expect(push).toHaveBeenCalledTimes(2);
		expect(keys(await store.list(changeset))).toEqual(["first", "retried"]);
		expect(remote.git(["rev-list", "--count", "refs/heads/melian/state"])).toBe("5");
	});

	it("counts as lost on a branch it created when the whole history lacks it", async () => {
		const store = await remote.open();
		const push = stopPush(false, () => {
			for (let n = 0; n < 3; n++) remote.plant({ [`changesets/other-${n}/cell.json`]: null });
		});
		await store.add([check("created")]);
		expect(push).toHaveBeenCalledTimes(2);
		expect(keys(await store.list(changeset))).toEqual(["created"]);
	});

	it("fails as unreachable, saying it may have landed, when the check cannot reach the remote", async () => {
		const store = await remote.open();
		const fetch = RecordRepository.prototype.fetch;
		stopPush(true);
		vi.spyOn(RecordRepository.prototype, "fetch")
			.mockImplementationOnce(function (this: RecordRepository, ...args) {
				return fetch.apply(this, args);
			})
			.mockRejectedValueOnce(new Error("gone"));
		await expect(store.add([check("unsure")])).rejects.toMatchObject({
			code: "unreachable",
			message: expect.stringContaining("may have landed"),
			cause: expect.objectContaining({ message: "gone" }),
		});
	});

	it("counts as lost when the branch is gone, and pushes again", async () => {
		const store = await remote.open();
		const push = stopPush(false);
		await store.add([check("created")]);
		expect(push).toHaveBeenCalledTimes(2);
		expect(keys(await store.list(changeset))).toEqual(["created"]);
	});

	it("counts as lost without deepening when the tip is still the one it was built on", async () => {
		const store = await remote.open();
		await store.add([check("first")]);
		await store.add([check("second")]);
		stopPush(false);
		const fetch = vi.spyOn(RecordRepository.prototype, "fetch");
		await store.add([check("retried")]);
		expect(fetch.mock.calls.map((call) => call[3] ?? 1)).toEqual([1, 1, 1]);
		expect(keys(await store.list(changeset))).toEqual(["first", "retried", "second"]);
	});
});

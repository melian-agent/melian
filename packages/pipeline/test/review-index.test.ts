import { describe, expect, it } from "vitest";
import { finished, stillOwns, undecided } from "../src/review-index.ts";

const terminal = (status: string) => ({ state: { status: "terminal", outcome: { status } } });

describe("finished", () => {
	it("is true for a task that ran to the end with an outcome that decided something", () => {
		expect(finished(terminal("completed"), undecided)).toBe(true);
		expect(finished(terminal("failed"), undecided)).toBe(true);
	});

	it.each(undecided)("is false for a task that ended %s", (status) => {
		expect(finished(terminal(status), undecided)).toBe(false);
	});

	it("is false for a task still pending or running, which a repeat call resumes", () => {
		expect(finished({ state: { status: "pending" } }, undecided)).toBe(false);
		expect(finished({ state: { status: "completing" } }, undecided)).toBe(false);
	});

	it("is false for a task the storage no longer holds", () => {
		expect(finished(undefined, undecided)).toBe(false);
	});

	it("takes its own list of outcomes to retry", () => {
		expect(finished(terminal("failed"), [...undecided, "failed"])).toBe(false);
	});
});

describe("stillOwns", () => {
	const verified = { lenses: [], task: 1, verification: { task: 2, input: "{}" } };
	it.each([
		["an entry naming its lens task and the verification it relied on", verified, 1, 2, true],
		["an entry naming its lens task, for a review that relied on no verification", verified, 1, undefined, true],
		["an entry naming another lens task", verified, 3, 2, false],
		["an entry naming another verification", verified, 1, 4, false],
		["an entry with no verification, for a review that relied on one", { lenses: [], task: 1 }, 1, 2, false],
		["no entry, for a review that ran a lens", undefined, 1, undefined, false],
		["no entry, for a review that ran no lens but relied on a verification", undefined, undefined, 2, false],
		["no entry, for a review that ran no lens and relied on no verification", undefined, undefined, undefined, true],
	])("answers for %s", (_, entry, lensTask, verification, owns) => {
		expect(stillOwns(entry, lensTask, verification)).toBe(owns);
	});
});

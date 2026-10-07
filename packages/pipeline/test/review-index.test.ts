import { describe, expect, it } from "vitest";
import { finished, undecided } from "../src/review-index.ts";

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

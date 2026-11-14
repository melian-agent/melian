import type { CheckRecord } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { DecisionIndexWarning } from "../src/decision-index.ts";

const long = "The decision log is long.";
const design = (status: CheckRecord["status"], error?: string): CheckRecord => ({
	name: "lens.design",
	status,
	...(error === undefined ? {} : { error }),
});
const overflow = "tried a; the last said: prompt is too long: 250000 tokens > 200000 maximum";

describe("the decision index warning a review gives", () => {
	it("gives the pipeline's warning as it stands when no reader overflowed", () => {
		expect(DecisionIndexWarning.from(long, [design("ran")])?.text).toBe(long);
	});

	it("gives no warning when the pipeline reported none, whatever failed", () => {
		expect(DecisionIndexWarning.from(undefined, [design("failed", overflow)])).toBeUndefined();
	});

	it.each([
		["the design lens", [design("failed", overflow)], "`lens.design`"],
		[
			"the verifier",
			[design("ran"), { name: "verifier", status: "failed", reason: overflow } as const],
			"`verifier`",
		],
		[
			"both",
			[design("failed", overflow), { name: "verifier", status: "failed", reason: overflow } as const],
			"`lens.design` and `verifier`",
		],
	])("says the index may be why %s failed on a request too long for its model", (_name, checks, named) => {
		expect(DecisionIndexWarning.from(long, checks)?.text).toBe(
			`${long} ${named} failed on a request too long for its model, which the decision index's size may explain.`,
		);
	});

	it.each([
		["a rate limit", [design("failed", "Rate limit: too many tokens per minute")]],
		["a failure that is not about length", [design("failed", "fetch failed")]],
		[
			"a lens that reads no index",
			[design("ran"), { name: "lens.tests", status: "failed", error: overflow } as const],
		],
		["a design lens its budget ended rather than a failure", [design("ended", overflow)]],
	])("names no failure for %s", (_name, checks) => {
		expect(DecisionIndexWarning.from(long, checks)?.text).toBe(long);
	});

	it("reads a failed lens's error, as a lens records its failure, before its reason", () => {
		const checks = [{ ...design("failed", overflow), reason: "the lens did not finish" }];
		expect(DecisionIndexWarning.from(long, checks)?.text).toContain("`lens.design` failed on a request");
	});
});

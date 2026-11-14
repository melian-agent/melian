import type { CheckRecord } from "@melian-agent/core";
import { DecisionFiles } from "@melian-agent/decisions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commit, createRepository, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import { DecisionIndexWarning } from "../src/decision-index.ts";

let repo: string;
let long: string;
let short: string;
let broken: string;
beforeEach(() => {
	repo = createRepository();
	short = commit(repo, { "docs/decisions/2026-10-01-a.md": "# A\n" });
	long = commit(repo, { "docs/decisions/2026-10-01-a.md": `# ${"x".repeat(70_000)}\n` });
	broken = commit(repo, { "docs/decisions/2026-10-02-b.md": "# B\nSupersedes: 2026-10-09-absent.md\n" });
});
afterEach(() => removeRepository(repo));

const design = (status: CheckRecord["status"], error?: string): CheckRecord => ({
	name: "lens.design",
	status,
	...(error === undefined ? {} : { error }),
});
const overflow = "tried a; the last said: prompt is too long: 250000 tokens > 200000 maximum";

describe("the decision index warning a review gives", () => {
	it.each(["ran", "failed", "ended"] as const)("warns for a long index when the design lens %s", async (status) => {
		const warning = await DecisionIndexWarning.read(repo, long, [design(status)]);
		expect(warning?.text).toBe((await DecisionFiles.load(repo, long)).warning());
	});

	it.each([
		["the design lens was skipped", [design("skipped")]],
		["no design lens ran", [{ name: "lens.tests", status: "ran" } as const]],
	])("gives no warning for a long index when %s, since the review read no index", async (_name, checks) => {
		expect(await DecisionIndexWarning.read(repo, long, checks)).toBeUndefined();
	});

	it("gives no warning for an index under the threshold", async () => {
		expect(await DecisionIndexWarning.read(repo, short, [design("ran")])).toBeUndefined();
	});

	it("gives no warning, and refuses nothing, when the decisions cannot be read", async () => {
		expect(await DecisionIndexWarning.read(repo, broken, [design("ran")])).toBeUndefined();
	});

	it.each([
		["the design lens", [design("failed", overflow)], "`lens.design`"],
		[
			"the verifier",
			[design("ran"), { name: "verifier", status: "failed", reason: overflow } as const],
			"`verifier`",
		],
	])("says the index may be why %s failed on a request too long for its model", async (_name, checks, named) => {
		const warning = await DecisionIndexWarning.read(repo, long, checks);
		expect(warning?.text).toBe(
			`${(await DecisionFiles.load(repo, long)).warning()} ${named} failed on a request too long for its model, which the decision index's size may explain.`,
		);
	});

	it.each([
		["a rate limit", "Rate limit: too many tokens per minute"],
		["a failure that is not about length", "fetch failed"],
	])("names no failure for %s", async (_name, error) => {
		const warning = await DecisionIndexWarning.read(repo, long, [design("failed", error)]);
		expect(warning?.text).toBe((await DecisionFiles.load(repo, long)).warning());
	});

	it("names no overflow when the index is under the threshold", async () => {
		expect(await DecisionIndexWarning.read(repo, short, [design("failed", overflow)])).toBeUndefined();
	});
});

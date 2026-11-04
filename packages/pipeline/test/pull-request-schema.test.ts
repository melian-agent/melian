import { expect, it } from "vitest";

it("loads a versioned membership storage schema before opening a repository", async () => {
	const { PullRequestRoundsDocument } = await import("../src/pull-request-rounds.ts");
	expect(PullRequestRoundsDocument.definition.kind).toBe("melian.pull-request-rounds");
	expect(PullRequestRoundsDocument.definition.version).toBe(1);
});

import { expect, it } from "vitest";
import { type AdjudicationTaskInput, adjudicationKey } from "../src/adjudication.ts";

const input = (resolution: Record<string, unknown>) =>
	({ revision: "a..b", config: { resolution }, checks: [], run: null }) as unknown as AdjudicationTaskInput;

// Two hosts that build one input in different orders must attach to one adjudication.
it("keys equal inputs whose properties were inserted in different orders as one", () => {
	const first = input({ severity: { P1: "block" }, ceiling: "P2" });
	const second = input({ ceiling: "P2", severity: { P1: "block" } });

	expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
	expect(adjudicationKey(first)).toBe(adjudicationKey(second));
	expect(adjudicationKey(input({ severity: { P1: "block" }, ceiling: "P3" }))).not.toBe(adjudicationKey(first));
});

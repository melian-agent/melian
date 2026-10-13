import { describe, expect, it } from "vitest";
import { shownOutput, verdictLabel } from "../src/live-output.ts";

describe("verdictLabel", () => {
	it("prints the verdict, or unjudged with the reason the verifier check recorded", () => {
		expect(verdictLabel("confirmed", undefined)).toBe("confirmed");
		expect(verdictLabel("refuted", "ignored")).toBe("refuted");
		expect(verdictLabel(undefined, "Codex error: overloaded")).toBe("unjudged (Codex error: overloaded)");
		expect(verdictLabel(undefined, undefined)).toBe("unjudged (no reason recorded)");
	});
});

describe("shownOutput", () => {
	it("prints nothing unless MELIAN_EVAL_SHOW is exactly 1", () => {
		for (const env of [{}, { MELIAN_EVAL_SHOW: "" }, { MELIAN_EVAL_SHOW: "0" }, { MELIAN_EVAL_SHOW: "true" }]) {
			expect(shownOutput("Verdict: findings\n", env)).toEqual([]);
		}
	});
	it("indents each line of the rendering and keeps blank lines empty", () => {
		expect(shownOutput("Verdict: findings\n\n  P1  line 5\n\n", { MELIAN_EVAL_SHOW: "1" })).toEqual([
			"    Verdict: findings",
			"",
			"      P1  line 5",
		]);
	});
});

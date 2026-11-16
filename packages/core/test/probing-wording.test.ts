import { lensProbingWording } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const fields = ["earlierSome", "findings", "judge", "plannerPlan", "probes", "recordPlan"];

describe("each lens's probing wording", () => {
	it("gives each lens that may probe all six strings, none blank and none another lens's", () => {
		expect([...lensProbingWording.keys()]).toEqual(["trust-boundary", "tests", "correctness"]);
		for (const [lens, wording] of lensProbingWording) {
			expect(Object.keys(wording).sort(), lens).toEqual(fields);
			for (const field of fields) {
				const text: unknown = wording[field as keyof typeof wording];
				expect(typeof text === "string" && text.trim() !== "", `${lens}.${field}`).toBe(true);
				for (const [other, theirs] of lensProbingWording)
					if (other !== lens) expect(theirs[field as keyof typeof theirs], `${lens}.${field}`).not.toBe(text);
			}
		}
	});

	it("counts a throw as a correctness defect only for an input the code accepts, never for one it refuses", () => {
		const correctness = lensProbingWording.get("correctness");
		for (const field of ["plannerPlan", "probes", "findings", "judge"] as const)
			expect(correctness?.[field], field).not.toMatch(
				/(returns? the wrong result|returns a wrong result) or throws?\b/,
			);
		for (const field of ["plannerPlan", "probes", "judge"] as const)
			expect(correctness?.[field], field).toContain("refuses an input it does not accept");
	});

	it("lets a correctness attack name a sequence of calls and the state it must leave, not only a result or a throw", () => {
		const correctness = lensProbingWording.get("correctness");
		for (const field of ["plannerPlan", "earlierSome", "probes", "judge"] as const) {
			expect(correctness?.[field], field).toContain("sequence of calls");
			expect(correctness?.[field], field).toMatch(/state it (leaves|must leave)/);
		}
	});

	it("names no boundary, nothing untrusted and no hostile input in the words of a lens that is not about them", () => {
		for (const lens of ["tests", "correctness"])
			expect(JSON.stringify(lensProbingWording.get(lens)), lens).not.toMatch(/boundary|untrusted|hostile/i);
	});
});

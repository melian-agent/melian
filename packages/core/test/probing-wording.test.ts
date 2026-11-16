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

	it("names no boundary, nothing untrusted and no hostile input in the words of a lens that is not about them", () => {
		for (const lens of ["tests", "correctness"])
			expect(JSON.stringify(lensProbingWording.get(lens)), lens).not.toMatch(/boundary|untrusted|hostile/i);
	});
});

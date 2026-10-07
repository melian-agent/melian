import { expect, it } from "vitest";
import { total } from "../src/total.ts";

it("adds prices", () => {
	expect(total([1, 2, 3])).toBe(6);
});

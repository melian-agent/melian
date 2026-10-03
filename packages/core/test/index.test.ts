import { packageName } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

describe("workspace", () => {
	it("resolves packages from source", () => {
		expect(packageName).toBe("@melian-agent/core");
	});
});

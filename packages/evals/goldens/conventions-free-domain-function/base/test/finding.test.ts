import assert from "node:assert/strict";
import { test } from "node:test";
import { Finding } from "../src/finding.ts";

test("an error blocks a merge and a warning does not", () => {
	assert.equal(new Finding("no-eval", "error", "src/run.ts", 12).blocks(), true);
	assert.equal(new Finding("no-console", "warning", "src/run.ts", 3).blocks(), false);
});

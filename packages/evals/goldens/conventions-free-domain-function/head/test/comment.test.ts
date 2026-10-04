import assert from "node:assert/strict";
import { test } from "node:test";
import { commentLine } from "../src/comment.ts";
import { Finding } from "../src/finding.ts";

test("links a finding to its line in the repository", () => {
	const finding = new Finding("no-eval", "error", "src/run.ts", 12);
	assert.equal(
		commentLine(finding, "https://github.com/triage-app/triage"),
		"error no-eval at https://github.com/triage-app/triage/blob/main/src/run.ts#L12",
	);
});

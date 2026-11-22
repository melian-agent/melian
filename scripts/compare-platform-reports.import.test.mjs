import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";

// Kept apart from the script's other tests, which import it: a script that ran its command on import would end their
// file before any test could fail.
it("runs nothing when another module imports it", () => {
	const script = join(import.meta.dirname, "compare-platform-reports.mjs");
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", `await import(${JSON.stringify(script)})`],
		{
			encoding: "utf8",
		},
	);
	expect([result.status, result.stdout, result.stderr]).toEqual([0, "", ""]);
});

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { JsonObject } from "../src/harness.ts";
import { SummaryTask } from "../src/summarize.ts";
import { VerificationTask } from "../src/verification.ts";

it.each([
	["melian.summarize", SummaryTask],
	["melian.verification", VerificationTask],
] as const)("preserves the captured version-1 %s input and checkpoint directly", (kind, task) => {
	const fixture = JSON.parse(
		readFileSync(new URL("./fixtures/thinking-main/recorded.json", import.meta.url), "utf8"),
	) as {
		tasks: { kind: string; version: number; input: JsonObject; initial: JsonObject }[];
	};
	const stored = fixture.tasks.find((record) => record.kind === kind)!;
	expect(stored.version).toBe(1);
	expect(task.definition.migrate!(stored.input, stored.initial, stored.version)).toEqual({
		input: stored.input,
		checkpoint: stored.initial,
	});
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
	readFileSync(fileURLToPath(new URL("../.github/workflows/melian-round.yml", import.meta.url)), "utf8"),
);
const steps = Object.entries(workflow.jobs).flatMap(([job, { steps }]) => steps.map((step) => ({ job, ...step })));

describe("the melian round workflow", () => {
	it("uploads only the public files, and writes no job summary", () => {
		const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
		expect(uploads.map((step) => step.with.path)).toEqual(["${{ runner.temp }}/public"]);
		expect(steps.filter((step) => JSON.stringify(step).includes("GITHUB_STEP_SUMMARY"))).toEqual([]);
	});

	it("keeps no token in any checkout's git configuration", () => {
		const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
		expect(checkouts.map((step) => [step.job, step.with?.["persist-credentials"]])).toEqual([
			["gate", false],
			["round", false],
			["report", false],
		]);
	});
});

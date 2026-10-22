import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
	readFileSync(new URL("../../../.github/workflows/melian-review-group.yml", import.meta.url), "utf8"),
) as {
	on: unknown;
	permissions: unknown;
	jobs: Record<
		string,
		{
			"runs-on": string;
			"timeout-minutes": number;
			permissions?: unknown;
			if?: unknown;
			steps: Record<string, unknown>[];
		}
	>;
};

describe("merge-group workflow policy", () => {
	it("20: runs only checks_requested merge groups with the three required permissions", () => {
		expect(workflow.on).toEqual({ merge_group: { types: ["checks_requested"] } });
		expect(workflow.permissions).toEqual({ contents: "read", statuses: "write", "pull-requests": "read" });
		expect(Object.keys(workflow.jobs)).toEqual(["copy-review"]);
		const job = workflow.jobs["copy-review"]!;
		expect(job["runs-on"]).toBe("ubuntu-latest");
		expect(job["timeout-minutes"]).toBe(5);
		expect(job.permissions).toBeUndefined();
		expect(job.if).toBeUndefined();
		expect(job.steps).toEqual([
			{
				uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
				with: {
					ref: `\${{ github.event.merge_group.base_sha }}`,
					"fetch-depth": 0,
					"persist-credentials": false,
				},
			},
			{
				uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
				with: { "node-version": 24, cache: "npm" },
			},
			{ run: "npm ci" },
			{
				run: 'node packages/cli/bin/melian.js status merge-group --head "$MERGE_GROUP_HEAD" --base "$MERGE_GROUP_BASE"',
				env: {
					GITHUB_TOKEN: `\${{ github.token }}`,
					MERGE_GROUP_HEAD: `\${{ github.event.merge_group.head_sha }}`,
					MERGE_GROUP_BASE: `\${{ github.event.merge_group.base_sha }}`,
				},
			},
		]);
	});
});

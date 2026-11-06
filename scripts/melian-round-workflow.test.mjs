import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("sets up Node 24 in every job before a step runs node, at the round job's pin", () => {
		const setups = steps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
		expect(setups.map((step) => [step.job, step.uses, step.with["node-version"]])).toEqual(
			["gate", "round", "report"].map((job) => [
				job,
				"actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
				24,
			]),
		);
		for (const [job, { steps: jobSteps }] of Object.entries(workflow.jobs)) {
			const setup = jobSteps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
			const first = jobSteps.findIndex((step) => /\bnode\b/.test(step.run ?? ""));
			expect([job, setup < first], job).toEqual([job, true]);
		}
	});

	it("hands the nonce to the report in the artefact, never through a job output or a step's printed env", () => {
		expect(Object.keys(workflow.jobs.round.outputs)).toEqual(["artifact"]);
		const printed = steps.filter((step) => /nonce/i.test(JSON.stringify(step.env ?? {})));
		expect(printed).toEqual([]);
		const drawn = workflow.jobs.round.steps.find((step) => step.id === "artifact");
		expect(drawn.run).toContain('openssl rand -hex 16 > "$RUNNER_TEMP/public/nonce"');
	});

	it("refuses, before any step holds a login, a commit the default branch has moved past", () => {
		const round = workflow.jobs.round.steps;
		const check = round.findIndex((step) => step.name === "Refuse a commit the default branch has moved past");
		const secret = round.findIndex((step) => JSON.stringify(step).includes("secrets."));
		expect(check).toBeGreaterThanOrEqual(0);
		expect(check).toBeLessThan(secret);
		expect(round.slice(0, check + 1).filter((step) => JSON.stringify(step).includes("secrets."))).toEqual([]);
		expect(round[check].env).toEqual({
			GH_TOKEN: "${{ github.token }}",
			REPOSITORY: "${{ github.repository }}",
			DEFAULT: "${{ github.event.repository.default_branch }}",
			SHA: "${{ github.sha }}",
		});
		expect(round[check].run).toContain('gh api "repos/$REPOSITORY/branches/$DEFAULT" --jq .commit.sha');
		expect(round[check].run).toContain('if [ "$current" != "$SHA" ]; then');
	});

	it("lets the round run only on the default branch's current commit", () => {
		const { run } = workflow.jobs.round.steps.find(
			(step) => step.name === "Refuse a commit the default branch has moved past",
		);
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			// A fake gh answers only the request for the default branch's commit.
			writeFileSync(
				join(dir, "gh"),
				'#!/bin/sh\n[ "$*" = "api repos/o/r/branches/main --jq .commit.sha" ] && [ -n "$CURRENT" ] && echo "$CURRENT"\n',
			);
			chmodSync(join(dir, "gh"), 0o755);
			const step = (current) =>
				spawnSync("bash", ["-e", "-c", run], {
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						REPOSITORY: "o/r",
						DEFAULT: "main",
						SHA: "a".repeat(40),
						CURRENT: current,
					},
				});
			expect(step("a".repeat(40)).status).toBe(0);
			const moved = step("b".repeat(40));
			expect([moved.status, moved.stdout]).toEqual([
				1,
				`::error::the default branch is at ${"b".repeat(40)}, not ${"a".repeat(40)}, which this run would build; start a new round\n`,
			]);
			const unread = step("");
			expect([unread.status, unread.stdout]).toEqual([
				1,
				`::error::the default branch is at an unreadable commit, not ${"a".repeat(40)}, which this run would build; start a new round\n`,
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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

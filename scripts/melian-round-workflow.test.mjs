import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// An Actions expression, `${{ ... }}`, as the workflow file spells it.
const actions = (expression) => `\${{ ${expression} }}`;
const workflow = parse(
	readFileSync(fileURLToPath(new URL("../.github/workflows/melian-round.yml", import.meta.url)), "utf8"),
);
const steps = Object.entries(workflow.jobs).flatMap(([job, { steps }]) => steps.map((step) => ({ job, ...step })));

describe("the melian round workflow", () => {
	it("uploads only the public files, and writes no job summary", () => {
		const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
		expect(uploads.map((step) => step.with.path)).toEqual([`${actions("runner.temp")}/public`]);
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
			GH_TOKEN: actions("github.token"),
			REPOSITORY: actions("github.repository"),
			REF: actions("github.ref"),
			SHA: actions("github.sha"),
		});
	});

	it("lets the round run only on the default branch's current commit", () => {
		const { run } = workflow.jobs.round.steps.find(
			(step) => step.name === "Refuse a commit the default branch has moved past",
		);
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			// A fake gh answers only the requests for the repository's default branch and a branch's commit. A branch that
			// was the default keeps the run's commit.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'if [ "$*" = "api repos/o/r --jq .default_branch" ]; then [ -n "$NOW" ] && echo "$NOW"; exit; fi',
					'[ "$NOW" != main ] && [ "$*" = "api repos/o/r/branches/main --jq .commit.sha" ] && echo "$SHA" && exit',
					'[ "$*" = "api repos/o/r/branches/$NOW --jq .commit.sha" ] && [ -n "$CURRENT" ] && echo "$CURRENT"',
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			const step = (current, branch = "main", ref = "refs/heads/main") =>
				spawnSync("bash", ["-e", "-c", run], {
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						REPOSITORY: "o/r",
						REF: ref,
						SHA: "a".repeat(40),
						// What the run's event named as the default branch; a rerun replays it whatever the repository says now.
						DEFAULT: "main",
						NOW: branch,
						CURRENT: current,
					},
				});
			expect(step("a".repeat(40)).status).toBe(0);
			const moved = step("b".repeat(40));
			expect([moved.status, moved.stdout]).toEqual([
				1,
				`::error::the default branch is at ${"b".repeat(40)}, not ${"a".repeat(40)}, which this run would build; start a new round\n`,
			]);
			const renamed = step("a".repeat(40), "trunk");
			expect([renamed.status, renamed.stdout]).toEqual([
				1,
				"::error::this run is from refs/heads/main, and the default branch is now trunk; start a new round\n",
			]);
			const movedTrunk = step("b".repeat(40), "trunk", "refs/heads/trunk");
			expect([movedTrunk.status, movedTrunk.stdout]).toEqual([
				1,
				`::error::the default branch is at ${"b".repeat(40)}, not ${"a".repeat(40)}, which this run would build; start a new round\n`,
			]);
			expect(step("a".repeat(40), "trunk", "refs/heads/trunk").status).toBe(0);
			const nameless = step("a".repeat(40), "");
			expect([nameless.status, nameless.stdout]).toEqual([
				1,
				"::error::this run is from refs/heads/main, and the default branch is now unreadable; start a new round\n",
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

	it("refuses a fork's head, a closed pull request, a base other than the default and an unreadable SHA", () => {
		const { run } = workflow.jobs.gate.steps.find((step) => step.id === "pull");
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			// A fake gh answers only the request for the pull request.
			writeFileSync(join(dir, "gh"), '#!/bin/sh\n[ "$*" = "api repos/o/r/pulls/7" ] && printf %s "$PULL"\n');
			chmodSync(join(dir, "gh"), 0o755);
			const head = "1".repeat(40);
			const base = "2".repeat(40);
			const pull = {
				state: "open",
				base: { ref: "main", sha: base },
				head: { sha: head, repo: { full_name: "o/r" } },
			};
			const gate = (overrides, defaultBranch = "main") => {
				writeFileSync(join(dir, "output"), "");
				const ran = spawnSync("bash", ["-e", "-c", run], {
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						HOME: dir,
						RUNNER_TEMP: dir,
						GITHUB_OUTPUT: join(dir, "output"),
						REPOSITORY: "o/r",
						NUMBER: "7",
						DEFAULT: defaultBranch,
						PULL: JSON.stringify({ ...pull, ...overrides }),
					},
				});
				return [ran.status, ran.stdout, readFileSync(join(dir, "output"), "utf8")];
			};
			expect(gate({})).toEqual([0, "", `head=${head}\nbase=${base}\n`]);
			const refused = (message) => [1, `::error::${message}\n`, ""];
			expect(gate({ head: { sha: head, repo: { full_name: "outsider/r" } } })).toEqual(
				refused("pull request 7's head is in outsider/r, not o/r; a fork's head never runs with secrets"),
			);
			expect(gate({ head: { sha: head, repo: null } })).toEqual(
				refused("pull request 7's head is in a deleted repository, not o/r; a fork's head never runs with secrets"),
			);
			expect(gate({ state: "closed" })).toEqual(refused("pull request 7 is closed"));
			const other = refused(
				"pull request 7 targets feature, not main; a round judges only a pull request into the default branch",
			);
			expect(gate({ base: { ref: "feature", sha: base } })).toEqual(other);
			expect(gate({}, "")).toEqual(
				refused("pull request 7 targets main, not ; a round judges only a pull request into the default branch"),
			);
			expect(gate({ base: { ref: "", sha: base } }, "")).toEqual(
				refused("pull request 7 targets , not ; a round judges only a pull request into the default branch"),
			);
			expect(gate({ head: { sha: `${head}0`, repo: { full_name: "o/r" } } })).toEqual(
				refused("unreadable head or base SHA"),
			);
			expect(gate({ base: { ref: "main", sha: base.slice(1) } })).toEqual(refused("unreadable head or base SHA"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs a head only when its pusher holds write, maintain or admin permission", () => {
		const { run } = workflow.jobs.gate.steps.find(
			(step) => step.name === "Refuse a head its pusher could not have written",
		);
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			const head = "1".repeat(40);
			// A fake gh answers only the request for the push events and the request for the pusher's permission.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'if [ "$1 $2 $3 $4" = "api --paginate repos/o/r/events?per_page=100 --jq" ]; then printf "%s\\n" "$EVENTS"; exit; fi',
					'[ "$*" = "api repos/o/r/collaborators/pusher-login/permission --jq .permission" ] && [ -n "$PERMISSION" ] && echo "$PERMISSION"',
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			writeFileSync(
				join(dir, "pull.json"),
				JSON.stringify({ head: { ref: "feature", sha: head }, user: { login: "author-login" } }),
			);
			const events = JSON.stringify({ actor: "pusher-login", head, ref: "refs/heads/feature" });
			const step = (permission) => {
				const ran = spawnSync("bash", ["-e", "-c", run], {
					cwd: fileURLToPath(new URL("..", import.meta.url)),
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						HOME: dir,
						RUNNER_TEMP: dir,
						REPOSITORY: "o/r",
						HEAD: head,
						EVENTS: events,
						PERMISSION: permission,
					},
				});
				return [ran.status, ran.stdout];
			};
			for (const permission of ["write", "maintain", "admin"]) {
				expect(step(permission), permission).toEqual([
					0,
					`pusher-login, whose code the head is, has ${permission} permission\n`,
				]);
			}
			for (const [permission, named] of [
				["read", "read"],
				["triage", "triage"],
				["none", "none"],
				["", "no known"],
			]) {
				expect(step(permission), permission).toEqual([
					1,
					`::error::pusher-login, whose code the head is, has ${named} permission; a round runs only a writer's head\n`,
				]);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses, before any step holds a login, a pull request that moved after the gate", () => {
		const round = workflow.jobs.round.steps;
		const check = round.findIndex((step) => step.name === "Refuse a pull request that moved after the gate");
		const secret = round.findIndex((step) => JSON.stringify(step).includes("secrets."));
		expect(check).toBeGreaterThanOrEqual(0);
		expect(check).toBeLessThan(secret);
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			const base = "2".repeat(40);
			const head = "1".repeat(40);
			// A fake gh answers only the request for the pull request's base and head.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'[ "$*" = "api repos/o/r/pulls/7 --jq .base.sha + \\" \\" + .head.sha" ] && [ -n "$NOW" ] && echo "$NOW"',
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			const step = (now) => {
				rmSync(join(dir, "public"), { recursive: true, force: true });
				const ran = spawnSync("bash", ["-e", "-c", round[check].run], {
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						HOME: dir,
						RUNNER_TEMP: dir,
						REPOSITORY: "o/r",
						NUMBER: "7",
						BASE: base,
						HEAD: head,
						NOW: now,
					},
				});
				let exit;
				try {
					exit = readFileSync(join(dir, "public", "exit"), "utf8");
				} catch {
					exit = undefined;
				}
				return [ran.status, ran.stdout, exit];
			};
			expect(step(`${base} ${head}`)).toEqual([0, "", undefined]);
			const moved = "3".repeat(40);
			expect(step(`${base} ${moved}`)).toEqual([
				1,
				`::error::pull request 7 moved from ${base} ${head} to ${base} ${moved} after the gate\n`,
				"none\n",
			]);
			expect(step("")).toEqual([
				1,
				`::error::pull request 7 moved from ${base} ${head} to an unreadable revision after the gate\n`,
				"none\n",
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

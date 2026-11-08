import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
			if (first >= 0) expect([job, setup >= 0 && setup < first], job).toEqual([job, true]);
		}
	});

	it("hands the nonce to the report in the artefact, never through a job output or a step's printed env", () => {
		expect(workflow.jobs.round.outputs).toEqual({
			artifact: actions("steps.artifact.outputs.name"),
			checked: actions("steps.checked.outputs.sha"),
		});
		const printed = steps.filter((step) => /nonce/i.test(JSON.stringify(step.env ?? {})));
		expect(printed).toEqual([]);
		const drawn = workflow.jobs.round.steps.find((step) => step.id === "artifact");
		expect(drawn.run).toContain('openssl rand -hex 16 > "$RUNNER_TEMP/public/nonce"');
		// The pending job hands the report the ID of the status it set, as a job output a report-only rerun keeps.
		expect(workflow.jobs.pending.outputs).toEqual({ status: actions("steps.post.outputs.id") });
		expect(workflow.jobs.report.needs).toEqual(["gate", "pending", "round"]);
		// The status step reads the pull request's base policy, so the report job's checkout holds the history.
		const checkout = workflow.jobs.report.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
		expect(checkout.with).toEqual({ "fetch-depth": 0, "persist-credentials": false });
		// The trust read loads core's configuration, whose packages a fresh runner does not have.
		const report = workflow.jobs.report.steps;
		const install = report.findIndex((step) => step.run === "npm ci --ignore-scripts");
		expect(install).toBeGreaterThan(report.findIndex((step) => step.uses?.startsWith("actions/setup-node@")));
		expect(install).toBeLessThan(report.findIndex((step) => step.name === "Set melian/review on the reviewed head"));
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

	it("refuses, in the pending job before anything else, the commit the round job refuses, and in the report job a rerun's", () => {
		const name = "Refuse a commit the default branch has moved past";
		const roundCheck = workflow.jobs.round.steps.find((step) => step.name === name);
		expect(workflow.jobs.pending.steps[0]).toEqual(roundCheck);
		expect(workflow.jobs.report.steps[0]).toMatchObject({
			name: "Refuse a rerun on a commit the default branch has moved past",
			env: {
				...roundCheck.env,
				ATTEMPT: actions("github.run_attempt"),
				CHECKED: actions("needs.round.outputs.checked"),
			},
		});
		expect(Object.keys(workflow.jobs.report.steps[0].env)).toEqual([
			...Object.keys(roundCheck.env),
			"ATTEMPT",
			"CHECKED",
		]);
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
						// A first attempt, which the report job lets carry on after a move; pending and round must not.
						ATTEMPT: "1",
						GITHUB_RUN_ATTEMPT: "1",
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

	it("lets a first attempt's report run after the default branch moves, and refuses a rerun's", () => {
		const { run, env } = workflow.jobs.report.steps[0];
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
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
			const a = "a".repeat(40);
			const b = "b".repeat(40);
			const step = ({ attempt, current, branch = "main", ref = "refs/heads/main", checked = a }) => {
				const result = spawnSync("bash", ["-e", "-c", run], {
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						REPOSITORY: "o/r",
						REF: ref,
						SHA: a,
						ATTEMPT: attempt,
						CHECKED: checked,
						NOW: branch,
						CURRENT: current,
					},
				});
				return [result.status, result.stdout];
			};
			const refused = (message) => [1, `::error::${message}; start a new round\n`];
			expect(step({ attempt: "1", current: a })).toEqual([0, ""]);
			expect(step({ attempt: "1", current: b })).toEqual([0, ""]);
			expect(env.ATTEMPT).toBe(actions("github.run_attempt"));
			// A first attempt whose round never passed its own check, because pending refused the run or the round failed or
			// was skipped before it, carries on only if the default branch has not moved.
			for (const checked of ["", b]) {
				expect(step({ attempt: "1", current: b, checked })).toEqual(
					refused(`the default branch is at ${b}, not ${a}, and this run's round did not check ${a}`),
				);
				expect(step({ attempt: "1", current: a, checked })).toEqual([0, ""]);
			}
			expect(env.CHECKED).toBe(actions("needs.round.outputs.checked"));
			const round = workflow.jobs.round.steps;
			const check = round.findIndex((step) => step.name === "Refuse a commit the default branch has moved past");
			expect(round[check + 1]).toEqual({
				id: "checked",
				env: { SHA: actions("github.sha") },
				run: 'echo "sha=$SHA" >> "$GITHUB_OUTPUT"\n',
			});
			expect(workflow.jobs.round.outputs.checked).toBe(actions("steps.checked.outputs.sha"));
			expect(step({ attempt: "2", current: a })).toEqual([0, ""]);
			expect(step({ attempt: "2", current: b })).toEqual(
				refused(`the default branch is at ${b}, not ${a}, which this rerun would build`),
			);
			expect(step({ attempt: "10", current: b })).toEqual(
				refused(`the default branch is at ${b}, not ${a}, which this rerun would build`),
			);
			expect(step({ attempt: "1", current: a, branch: "trunk" })).toEqual(
				refused("this run is from refs/heads/main, and the default branch is now trunk"),
			);
			expect(step({ attempt: "1", current: a, branch: "" })).toEqual(
				refused("this run is from refs/heads/main, and the default branch is now unreadable"),
			);
			expect(step({ attempt: "1", current: "" })).toEqual(
				refused(`the default branch is at an unreadable commit, not ${a}, which this run would build`),
			);
			expect(step({ attempt: "1", current: "c".repeat(39) })).toEqual(
				refused(`the default branch is at an unreadable commit, not ${a}, which this run would build`),
			);
			expect(step({ attempt: "1", current: "c".repeat(41) })).toEqual(
				refused(`the default branch is at an unreadable commit, not ${a}, which this run would build`),
			);
			for (const attempt of ["", "0", "01", "1.5", "x", "1 ", "a[$(touch injected)]"]) {
				expect(step({ attempt, current: a })).toEqual(
					refused(`this run's attempt, ${attempt || "empty"}, is not a whole number above 0`),
				);
			}
			expect(readdirSync(process.cwd())).not.toContain("injected");
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

	it("refuses, in the gate before any job holds a login, an Environment another branch could deploy from", () => {
		const gate = workflow.jobs.gate.steps;
		const name = "Refuse an Environment whose logins another branch could reach";
		const { run, env } = gate.find((step) => step.name === name);
		expect(env).toEqual({
			GH_TOKEN: actions("github.token"),
			REPOSITORY: actions("github.repository"),
			DEFAULT: actions("github.event.repository.default_branch"),
		});
		expect(workflow.jobs.gate.permissions.actions).toBe("read");
		expect(gate.filter((step) => JSON.stringify(step).includes("secrets."))).toEqual([]);
		const holding = Object.entries(workflow.jobs).filter(([, job]) => JSON.stringify(job).includes("secrets."));
		expect(holding.map(([name, job]) => [name, [job.needs].flat().includes("gate")])).toEqual([
			["pending", true],
			["round", true],
			["report", true],
		]);
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			// A fake gh answers only the two requests for the Environment, running the step's own --jq over each raw
			// answer as gh does, page by page for the paginated one.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'if [ "$1 $2 $3" = "api repos/o/r/environments/melian-round --jq" ]; then printf "%s" "$POLICY" | jq -r "$4"; exit; fi',
					'[ "$1 $2 $3 $4" = "api --paginate repos/o/r/environments/melian-round/deployment-branch-policies?per_page=100 --jq" ] && [ -n "$BRANCHES" ] && printf "%s\\n" "$BRANCHES" | jq -r "$5"',
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			const custom = { protected_branches: false, custom_branch_policies: true };
			const pages = (...pages) => pages.map((page) => JSON.stringify({ branch_policies: page })).join("\n");
			const step = ({ policy = custom, branches = pages([{ name: "main", type: "branch" }]), branch = "main" }) => {
				const ran = spawnSync("bash", ["-e", "-c", run], {
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						HOME: dir,
						REPOSITORY: "o/r",
						DEFAULT: branch,
						POLICY: JSON.stringify({ name: "melian-round", deployment_branch_policy: policy }),
						BRANCHES: branches,
					},
				});
				return [ran.status, ran.stdout];
			};
			const passed = [0, "the melian-round Environment deploys from main alone\n"];
			expect(step({})).toEqual(passed);
			// A policy GitHub stored before branch policies had a type names none, and a branch is the default.
			expect(step({ branches: pages([{ name: "main" }]) })).toEqual(passed);
			const unlimited = [
				1,
				"::error::the melian-round Environment has no custom branch policy; its logins would reach every branch\n",
			];
			expect(step({ policy: null })).toEqual(unlimited);
			expect(step({ policy: { protected_branches: true, custom_branch_policies: false } })).toEqual(unlimited);
			expect(step({ policy: { protected_branches: false, custom_branch_policies: false } })).toEqual(unlimited);
			expect(step({ policy: { protected_branches: true, custom_branch_policies: true } })).toEqual(unlimited);
			const wider = [1, "::error::the melian-round Environment must deploy from main alone\n"];
			for (const branches of [
				pages([]),
				pages([{ name: "main", type: "branch" }], [{ name: "feature", type: "branch" }]),
				pages([{ name: "main*", type: "branch" }]),
				pages([{ name: "main", type: "tag" }]),
				pages([
					{ name: "main", type: "branch" },
					{ name: "main", type: "tag" },
				]),
			]) {
				expect(step({ branches }), branches).toEqual(wider);
			}
			expect(step({ branch: "trunk" })).toEqual([
				1,
				"::error::the melian-round Environment must deploy from trunk alone\n",
			]);
			expect(step({ branch: "" })[0]).toBe(1);
			// A read GitHub refuses fails the step.
			expect(step({ branches: "" })[0]).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a head another open pull request shares, since a status names a commit, not a pull request", () => {
		const { run, env } = workflow.jobs.gate.steps.find(
			(step) => step.name === "Refuse a head another open pull request shares",
		);
		expect(env).toEqual({
			GH_TOKEN: actions("github.token"),
			REPOSITORY: actions("github.repository"),
			NUMBER: actions("inputs.pull_request"),
			HEAD: actions("steps.pull.outputs.head"),
		});
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			const head = "1".repeat(40);
			// A fake gh answers only the listing of open pull requests, running the step's own --jq over each raw page.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'[ "$1 $2 $3 $4" = "api --paginate repos/o/r/pulls?state=open&per_page=100 --jq" ] && [ "$PULLS" != unreadable ] && printf "%s\\n" "$PULLS" | jq -r "$5" && exit 0',
					"exit 1",
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			const pull = (number, sha) => ({ number, head: { sha } });
			const pages = (...pages) => pages.map((page) => JSON.stringify(page)).join("\n");
			const step = (pulls) => {
				const ran = spawnSync("bash", ["-e", "-c", run], {
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						HOME: dir,
						REPOSITORY: "o/r",
						NUMBER: "7",
						HEAD: head,
						PULLS: pulls,
					},
				});
				return [ran.status, ran.stdout];
			};
			const alone = [0, `no other open pull request has head ${head}\n`];
			expect(step(pages([pull(7, head), pull(8, "2".repeat(40))]))).toEqual(alone);
			expect(step(pages([]))).toEqual(alone);
			expect(step(pages([pull(7, head)], [pull(9, head)]))).toEqual([
				1,
				`::error::pull request 9 has head ${head} too; a status names a commit, so neither can take a round's melian/review\n`,
			]);
			expect(step("unreadable")).toEqual([1, "::error::the open pull requests could not be read\n"]);
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
			// A fake gh answers only the request for the branch's activity, by running the step's own --jq over each raw
			// page as gh does, and the request for the pusher's permission.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'if [ "$1 $2 $3 $4 $5 $6 $7 $8 $9" = "api -X GET --paginate repos/o/r/activity -f ref=refs/heads/feature -f per_page=100" ]; then shift 9; [ "$#" = 2 ] && [ "$1" = --jq ] || exit 1; printf "%s\\n" "$EVENTS" | jq -r "$2"; exit; fi',
					'[ "$*" = "api repos/o/r/collaborators/pusher-login/permission --jq .permission" ] && [ -n "$PERMISSION" ] && echo "$PERMISSION"',
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			writeFileSync(
				join(dir, "pull.json"),
				JSON.stringify({ head: { ref: "feature", sha: head }, user: { login: "author-login" } }),
			);
			const entry = (activity_type, login, fields) => ({
				activity_type,
				actor: { login },
				ref: "refs/heads/feature",
				before: "0".repeat(40),
				after: "0".repeat(40),
				...fields,
			});
			// Two raw pages. Each decoy names the head through an entry the projection must not read: a merge, a branch
			// deletion, a push whose earlier commit is the head, and a push of the head to another branch.
			const pages = (pushed) =>
				[
					[
						entry("pr_merge", "merger-login", { after: head }),
						entry("merge_queue_merge", "queue-login", { after: head }),
						entry("branch_deletion", "deleter-login", { before: head, after: head }),
						entry("push", "before-login", { before: head, after: "2".repeat(40) }),
					],
					[entry("push", "other-branch-login", { after: head, ref: "refs/heads/other" }), pushed],
				]
					.map((page) => JSON.stringify(page))
					.join("\n");
			const events = pages(entry("push", "pusher-login", { after: head }));
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
			for (const activity of ["force_push", "branch_creation"]) {
				const ran = spawnSync("bash", ["-e", "-c", run], {
					cwd: fileURLToPath(new URL("..", import.meta.url)),
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						HOME: dir,
						RUNNER_TEMP: dir,
						REPOSITORY: "o/r",
						HEAD: head,
						EVENTS: pages(entry(activity, "pusher-login", { after: head })),
						PERMISSION: "write",
					},
				});
				expect([ran.status, ran.stdout], activity).toEqual([
					0,
					"pusher-login, whose code the head is, has write permission\n",
				]);
			}
			const unnamed = spawnSync("bash", ["-e", "-c", run], {
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				encoding: "utf8",
				env: {
					PATH: `${dir}:${process.env.PATH}`,
					HOME: dir,
					RUNNER_TEMP: dir,
					REPOSITORY: "o/r",
					HEAD: head,
					EVENTS: pages(entry("push", "pusher-login", { after: "3".repeat(40) })),
					PERMISSION: "write",
				},
			});
			expect([unnamed.status, unnamed.stdout, unnamed.stderr]).toEqual([
				1,
				"",
				"no push, force push or branch creation in the repository's activity left this head on this branch\n",
			]);
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

	it("uploads no file holding what a static tool printed, when Melian's output quotes a login", () => {
		const { run } = workflow.jobs.round.steps.find((step) => step.name === "Run the round");
		const probe = fileURLToPath(new URL("./fixtures/round-probe-verdict.json", import.meta.url));
		const token = "sk-probe-SECRET-123";
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			// A fake node answers only the step's three melian commands: review prints the probe's own output, in which
			// Biome quoted a file holding the token, on both streams, since Melian's errors can quote a tool too. Every
			// other script runs on the real Node.
			writeFileSync(
				join(dir, "node"),
				[
					"#!/bin/sh",
					'if [ "$1" = packages/cli/bin/melian.js ]; then',
					'  case "$2" in',
					'    review) [ "$*" = "packages/cli/bin/melian.js review #7 --json --no-walkthrough" ] && cat "$PROBE" && cat "$PROBE" >&2; exit 2 ;;',
					"    doctor|findings) exit 0 ;;",
					"  esac",
					"  exit 1",
					"fi",
					`exec "${process.execPath}" "$@"`,
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "node"), 0o755);
			const ran = spawnSync("bash", ["-e", "-c", run], {
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				encoding: "utf8",
				env: {
					PATH: `${dir}:${process.env.PATH}`,
					HOME: dir,
					RUNNER_TEMP: dir,
					NUMBER: "7",
					BASE: "2".repeat(40),
					HEAD: "1".repeat(40),
					PROBE: probe,
				},
			});
			expect(ran.status).toBe(0);
			expect(readFileSync(join(dir, "raw", "verdict.json"), "utf8")).toContain(token);
			const uploaded = readdirSync(join(dir, "public"));
			expect(uploaded).toContain("verdict.json");
			expect(uploaded.filter((name) => readFileSync(join(dir, "public", name), "utf8").includes(token))).toEqual([]);
			expect(readFileSync(join(dir, "public", "verdict.json"), "utf8")).toBe("null\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads the logins only in jobs of the melian-round Environment, which only main may deploy to", () => {
		const reading = Object.entries(workflow.jobs).filter(([, job]) =>
			/secrets\.(CLAUDE_CODE_OAUTH_TOKEN|CODEX_AUTH_B64)\b/.test(JSON.stringify(job)),
		);
		expect(reading.map(([name, job]) => [name, job.environment])).toEqual([["round", "melian-round"]]);
		expect(JSON.stringify(workflow).match(/\$\{\{\s*secrets\.\w+\s*\}\}/g)).toEqual([
			actions("secrets.MELIAN_STATUS_TOKEN"),
			actions("secrets.CLAUDE_CODE_OAUTH_TOKEN"),
			actions("secrets.CODEX_AUTH_B64"),
			actions("secrets.MELIAN_STATUS_TOKEN"),
			actions("secrets.MELIAN_STATUS_TOKEN"),
		]);
	});

	it("reads the status token only in the steps that set melian/review or post the round's comment, in jobs of the melian-round Environment", () => {
		const holding = steps.filter((step) => JSON.stringify(step).includes("secrets.MELIAN_STATUS_TOKEN"));
		expect(holding.map((step) => [step.job, step.name, step.env.STATUS_TOKEN])).toEqual([
			["pending", "Set melian/review to pending on the head", actions("secrets.MELIAN_STATUS_TOKEN")],
			["report", "Comment on the pull request", actions("secrets.MELIAN_STATUS_TOKEN")],
			["report", "Set melian/review on the reviewed head", actions("secrets.MELIAN_STATUS_TOKEN")],
		]);
		expect(workflow.jobs.report.steps.find((step) => step.name === "Comment on the pull request").env.GH_TOKEN).toBe(
			actions("github.token"),
		);
		expect(workflow.jobs.report.environment).toBe("melian-round");
		const { env } = workflow.jobs.report.steps.find((step) => step.name === "Set melian/review on the reviewed head");
		expect(env).toEqual({
			GH_TOKEN: actions("github.token"),
			STATUS_TOKEN: actions("secrets.MELIAN_STATUS_TOKEN"),
			REPOSITORY: actions("github.repository"),
			NUMBER: actions("inputs.pull_request"),
			BASE: actions("needs.gate.outputs.base"),
			HEAD: actions("needs.gate.outputs.head"),
			PENDING: actions("needs.pending.outputs.status"),
			PULL_URL: `${actions("github.server_url")}/${actions("github.repository")}/pull/${actions("inputs.pull_request")}`,
			RUN_URL: `${actions("github.server_url")}/${actions("github.repository")}/actions/runs/${actions("github.run_id")}`,
			RUN_ID: actions("github.run_id"),
		});
		// The job's own token only reads: melian-status-bot posts the comment, so nothing here posts as github-actions[bot].
		expect(workflow.jobs.report.permissions).toEqual({ contents: "read", "pull-requests": "read" });
	});

	it("sets melian/review on the head the gate approved and the round reviewed, from the round's verdict", () => {
		const { run } = workflow.jobs.report.steps.find((step) => step.name === "Set melian/review on the reviewed head");
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			// The base's policy lives in a repository of its own: one commit trusts writers by default, the next turns
			// trust off, as a root melian.yaml may.
			const policy = join(dir, "policy");
			mkdirSync(policy);
			const git = (...args) =>
				spawnSync("git", args, {
					cwd: policy,
					encoding: "utf8",
					env: {
						...process.env,
						GIT_AUTHOR_NAME: "t",
						GIT_AUTHOR_EMAIL: "t@t",
						GIT_COMMITTER_NAME: "t",
						GIT_COMMITTER_EMAIL: "t@t",
					},
				}).stdout.trim();
			git("init", "-q");
			writeFileSync(join(policy, "README.md"), "policy\n");
			git("add", "-A");
			git("commit", "-qm", "trusted");
			const base = git("rev-parse", "HEAD");
			writeFileSync(join(policy, "melian.yaml"), "trust:\n  writers: false\n");
			git("add", "-A");
			git("commit", "-qm", "untrusted");
			const untrusted = git("rev-parse", "HEAD");
			const head = "1".repeat(40);
			const mergeBase = "e".repeat(40);
			// A fake gh answers only the fresh read of the pull request, the head's statuses through the step's own
			// --jq, and the status post when it carries the status token, which it keeps.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'if [ "$*" = "api repos/o/r/pulls/7 --jq .base.sha + \\" \\" + .head.sha" ]; then [ -n "$NOW" ] && echo "$NOW"; exit; fi',
					'if [ "$1 $2 $3" = "api --paginate repos/o/r/commits/$HEAD/statuses?per_page=100" ] && [ "$4" = --jq ] && [ "$#" = 5 ]; then [ "$STATUSES" = unreadable ] && exit 1; printf "%s" "$STATUSES" | jq -r "$5"; exit; fi',
					'[ "$*" = "api -X POST repos/o/r/statuses/$HEAD --input -" ] && [ "$GH_TOKEN" = status-token ] && cat > "$POSTED" && exit 0',
					"exit 1",
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			const round = join(dir, "round");
			mkdirSync(round);
			const finding = (resolution) => ({
				ruleId: "no-eval",
				message: { text: "eval runs input" },
				locations: [],
				properties: { id: "0", severity: "P1", resolution, path: "a.ts", source: { check: "lens.security" } },
			});
			const posted = join(dir, "posted.json");
			// This round's own pending status, as the pending job set it and handed its ID on.
			const own = { id: 77, context: "melian/review", created_at: "2026-11-07T10:00:05Z", state: "pending" };
			const step = ({
				verdict = { status: "passed", blocking: false, findings: { block: [], acknowledge: [] }, notRun: [] },
				exit = "0",
				reviewed = { base: mergeBase, head },
				merged = mergeBase,
				at = base,
				now = `${at} ${head}`,
				token = "status-token",
				statuses = [own],
				pending = "77",
			}) => {
				rmSync(posted, { force: true });
				writeFileSync(join(round, "verdict.json"), typeof verdict === "string" ? verdict : JSON.stringify(verdict));
				writeFileSync(
					join(round, "rounds.json"),
					typeof reviewed === "string" ? reviewed : JSON.stringify([reviewed]),
				);
				writeFileSync(join(round, "exit"), `${exit}\n`);
				writeFileSync(join(round, "merge-base"), `${merged}\n`);
				const ran = spawnSync("bash", ["-e", "-c", run], {
					cwd: fileURLToPath(new URL("..", import.meta.url)),
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						HOME: dir,
						RUNNER_TEMP: dir,
						GITHUB_WORKSPACE: policy,
						GH_TOKEN: "workflow-token",
						STATUS_TOKEN: token,
						REPOSITORY: "o/r",
						NUMBER: "7",
						BASE: at,
						HEAD: head,
						PENDING: pending,
						PULL_URL: "https://github.com/o/r/pull/7",
						RUN_URL: "https://example.test/run",
						RUN_ID: "9",
						NOW: now,
						STATUSES: typeof statuses === "string" ? statuses : JSON.stringify(statuses),
						POSTED: posted,
					},
				});
				let status;
				try {
					status = JSON.parse(readFileSync(posted, "utf8"));
				} catch {
					status = undefined;
				}
				return { code: ran.status, stdout: ran.stdout, status };
			};
			const set = (state, description) => ({
				code: 0,
				stdout: `melian/review on ${head}: ${state}, ${description}\n`,
				status: { state, context: "melian/review", description, target_url: "https://github.com/o/r/pull/7" },
			});
			const suffix = `; base ${mergeBase}`;
			expect(step({})).toEqual(set("success", `Passed${suffix}`));
			const acknowledged = { status: "findings", blocking: false, notRun: [] };
			expect(
				step({
					verdict: {
						...acknowledged,
						findings: { block: [], acknowledge: [finding("acknowledge"), finding("acknowledge")] },
					},
					exit: "3",
				}),
			).toEqual(set("success", `Passed; 2 findings to acknowledge${suffix}`));
			expect(
				step({
					verdict: {
						status: "findings",
						blocking: true,
						findings: { block: [finding("block")], acknowledge: [finding("acknowledge")] },
						notRun: [],
					},
					exit: "1",
				}),
			).toEqual(set("failure", `Blocked by 1 finding${suffix}`));
			const skipped = [{ name: "lens.security", status: "failed" }];
			expect(
				step({
					verdict: {
						status: "not-reviewed",
						blocking: false,
						findings: { block: [], acknowledge: [] },
						notRun: skipped,
					},
					exit: "2",
				}),
			).toEqual(set("error", `Not reviewed: a check did not run${suffix}`));
			// A round that blocks and also missed a check is not reviewed, not blocked.
			expect(
				step({
					verdict: {
						status: "not-reviewed",
						blocking: true,
						findings: { block: [finding("block")], acknowledge: [] },
						notRun: skipped,
					},
					exit: "2",
				}),
			).toEqual(set("error", `Not reviewed: a check did not run${suffix}`));
			const unreadable = set("error", `Not reviewed: the round's verdict could not be read${suffix}`);
			expect(step({ verdict: "not json" })).toEqual(unreadable);
			expect(step({ exit: "3" })).toEqual(unreadable);
			const another = set("error", `Not reviewed: the round reviewed another revision${suffix}`);
			expect(step({ reviewed: { base: mergeBase, head: "2".repeat(40) } })).toEqual(another);
			expect(step({ reviewed: { base: "f".repeat(40), head } })).toEqual(another);
			expect(step({ reviewed: "not json" })).toEqual(another);
			// A merge base that is not exactly one full SHA sets no suffix, so the merge group could not copy it.
			for (const merged of ["none", `0${mergeBase}`, `${mergeBase}0`]) {
				expect(step({ merged, reviewed: { base: merged, head } }), merged).toEqual(
					set("error", "Not reviewed: the round reviewed another revision"),
				);
			}
			// The base's policy decides whether a writer's status counts, as it does for melian publish.
			const distrusted = set(
				"error",
				`Not reviewed here: writers are not trusted; a trusted host sets this status${suffix}`,
			);
			expect(step({ at: untrusted })).toEqual(distrusted);
			expect(step({ at: "a".repeat(40) })).toEqual(distrusted);
			// The round posts only while its own pending status is the head's latest melian/review, by ID, never by clock:
			// a status of any time that another writer set since is newer than this round.
			const newer = {
				code: 0,
				stdout:
					"a newer melian/review status stands on this head, so this round sets none; start a new round, since rerunning failed jobs keeps the old pending status\n",
				status: undefined,
			};
			const other = (id, context) => ({ id, context, created_at: "2026-11-07T09:00:00Z", state: "failure" });
			expect(step({ statuses: [other(78, "melian/review"), own] })).toEqual(newer);
			// GitHub lists a commit's statuses newest first, so the first melian/review is the latest.
			expect(step({ statuses: [other(78, "melian/review"), other(76, "melian/review")] })).toEqual(newer);
			expect(step({ statuses: [other(99, "ci"), own, other(76, "melian/review")] })).toEqual(
				set("success", `Passed${suffix}`),
			);
			// With this round's pending status on the head, a read that fails posts nothing: pending already blocks, and a
			// newer status another writer set must stand.
			const stands = (why) => ({
				code: 0,
				stdout: `${why}, so this round's pending status stands; start a new round\n`,
				status: undefined,
			});
			const unread = stands("the head's statuses could not be read");
			expect(step({ statuses: "unreadable" })).toEqual(unread);
			expect(step({ statuses: [] })).toEqual(unread);
			expect(step({ statuses: [other(99, "ci")] })).toEqual(unread);
			expect(step({ now: "" })).toEqual(stands("the pull request could not be read again"));
			// Without a pending status the job handed on, an earlier success could still stand, so the round sets error.
			const unknown = set("error", `Not reviewed: no pending status from this round${suffix}`);
			for (const pending of ["", "x77", "77x"]) expect(step({ pending }), pending).toEqual(unknown);
			expect(step({ pending: "", now: "" })).toEqual(unknown);
			const none = {
				code: 0,
				stdout: "the pull request moved during the round, so no melian/review status is set; start a new round\n",
				status: undefined,
			};
			expect(step({ now: `${base} ${"3".repeat(40)}` })).toEqual(none);
			expect(step({ now: `${"c".repeat(40)} ${head}` })).toEqual(none);
			expect(step({ token: "" })).toEqual({
				code: 1,
				stdout: "::error::the melian-round Environment holds no MELIAN_STATUS_TOKEN\n",
				status: undefined,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("sets melian/review to pending on the gate's head before the round job starts, in a job of the Environment", () => {
		const { pending, round } = workflow.jobs;
		expect(pending.needs).toBe("gate");
		expect(pending.environment).toBe("melian-round");
		expect(pending.permissions).toEqual({ contents: "read" });
		expect(round.needs).toEqual(["gate", "pending"]);
		expect(pending.steps.map((step) => step.name)).toEqual([
			"Refuse a commit the default branch has moved past",
			"Set melian/review to pending on the head",
		]);
		const [, { run, env }] = pending.steps;
		expect(env).toEqual({
			STATUS_TOKEN: actions("secrets.MELIAN_STATUS_TOKEN"),
			REPOSITORY: actions("github.repository"),
			HEAD: actions("needs.gate.outputs.head"),
			PULL_URL: `${actions("github.server_url")}/${actions("github.repository")}/pull/${actions("inputs.pull_request")}`,
		});
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			const head = "1".repeat(40);
			// A fake gh answers only the status post when it carries the status token, which it keeps.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'[ "$*" = "api -X POST repos/o/r/statuses/$HEAD --input - --jq .id" ] && [ "$GH_TOKEN" = status-token ] && cat > "$POSTED" && echo "$ID" && exit 0',
					"exit 1",
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			const posted = join(dir, "posted.json");
			const output = join(dir, "output");
			const step = (token, id = "4242") => {
				rmSync(output, { force: true });
				rmSync(posted, { force: true });
				const ran = spawnSync("bash", ["-e", "-c", run], {
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						HOME: dir,
						STATUS_TOKEN: token,
						REPOSITORY: "o/r",
						HEAD: head,
						PULL_URL: "https://github.com/o/r/pull/7",
						POSTED: posted,
						ID: id,
						GITHUB_OUTPUT: output,
					},
				});
				let status;
				try {
					status = JSON.parse(readFileSync(posted, "utf8"));
				} catch {
					status = undefined;
				}
				let handed;
				try {
					handed = readFileSync(output, "utf8");
				} catch {
					handed = undefined;
				}
				return { code: ran.status, stdout: ran.stdout, status, handed };
			};
			expect(step("status-token", "")).toMatchObject({
				code: 1,
				stdout: "::error::GitHub returned no ID for the pending status\n",
				handed: undefined,
			});
			expect(step("status-token")).toEqual({
				code: 0,
				handed: "id=4242\n",
				stdout: `melian/review on ${head}: pending, status 4242\n`,
				status: {
					state: "pending",
					context: "melian/review",
					description: "A Melian round is reviewing this head",
					target_url: "https://github.com/o/r/pull/7",
				},
			});
			expect(step("")).toEqual({
				code: 1,
				stdout: "::error::the melian-round Environment holds no MELIAN_STATUS_TOKEN\n",
				status: undefined,
				handed: undefined,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("posts the moved notice when the pull request moved during the round, from a fresh read", () => {
		const { run } = workflow.jobs.report.steps.find((step) => step.name === "Comment on the pull request");
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			const base = "b".repeat(40);
			const head = "1".repeat(40);
			const mergeBase = "e".repeat(40);
			// A fake gh answers only the fresh read of the pull request, the comment listing, and the post with the status token,
			// which it keeps.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'if [ "$*" = "api repos/o/r/pulls/7 --jq .base.sha + \\" \\" + .head.sha" ]; then [ -n "$NOW" ] && echo "$NOW"; exit; fi',
					'[ "$1 $2 $3" = "api --paginate repos/o/r/issues/7/comments?per_page=100" ] && exit 0',
					'[ "$1 $2 $3 $4 $5" = "api -X POST repos/o/r/issues/7/comments -F" ] && [ "$GH_TOKEN" = status-token ] && cp "$(printf %s "$6" | sed s/^body=@//)" "$POSTED" && exit 0',
					"exit 1",
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			const round = join(dir, "round");
			mkdirSync(round);
			const verdict = { status: "passed", blocking: false, findings: { block: [], acknowledge: [] }, notRun: [] };
			writeFileSync(join(round, "verdict.json"), JSON.stringify(verdict));
			writeFileSync(join(round, "rounds.json"), JSON.stringify([{ base: mergeBase, head }]));
			writeFileSync(join(round, "exit"), "0\n");
			writeFileSync(join(round, "merge-base"), `${mergeBase}\n`);
			writeFileSync(join(round, "nonce"), "0123456789abcdef0123456789abcdef\n");
			const posted = join(dir, "posted.md");
			const step = (now) => {
				rmSync(posted, { force: true });
				const ran = spawnSync("bash", ["-e", "-c", run], {
					cwd: fileURLToPath(new URL("..", import.meta.url)),
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						HOME: dir,
						RUNNER_TEMP: dir,
						REPOSITORY: "o/r",
						NUMBER: "7",
						BASE: base,
						HEAD: head,
						RUN_URL: "https://example.test/run",
						RUN_ID: "9",
						NOW: now,
						POSTED: posted,
						STATUS_TOKEN: "status-token",
					},
				});
				expect(ran.status, ran.stderr).toBe(0);
				return readFileSync(posted, "utf8").split("\n").slice(1).join("\n");
			};
			const opening = "Melian round on `bbbbbbbbbbbb`...`111111111111`, exit 0: [run](https://example.test/run)\n\n";
			expect(step(`${base} ${head}`)).toBe(
				`${opening}\`\`\`text\nVerdict: passed\n\nNo findings above advisory.\n\`\`\`\n`,
			);
			expect(step(`${base} ${"3".repeat(40)}`)).toBe(
				`${opening}The pull request moved to \`bbbbbbbbbbbb\`...\`333333333333\` during the round, so this round posts no findings. Start a new round.\n`,
			);
			expect(step("")).toBe(
				`${opening}The pull request could not be read again before posting, so this round posts no findings. Start a new round.\n`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("edits the comment this run already posted rather than post a second", () => {
		const { run } = workflow.jobs.report.steps.find((step) => step.name === "Comment on the pull request");
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			const base = "b".repeat(40);
			const head = "1".repeat(40);
			const nonce = "0123456789abcdef0123456789abcdef";
			const actions = { login: "github-actions[bot]", id: 41898282 };
			const comments = [
				{ id: 54, user: actions, body: `<!-- melian-round run:8 nonce:${nonce} -->\nan earlier run` },
				{ id: 55, user: actions, body: `<!-- melian-round run:9 nonce:${nonce} -->\nany workflow` },
				{
					id: 56,
					user: { login: "melian-status-bot", id: 353727783 },
					body: `<!-- melian-round run:9 nonce:${nonce} -->\nthis run`,
				},
			];
			// A fake gh answers only the fresh read, the listing, which holds this run's comment, and an edit of comment 56
			// with the status token.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'if [ "$*" = "api repos/o/r/pulls/7 --jq .base.sha + \\" \\" + .head.sha" ]; then echo "$NOW"; exit; fi',
					'[ "$1 $2 $3 $4" = "api --paginate repos/o/r/issues/7/comments?per_page=100 --jq" ] && printf "%s" "$COMMENTS" | jq -r "$5" && exit 0',
					'[ "$1 $2 $3 $4 $5" = "api -X PATCH repos/o/r/issues/comments/56 -F" ] && [ "$GH_TOKEN" = status-token ] && cp "$(printf %s "$6" | sed s/^body=@//)" "$EDITED" && exit 0',
					"exit 1",
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			const round = join(dir, "round");
			mkdirSync(round);
			writeFileSync(
				join(round, "verdict.json"),
				JSON.stringify({ status: "passed", blocking: false, findings: { block: [], acknowledge: [] }, notRun: [] }),
			);
			writeFileSync(join(round, "rounds.json"), JSON.stringify([{ base: "e".repeat(40), head }]));
			writeFileSync(join(round, "exit"), "0\n");
			writeFileSync(join(round, "merge-base"), `${"e".repeat(40)}\n`);
			writeFileSync(join(round, "nonce"), `${nonce}\n`);
			const ran = spawnSync("bash", ["-e", "-c", run], {
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				encoding: "utf8",
				env: {
					PATH: `${dir}:${process.env.PATH}`,
					HOME: dir,
					RUNNER_TEMP: dir,
					REPOSITORY: "o/r",
					NUMBER: "7",
					BASE: base,
					HEAD: head,
					RUN_URL: "https://example.test/run",
					RUN_ID: "9",
					NOW: `${base} ${head}`,
					COMMENTS: JSON.stringify(comments),
					EDITED: join(dir, "edited.md"),
					STATUS_TOKEN: "status-token",
				},
			});
			expect([ran.status, ran.stderr]).toEqual([0, ""]);
			expect(readFileSync(join(dir, "edited.md"), "utf8")).toBe(readFileSync(join(dir, "comment.md"), "utf8"));
			expect(readFileSync(join(dir, "edited.md"), "utf8")).toMatch(
				new RegExp(`^<!-- melian-round run:9 nonce:${nonce} -->\nMelian round on `),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("posts as melian-status-bot alone: it overwrites no other login's comment, and posts nothing without the token", () => {
		const { run } = workflow.jobs.report.steps.find((step) => step.name === "Comment on the pull request");
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			const base = "b".repeat(40);
			const head = "1".repeat(40);
			const nonce = "0123456789abcdef0123456789abcdef";
			// A fake gh answers the fresh read and the listing, and logs every write it is asked for with the token it saw.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'if [ "$*" = "api repos/o/r/pulls/7 --jq .base.sha + \\" \\" + .head.sha" ]; then echo "$NOW"; exit; fi',
					'[ "$1 $2 $3 $4" = "api --paginate repos/o/r/issues/7/comments?per_page=100 --jq" ] && printf "%s" "$COMMENTS" | jq -r "$5" && exit 0',
					'[ "$1 $2" = "api -X" ] && echo "$3 $4 $GH_TOKEN" >> "$WRITES" && exit 0',
					"exit 1",
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			const round = join(dir, "round");
			mkdirSync(round);
			writeFileSync(
				join(round, "verdict.json"),
				JSON.stringify({ status: "passed", blocking: false, findings: { block: [], acknowledge: [] }, notRun: [] }),
			);
			writeFileSync(join(round, "rounds.json"), JSON.stringify([{ base: "e".repeat(40), head }]));
			writeFileSync(join(round, "exit"), "0\n");
			writeFileSync(join(round, "merge-base"), `${"e".repeat(40)}\n`);
			writeFileSync(join(round, "nonce"), `${nonce}\n`);
			const writes = join(dir, "writes.log");
			const step = (token, authors) => {
				rmSync(writes, { force: true });
				const comments = authors.map(([login, id], index) => ({
					id: 60 + index,
					user: { login, id },
					body: `<!-- melian-round run:9 nonce:${nonce} -->\nsame marker`,
				}));
				const ran = spawnSync("bash", ["-e", "-c", run], {
					cwd: fileURLToPath(new URL("..", import.meta.url)),
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						HOME: dir,
						RUNNER_TEMP: dir,
						REPOSITORY: "o/r",
						NUMBER: "7",
						BASE: base,
						HEAD: head,
						RUN_URL: "https://example.test/run",
						RUN_ID: "9",
						NOW: `${base} ${head}`,
						COMMENTS: JSON.stringify(comments),
						WRITES: writes,
						GH_TOKEN: "github-token",
						STATUS_TOKEN: token,
					},
				});
				return [ran.status, ran.stdout, existsSync(writes) ? readFileSync(writes, "utf8") : ""];
			};
			expect(
				step("status-token", [
					["github-actions[bot]", 41898282],
					["redbeard", 40684],
				]),
			).toEqual([0, "", "POST repos/o/r/issues/7/comments status-token\n"]);
			// After a rename, another account holds the login: its planted comment is never edited, even under that login.
			expect(
				step("status-token", [
					["melian-status-bot-renamed", 353727783],
					["melian-status-bot", 999],
				]),
			).toEqual([0, "", "POST repos/o/r/issues/7/comments status-token\n"]);
			expect(step("", [["melian-status-bot", 353727783]])).toEqual([
				1,
				"::error::the melian-round Environment holds no MELIAN_STATUS_TOKEN\n",
				"",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("hands the status token to the gh writes alone, never to a node script that reads comments or verdicts", () => {
		const dir = mkdtempSync(join(tmpdir(), "round-workflow-"));
		try {
			const base = "b".repeat(40);
			const head = "1".repeat(40);
			const nonce = "0123456789abcdef0123456789abcdef";
			// A wrapper node logs each script it ran with a status token in its environment, then runs the real node.
			writeFileSync(
				join(dir, "node"),
				`#!/bin/sh\n[ -n "$STATUS_TOKEN" ] && echo "$1" >> "$NODE_SAW"\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
			);
			chmodSync(join(dir, "node"), 0o755);
			// A fake gh answers the reads both steps make, and logs every write with the token it saw.
			writeFileSync(
				join(dir, "gh"),
				[
					"#!/bin/sh",
					'if [ "$*" = "api repos/o/r/pulls/7 --jq .base.sha + \\" \\" + .head.sha" ]; then echo "$NOW"; exit; fi',
					'[ "$1 $2 $3" = "api --paginate repos/o/r/issues/7/comments?per_page=100" ] && exit 0',
					'if [ "$1 $2 $3" = "api --paginate repos/o/r/commits/$HEAD/statuses?per_page=100" ]; then printf "%s" "$STATUSES" | jq -r "$5"; exit; fi',
					'[ "$1 $2" = "api -X" ] && cat > /dev/null && echo "$3 $4 $GH_TOKEN" >> "$WRITES" && exit 0',
					"exit 1",
					"",
				].join("\n"),
			);
			chmodSync(join(dir, "gh"), 0o755);
			const round = join(dir, "round");
			mkdirSync(round);
			writeFileSync(
				join(round, "verdict.json"),
				JSON.stringify({ status: "passed", blocking: false, findings: { block: [], acknowledge: [] }, notRun: [] }),
			);
			writeFileSync(join(round, "rounds.json"), JSON.stringify([{ base: "e".repeat(40), head }]));
			writeFileSync(join(round, "exit"), "0\n");
			writeFileSync(join(round, "merge-base"), `${"e".repeat(40)}\n`);
			writeFileSync(join(round, "nonce"), `${nonce}\n`);
			const saw = join(dir, "saw.log");
			const writes = join(dir, "writes.log");
			for (const name of ["Comment on the pull request", "Set melian/review on the reviewed head"]) {
				const { run } = workflow.jobs.report.steps.find((step) => step.name === name);
				const ran = spawnSync("bash", ["-e", "-c", run], {
					cwd: fileURLToPath(new URL("..", import.meta.url)),
					encoding: "utf8",
					env: {
						PATH: `${dir}:${process.env.PATH}`,
						HOME: dir,
						RUNNER_TEMP: dir,
						GITHUB_WORKSPACE: dir,
						REPOSITORY: "o/r",
						NUMBER: "7",
						BASE: base,
						HEAD: head,
						RUN_URL: "https://example.test/run",
						RUN_ID: "9",
						NOW: `${base} ${head}`,
						STATUSES: JSON.stringify([{ id: 77, context: "melian/review", state: "pending" }]),
						PENDING: "77",
						PULL_URL: "https://example.test/pull/7",
						GH_TOKEN: "github-token",
						STATUS_TOKEN: "status-token",
						NODE_SAW: saw,
						WRITES: writes,
					},
				});
				expect(ran.status, `${name}: ${ran.stderr}`).toBe(0);
			}
			expect(existsSync(saw) ? readFileSync(saw, "utf8") : "").toBe("");
			expect(readFileSync(writes, "utf8")).toBe(
				`POST repos/o/r/issues/7/comments status-token\nPOST repos/o/r/statuses/${head} status-token\n`,
			);
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

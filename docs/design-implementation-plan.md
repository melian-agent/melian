# Melian implementation plan

Sister to [design.md](design.md). The design document says what Melian is and why. This document says what is being built in what order, what is deliberately deferred, and how far along it is. Update it in the same commit as the work it tracks.

Status legend: `[ ]` not started, `[~]` in progress, `[x]` done. Each step names what it unblocks, so the order is not arbitrary.

## Milestone 1: Melian reviews a Melian pull request

A pull request on melian-agent/melian is reviewed by `melian review` run against the branch, findings are posted to the pull request through the CLI, and the author fixes or dismisses them before merge. Local CLI only, maintainer pull requests only, no Actions host.

Closed on 2026-10-04 with the first real publication. The maintainer ran `melian review "#28" --model anthropic/claude-opus-5-5`, then `melian publish "#28"`, on [pull request #28](https://github.com/melian-agent/melian/pull/28), and the review, its inline comment, and the `melian/review` status reached GitHub; a second publish posted nothing. [packages/evals/runs/2026-10-04-first-publish.md](../packages/evals/runs/2026-10-04-first-publish.md) records the run. The [first self-review](../packages/evals/runs/2026-10-03-first-self-review.md) on 2026-10-03 had reviewed through the CLI but posted nothing. The golden-fixtures track remains open.

### Critical path

1. `[x]` **Scaffold.** npm workspaces, Biome, Vitest, TypeScript configuration, package skeletons from the layout in design.md, and `npm run check` running Biome, type checking, dependency audit, and tests. Unblocks everything landing as commits that pass the gate.
2. `[x]` **Pi Durable spike.** Open a harness on SQLite, run one task with a checkpoint, spawn one child conversation, call one TypeBox tool, kill the process mid-task, resume. Pin the exact version and wrap it behind one internal module. The largest unknown on the path; do it before any domain code assumes the API.
3. `[x]` **Changeset and configuration.** Resolve a git range to base, head, files, hunks. Load `melian.yaml` with nearest-first layering. Load `AGENTS.md` as the standards section. Ranges only; no pull request fetching yet.
4. `[x]` **Findings.** SARIF-plus-extensions schema, stable IDs, the findings document, terminal and JSON rendering. Cause by location for now: location proves `introduced` only, `affected` needs the lens's evidence, and everything else is `pre-existing`.
5. `[x]` **Lenses.** `LENS.md` loader, two built-in lenses (correctness, contracts), the `report_finding` tool, one child conversation per lens with read-only tools. Model routing from config tiers; credentials from environment variables and Pi's credential store. Three golden fixtures written alongside: one per lens, one clean change.
6. `[x]` **Static and guardrails.** Biome and tsc runners normalised to SARIF on base and head, diffed. Guardrails as the path and pattern rules the Melian repository itself needs. May trail step 5 by a week if time is short.
7. `[x]` **Adjudication, minimal.** Dedupe by ID, severity to resolution from config.
8. `[x]` **Publish from the CLI.** `melian publish` posting a review with inline comments through Octokit using the gh token.
9. `[x]` **Claude Code skill.** Thin wrapper over the CLI, so the agent writing Melian asks Melian for review after committing and before pushing.

### Parallel tracks

- `[x]` **Comparison reviews.** Every Melian pull request is also reviewed by Claude Code's review skill and by Codex review through its skill, for as long as the comparison is informative. Each finding that one reviewer raised and another did not is adjudicated by a maintainer and, if valid, added to the golden corpus. Each finding that was raised and judged noise is recorded as a negative golden. This is the first eval and it costs nothing to run.
- `[~]` **Golden fixtures.** Start with the three from step 5. Grow by one golden per comparison difference. Keep Martian's golden format as the base so their judge runs unchanged. Six goldens exist in Martian's format, the step 5 three, `injection-in-comment`, and, from [pull request #34](https://github.com/melian-agent/melian/pull/34), `correctness-deleted-guard` and `pre-existing-beside-change`, and five live runs are recorded. A golden whose `expected.json` sets `live: false`, today only `pre-existing-beside-change`, runs scripted only, and `live.ts` refuses it when `MELIAN_EVAL_GOLDEN` names it. The comparison records mark about 150 differences as goldens, and only `injection-in-comment` has been written. [The fifth live run](../packages/evals/runs/2026-10-04-live-goldens-5.md#goldens-that-should-be-written) lists two goldens the correctness lens's input rule still needs: an input declared by a parameter's name or a documented contract, and an input only a type allows.
- `[x]` **Contributing guide.** States that Melian reviews maintainer pull requests only until container isolation exists.

### Explicitly deferred from milestone 1

Each is a differentiator; none is needed to review a pull request once. Resist pulling them forward.

- Decision models and triage
- Credential pool and subscription stacking
- Cross-revision finding diffing
- Knowledge write-back
- Comment commands
- Actions host and the state branch backend
- Container isolation
- The full evals corpus

## Milestone 2: Melian is the review of record for Melian

Done when the `melian/review` status is required on `main`, and every pull request on melian-agent/melian is reviewed by Melian with the lenses, the verifier, and the ledger below. Dismissals work from the CLI. The shadow reviewers, Codex's adversarial review and Claude Code's review skill, have been retired, or the criterion for retiring them is recorded. Authority over the Melian repository needs lens coverage, a verifier, dismissal, and a required status check, and none of them needs the Actions host, so the Actions host moves to milestone 3. [decisions/2026-10-04-milestone-order.md](decisions/2026-10-04-milestone-order.md) records why.

### Critical path

1. `[x]` **Research notes and this design update.** [Pull request #31](https://github.com/melian-agent/melian/pull/31) adds [research/](research/) with four notes, states the decisions below in [design.md](design.md), and records each in [decisions/](decisions/). Unblocks every step below.
2. `[x]` **Failure scenario and evidence.** [Pull request #34](https://github.com/melian-agent/melian/pull/34): `report_finding` gains two required fields, a failure scenario and evidence locations as `{ file, line, endLine, role }`, where `role` is `cause` or `context` and only a `cause` location overlapping the change makes a finding `affected`: a hunk's new lines at head, or its old lines for a location that names `revision: base` for deleted lines, read from the base commit. The schema, the renderers, the GitHub review, the lens instructions, and the goldens follow, and stored documents from before read tolerantly. Unblocks the verifier, which has nothing to attack without them.
3. `[~]` **Lenses from the research.** `trust-boundary`, `durability` as a repository lens under `.melian/lenses/`, `removed-behaviour`, `tests`, and `conventions`, written adversarially, with levels in `LENS.md` and each level's `budget.tokens` and `budget.tools` enforced. Five goldens per lens from the comparison records, and the rest listed for scripted goldens. Unblocks recall on trust boundary and durability, the two largest buckets with no check.
   - `[x]` Levels and budgets, [pull request #37](https://github.com/melian-agent/melian/pull/37). `LENS.md` declares `quick`, `careful`, and `deep`, each inheriting from the top level; the built-in lenses declare all three, with `careful` held to 200,000 tokens and 30 tool calls; every lens runs at `careful` until step 5; each level's token and tool budgets end a lens conversation, which records `ended` and leaves the verdict not reviewed unless the level sets `budget.ended: count`; and the manifest's check record carries the level and any budget that ended the lens.
   - `[ ]` The five lenses and their goldens.
   - `[ ]` The enclosing functions in the change prompt at `reads: functions`, once Melian can find a function's bounds in each language it reviews. Until then the level's instructions tell the lens to read them with `read_file`; [decisions/2026-10-04-reading-scope-as-an-instruction.md](decisions/2026-10-04-reading-scope-as-an-instruction.md) records why.
4. `[ ]` **The review plan.** Step 12 runs before this step and steps 5, 6, and 8, so the behaviour they add lands on objects. The resolver over pi-ai's catalogue and the credentials present; named credentials; the secrets files and the user-level files, with environment and command sources; `accept` and `unavailable`; override lineage; `acceptOverridden: false` failing closed, so a check that ran outside policy on such a tier records `failed` and the verdict is not reviewed; `melian doctor` printing the plan; committed default routes in Melian's own `melian.yaml`. When the committed routes land, the same change updates the comment in Melian's `melian.yaml` that says it routes no model, the `melian.local.yaml` and layering text in [docs/guidelines/core.md](guidelines/core.md), and the routing text in [docs/guidelines/cli.md](guidelines/cli.md), all of which still say the repository commits no routes. Unblocks the verifier's route to a different family from its finder.
5. `[ ]` **The `Decider` port and triage.** The port in core, with the recorded and LLM fallback adapters in `packages/decisions`; triage at intake choosing each lens's level within the policy floor and ceiling, and the escalation rule, which also escalates a lens its budget ended at `quick` before it reported anything, with the level added to every key that today names a lens by `name@version` alone, so a run at one level never stands in for a run at another: the key that names a lens in the review index, so a review at another level never attaches to one at the first; findings' `source.version`, so an escalated rerun's sightings do not overwrite the quick run's; the lens task's `children` and `attempts`, so an escalation gets its own conversation; and each lens request's `requestId`, `lens:<key>:<attempt>`, so the rerun's input is not deduplicated against the first; and [issue #24](https://github.com/melian-agent/melian/issues/24), `decisions.*` checks left without a record once a provider is configured, fixed here because configuring a provider is what triggers it. Unblocks scrutiny levels in a real review, and the decision-model adapters in milestone 4.
6. `[ ]` **The verifier.** The mechanical merge moved ahead of verification, so one defect is verified once; the state and verdict schemas, the LLM executor with `report_verdict`, the `verifier` tier, and adjudication counting verdicts and capping a lens finding no verifier judged at advisory. Needs steps 2 and 4. Unblocks the precision a required status needs.
7. `[ ]` **`melian dismiss`.** `melian dismiss <#pr|range> <id> --reason <text>`, the lifecycle it drives, and publication honouring it. A dismissal lives in local SQLite, shared across the clone's worktrees through the git common directory; a second maintainer does not see it until the state branch lands in milestone 3. The milestone accepts that, because one maintainer reviews Melian. Unblocks the required status: a blocking finding the maintainer rejects needs a way out.
8. `[ ]` **The ledger.** The comment Melian owns and edits in place, its stamp, the walkthrough, run details, warnings, earlier rounds, addressed-in-commit edits with thread resolution in place of milestone 1's resolved reply, and the agent prompt block in `melian findings`. Unblocks reading what a review did without the CLI.
9. `[ ]` **Issues milestone 1 deferred.** [Issue #22](https://github.com/melian-agent/melian/issues/22), lens path globs on a backtracking `RegExp`, and [issue #26](https://github.com/melian-agent/melian/issues/26), `reviewChangeset` driving `runChecks` itself. Unblocks the required status, which should not go live over known defects in the review it gates.
10. `[ ]` **Required status on `main`.** Rehearse first: a complete review on the intended configuration, with every lens, the verifier, and the ledger, passes on a real pull request. Then make `melian/review` a required check. Writers are trusted: a commit status set with a user's token can be set by anyone with write permission, so the gate rests on that trust until milestone 3 binds the required check to the GitHub App as its expected source. `trust.writers: false` in `melian.yaml` turns the trust off, and a pull request from anyone without write permission never relies on a local record. The shadow reviewers keep running on every pull request until Melian's recall against them holds for a run of ten pull requests, a criterion the maintainer may tighten, and every difference still becomes a golden. Every pull request gets a comparison record; pull requests [#14](https://github.com/melian-agent/melian/pull/14), [#17](https://github.com/melian-agent/melian/pull/17), [#20](https://github.com/melian-agent/melian/pull/20), and [#28](https://github.com/melian-agent/melian/pull/28) have none. Unblocks retiring the shadow reviewers.
11. `[ ]` **The tool manifest and the Enola spike.** The `tools.yaml` manifest with hashes and the release-age quarantine; a fork of Enola under the Melian organisation adding `enola impact --json`, the command-line twin of `impact_analysis`, released with per-asset digests and offered upstream; Enola as a static check and as blast-radius input to lenses; the cache under the git common directory; per-file call coverage for the graph, defined by the spike; and the three coverage artifacts. `search` stays unrestricted until that coverage is measured, because Enola's own coverage report measures only edges between repositories. Exit criterion: per-file call coverage is defined and measured against the imports and calls tsc resolves on Melian's own tree, with every gap named; only then may coverage budget `search`. On Melian the direct value is one real layering constraint, core never reaching the pipeline, because the repository is small; the value is for users. Unblocks precomputed callers in the verifier's state.
12. `[ ]` **Domain objects carry behaviour.** Runs before steps 4 to 6 and 8, which add behaviour to findings, verdicts, lenses, and defects. It covers the seven types the rule names: `Finding`, `Verdict`, `Lens`, `Revision`, and `Changeset` exist as types today and gain behaviour, and `Defect` and `Manifest` are new. Each becomes a class over its stored JSON, the free functions over them become methods, transforms as `toX()` and constructions as static `from()` or `parse()`, the dependents follow, the exclusion list of the `free-domain-function` Biome rule empties, and a conventions-lens golden covers what neither check sees. [decisions/2026-10-04-domain-objects-carry-behaviour.md](decisions/2026-10-04-domain-objects-carry-behaviour.md) records it. Unblocks the verifier, triage, and the ledger landing on objects rather than on more free functions.

## Milestone 3: Melian reviews pull requests on GitHub Actions

The Actions host from design.md: `pull_request_target` workflow, state branch backend, `workflow_dispatch` continuation, `workflow_run` recovery, three-state check status. Melian's own repository is the first installation. The host completes the manifest from local review records, running only the checks that lack one. With it come the credential pool with stacking rules, the secrets file in a repository secret and the preferences file in a repository variable, the GitHub App, bound as the expected source of the required `melian/review` check and holding the secrets permission for rotating OAuth credentials, `add-mask` for every credential value, and `acceptOverridden: false` rerunning a check that ran outside policy rather than failing it. Container isolation follows from the [tool manifest](design.md#tool-provisioning), and Opengrep and gitleaks join it after Enola.

Steps to be written when milestone 2 closes.

## Milestone 4: Melian remembers and learns

Comment commands, including dismiss-with-reason from a thread; knowledge write-back by pull request; the Jev and Clef adapters; calibration measurement and the calibration store; the decision-model verification executor, with asymmetric thresholds; triage on a decision model; routing scores learned from calibration feeding the resolver; and pre-merge checks on a pull request's title, description, and out-of-scope changes.

Steps to be written when milestone 3 closes.

## Risks

| Risk | Where it bites | Mitigation |
|---|---|---|
| Pi Durable API changes under us | Milestone 1, steps 2, 5, 7 | Exact pin, one wrapper module, core stays harness-free |
| Subscription auth terms for automated use | Milestone 1, step 5 onward | User documentation says the provider's contract decides, and Melian takes no position |
| Biome's SARIF reporter changes shape | Milestone 1, step 6 | Biome 2.5 ships one, and Melian reads it; it writes absolute paths and no version, so the normaliser fills both in, and output it cannot read fails the check rather than reading as clean |
| Lens prompt edits regress silently | Milestone 1, step 5 onward | Golden fixtures run in `npm run check` |
| Phantom dependencies through npm hoisting | Any package | Move to pnpm when strict isolation is needed; the switch is one pull request |
| Enola pre-1.0 churn and TypeScript extractor gaps | Milestone 2, step 11 | Pinned manifest, the spike's exit criterion, `search` unrestricted until per-file coverage is measured against tsc |
| The verifier drops real findings | Milestone 2, step 6 onward | Asymmetric thresholds, refuted findings kept in the store, shadow reviewers until recall holds |
| Any writer can forge the required `melian/review` status until the GitHub App binds it | Milestone 2, step 10, until milestone 3 | Writers are trusted by decision; `trust.writers: false` turns that off; milestone 3 binds the required check to the GitHub App as its expected source |
| Losing the one clone that reviews Melian loses the marker secret, the ledger's comment ID, and every dismissal | Milestone 2, steps 7 and 8, until milestone 3 | A publish that finds a ledger marker it cannot verify refuses and names the recovery, never posting a duplicate; shared state on the state branch in milestone 3 |

## Progress log

[progress-log/](progress-log/) records what landed, one file per entry, oldest first in name order.

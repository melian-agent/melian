# Melian implementation plan

Sister to [design.md](design.md). The design document says what Melian is and why. This document says what is being built in what order, what is deliberately deferred, and how far along it is. Update it in the same commit as the work it tracks.

Status legend: `[ ]` not started, `[~]` in progress, `[x]` done. Each step names what it unblocks, so the order is not arbitrary.

## Milestone 1: Melian reviews a Melian pull request

A pull request on melian-agent/melian is reviewed by `melian review` run against the branch, findings are posted to the pull request through the CLI, and the author fixes or dismisses them before merge. Local CLI only, maintainer pull requests only, no Actions host.

### Critical path

1. `[ ]` **Scaffold.** npm workspaces, Biome, Vitest, TypeScript configuration, package skeletons from the layout in design.md, and `npm run check` running Biome, type checking, dependency audit, and tests. Unblocks everything landing as commits that pass the gate.
2. `[ ]` **Pi Durable spike.** Open a harness on SQLite, run one task with a checkpoint, spawn one child conversation, call one TypeBox tool, kill the process mid-task, resume. Pin the exact version and wrap it behind one internal module. The largest unknown on the path; do it before any domain code assumes the API.
3. `[ ]` **Changeset and configuration.** Resolve a git range to base, head, files, hunks. Load `melian.yaml` with nearest-first layering. Load `AGENTS.md` as the standards section. Ranges only; no pull request fetching yet.
4. `[ ]` **Findings.** SARIF-plus-extensions schema, stable IDs, the findings document, terminal and JSON rendering. Cause classification by location heuristic for now.
5. `[ ]` **Lenses.** `LENS.md` loader, two built-in lenses (correctness, contracts), the `report_finding` tool, one child conversation per lens with read-only tools. Model routing from config tiers; credentials from environment variables and Pi's credential store. Three golden fixtures written alongside: one per lens, one clean change.
6. `[ ]` **Static and guardrails.** Biome and tsc runners normalised to SARIF on base and head, diffed. Guardrails as the path and pattern rules the Melian repository itself needs. May trail step 5 by a week if time is short.
7. `[ ]` **Adjudication, minimal.** Dedupe by ID, severity to resolution from config.
8. `[ ]` **Publish from the CLI.** `melian publish` posting a review with inline comments through Octokit using the gh token.
9. `[ ]` **Claude Code skill.** Thin wrapper over the CLI, so the agent writing Melian asks Melian for review before committing.

### Parallel tracks

- `[ ]` **Comparison reviews.** Every Melian pull request is also reviewed by Claude Code's review skill and by Codex review through its skill, for as long as the comparison is informative. Each finding that one reviewer raised and another did not is adjudicated by a maintainer and, if valid, added to the golden corpus. Each finding that was raised and judged noise is recorded as a negative golden. This is the first eval and it costs nothing to run.
- `[ ]` **Golden fixtures.** Start with the three from step 5. Grow by one golden per comparison difference. Keep Martian's golden format as the base so their judge runs unchanged.
- `[ ]` **Contributing guide.** States that Melian reviews maintainer pull requests only until container isolation exists.

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
- Codex and Pi skills (Claude Code first; the others are the same wrapper)

## Milestone 2: Melian reviews pull requests on GitHub Actions

The Actions host from design.md: `pull_request_target` workflow, state branch backend, `workflow_dispatch` continuation, `workflow_run` recovery, three-state check status. Melian's own repository is the first installation.

Steps to be written when milestone 1 closes.

## Milestone 3: Melian remembers and learns

Cross-revision diffing, comment commands including dismiss-with-reason, knowledge write-back by pull request, decision-model triage and the calibration store.

Steps to be written when milestone 2 closes.

## Risks

| Risk | Where it bites | Mitigation |
|---|---|---|
| Pi Durable API changes under us | Steps 2, 5, 7 | Exact pin, one wrapper module, core stays harness-free |
| Subscription auth terms for automated use | Step 5 onward | API keys default; subscriptions opt-in; stated in docs |
| Biome lacks a SARIF reporter | Step 6 | Normalise from its JSON reporter |
| Lens prompt edits regress silently | Step 5 onward | Golden fixtures run in `npm run check` |

## Progress log

Newest first. One line per entry: date, what changed, link to the pull request where one exists.

- 2026-10-03: Plan created. Design settled; no code yet.

# Melian implementation plan

Sister to [design.md](design.md). The design document says what Melian is and why. This document says what is being built in what order, what is deliberately deferred, and how far along it is. Update it in the same commit as the work it tracks.

Status legend: `[ ]` not started, `[~]` in progress, `[x]` done. Each step names what it unblocks, so the order is not arbitrary.

## Milestone 1: Melian reviews a Melian pull request

A pull request on melian-agent/melian is reviewed by `melian review` run against the branch, findings are posted to the pull request through the CLI, and the author fixes or dismisses them before merge. Local CLI only, maintainer pull requests only, no Actions host.

### Critical path

1. `[x]` **Scaffold.** npm workspaces, Biome, Vitest, TypeScript configuration, package skeletons from the layout in design.md, and `npm run check` running Biome, type checking, dependency audit, and tests. Unblocks everything landing as commits that pass the gate.
2. `[x]` **Pi Durable spike.** Open a harness on SQLite, run one task with a checkpoint, spawn one child conversation, call one TypeBox tool, kill the process mid-task, resume. Pin the exact version and wrap it behind one internal module. The largest unknown on the path; do it before any domain code assumes the API.
3. `[x]` **Changeset and configuration.** Resolve a git range to base, head, files, hunks. Load `melian.yaml` with nearest-first layering. Load `AGENTS.md` as the standards section. Ranges only; no pull request fetching yet.
4. `[x]` **Findings.** SARIF-plus-extensions schema, stable IDs, the findings document, terminal and JSON rendering. Cause by location for now: location proves `introduced` only, `affected` needs the lens's evidence, and everything else is `pre-existing`.
5. `[x]` **Lenses.** `LENS.md` loader, two built-in lenses (correctness, contracts), the `report_finding` tool, one child conversation per lens with read-only tools. Model routing from config tiers; credentials from environment variables and Pi's credential store. Three golden fixtures written alongside: one per lens, one clean change.
6. `[ ]` **Static and guardrails.** Biome and tsc runners normalised to SARIF on base and head, diffed. Guardrails as the path and pattern rules the Melian repository itself needs. May trail step 5 by a week if time is short.
7. `[ ]` **Adjudication, minimal.** Dedupe by ID, severity to resolution from config.
8. `[ ]` **Publish from the CLI.** `melian publish` posting a review with inline comments through Octokit using the gh token.
9. `[ ]` **Claude Code skill.** Thin wrapper over the CLI, so the agent writing Melian asks Melian for review before committing.

### Parallel tracks

- `[x]` **Comparison reviews.** Every Melian pull request is also reviewed by Claude Code's review skill and by Codex review through its skill, for as long as the comparison is informative. Each finding that one reviewer raised and another did not is adjudicated by a maintainer and, if valid, added to the golden corpus. Each finding that was raised and judged noise is recorded as a negative golden. This is the first eval and it costs nothing to run.
- `[ ]` **Golden fixtures.** Start with the three from step 5. Grow by one golden per comparison difference. Keep Martian's golden format as the base so their judge runs unchanged.
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
| Phantom dependencies through npm hoisting | Any package | Move to pnpm when strict isolation is needed; the switch is one pull request |

## Progress log

Newest first. One line per entry: date, what changed, link to the pull request where one exists.

- 2026-10-03: First live golden run, on Opus 5.5, recorded in [packages/evals/runs/2026-10-03-live-goldens.md](../packages/evals/runs/2026-10-03-live-goldens.md). Recall 1.00 and no noise on the clean golden; precision 0.50, because the correctness and contracts lenses each report the other's defect. The lenses also never see their rule IDs, so most open with a rule the hook refuses.
- 2026-10-03: Review models read `CLAUDE_CODE_OAUTH_TOKEN` when `ANTHROPIC_OAUTH_TOKEN` is unset, so a Claude Code login reaches Anthropic without a copy; [docs/guidelines/pipeline.md](guidelines/pipeline.md#credentials) lists the precedence.
- 2026-10-03: Step 5 lenses opened as [pull request #15](https://github.com/melian-agent/melian/pull/15), closing [issue #5](https://github.com/melian-agent/melian/issues/5), built on [pull request #12](https://github.com/melian-agent/melian/pull/12) and [pull request #13](https://github.com/melian-agent/melian/pull/13), both merged; it was written stacked on #13. `LENS.md` lenses load nearest-first from the policy revision, with `correctness` and `contracts` built in. Each selected lens runs as a conversation owned by one lens task, reads the head revision through git, and reports through `report_finding`, held to its tools, severities, rules, and budget by a hook. Tiers route to the first configured model with credentials, read from Pi's login or the environment. `packages/evals` holds three goldens, scripted in the gate and live behind `MELIAN_EVAL_LIVE=1`. The credential pool, token budgets, and the CLI are left for later steps.
- 2026-10-03: [Pull request #13](https://github.com/melian-agent/melian/pull/13) reviewed by Codex adversarial review and an Opus review of record, recorded in [packages/evals/comparisons/2026-10-03-pr-13.md](../packages/evals/comparisons/2026-10-03-pr-13.md). The review changed finding identity, which now hashes the snippet's occurrence in its file, and the cause rule: location proves `introduced` only, and `affected` needs the lens's evidence. It also split the findings document into producer and lifecycle records, so a rerun keeps a dismissal, encoded paths as valid SARIF URIs, and escaped control characters in everything the terminal renderer prints. The Opus review added GitHub fingerprints and rule metadata to the SARIF log, a normalisation that survives a formatter rewrap, canonical paths, a lens-facing report schema so identity never depends on the model's wording, and the rule that findings belong to the changeset's root conversation.
- 2026-10-03: Step 4 findings opened as [pull request #13](https://github.com/melian-agent/melian/pull/13), closing [issue #4](https://github.com/melian-agent/melian/issues/4), stacked on [pull request #12](https://github.com/melian-agent/melian/pull/12). `packages/core` defines a finding as a SARIF 2.1.0 result with Melian's extensions in its property bag, a stable ID that survives line shifts, cause classification by location, and JSON and terminal rendering. `packages/pipeline` keeps a conversation's findings in a rewindable document written through an idempotent upsert. Cross-revision diffing, adjudication, and publication are left for later steps.
- 2026-10-03: [Pull request #12](https://github.com/melian-agent/melian/pull/12) reviewed by an automated Claude review, Codex adversarial review, and an Opus review of record, recorded in [packages/evals/comparisons/2026-10-03-pr-12.md](../packages/evals/comparisons/2026-10-03-pr-12.md). The review moved policy and standards loading onto a host-chosen revision, the base for a pull request, so a head cannot rewrite its own review; [design.md](design.md#policy-and-standards-come-from-a-revision-the-host-chooses) records the decision.
- 2026-10-03: Step 3 changeset and configuration opened as [pull request #12](https://github.com/melian-agent/melian/pull/12), closing [issue #3](https://github.com/melian-agent/melian/issues/3). `packages/core` resolves a git range to a changeset with exact zero-context hunks, loads `melian.yaml` nearest-first over the design's defaults, and collects standards with one level of `@` imports. Staged, working-tree, and pull request changesets, prompt rendering, and the CLI are left for later steps. [docs/guidelines/core.md](guidelines/core.md) holds the package's rules.
- 2026-10-03: [Pull request #11](https://github.com/melian-agent/melian/pull/11) reviewed by Claude Code's review skill and Codex adversarial review, recorded in [packages/evals/comparisons/2026-10-03-pr-11.md](../packages/evals/comparisons/2026-10-03-pr-11.md). The reviews led to the idempotent-upsert rule for tools with durable side effects, and to applying the spike's design corrections to [design.md](design.md) in the pull request.
- 2026-10-03: Step 2 Pi Durable spike opened as [pull request #11](https://github.com/melian-agent/melian/pull/11), closing [issue #2](https://github.com/melian-agent/melian/issues/2). The design holds on Pi Durable 1.0.0; [docs/spikes/pi-durable.md](spikes/pi-durable.md) proposes rewording four rows of the mapping table: conversation keying, lens ownership, memo scope, and the storage interface. `packages/pipeline/src/harness.ts` is the one module that imports Pi Durable.
- 2026-10-03: First comparison review of [pull request #10](https://github.com/melian-agent/melian/pull/10) recorded in [packages/evals/comparisons/2026-10-03-pr-10.md](../packages/evals/comparisons/2026-10-03-pr-10.md). The Codex finding was applied as a lockfile release-age gate in `npm run check`, and CI now runs the build.
- 2026-10-03: Scaffold [pull request #10](https://github.com/melian-agent/melian/pull/10) reviewed by Claude Code's review skill and Codex adversarial review; findings applied.
- 2026-10-03: Step 1 scaffold opened as [pull request #10](https://github.com/melian-agent/melian/pull/10): workspaces under the `@melian-agent` npm scope, Node floor 22.19.0 matching pi-durable, Biome, Vitest, TypeBox pinned to pi-durable's version, `npm run check`, CI on Node 22 and 24, branch protection on `main`, and milestone issues [#1](https://github.com/melian-agent/melian/issues/1) to [#9](https://github.com/melian-agent/melian/issues/9).
- 2026-10-03: Plan created. Design settled; no code yet.

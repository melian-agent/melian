# Review findings by bucket

Which kinds of defect did reviewers find in Melian's own pull requests, and which of them could Melian's checks find today?

## Input

The comparison records in [packages/evals/comparisons/](../../packages/evals/comparisons/) cover nine pull requests: [#10](https://github.com/melian-agent/melian/pull/10), [#11](https://github.com/melian-agent/melian/pull/11), [#12](https://github.com/melian-agent/melian/pull/12), [#13](https://github.com/melian-agent/melian/pull/13), [#15](https://github.com/melian-agent/melian/pull/15), [#16](https://github.com/melian-agent/melian/pull/16), [#18](https://github.com/melian-agent/melian/pull/18), [#19](https://github.com/melian-agent/melian/pull/19), and [#21](https://github.com/melian-agent/melian/pull/21). [#14](https://github.com/melian-agent/melian/pull/14), [#17](https://github.com/melian-agent/melian/pull/17), [#20](https://github.com/melian-agent/melian/pull/20), and [#28](https://github.com/melian-agent/melian/pull/28) have no record. The only record of #28 is its [progress-log entry](../progress-log/2026-10-04-pr-28-classes-for-stateful-objects.md), which lists no review findings.

Counting rule: each accepted finding counts once. Rows marked duplicate, same as, or overlaps are left out; rows marked extends are kept. Issues found while applying fixes, the live-run changes in #15, and the two nits #13 waived are left out. That leaves 151 accepted findings. The records judge none of them noise.

## Buckets

| Bucket | Count | Examples |
|---|---|---|
| 1. Trust boundary and security | 28 | #12: `loadConfig` read the head's `melian.yaml`, so a pull request set the policy for its own review. #18: a tracked `node_modules/.bin/tsc` ran arbitrary code. #13: the terminal renderer printed escape and bidi characters from paths. |
| 2. Durability and replay | 17 | #11: a crash between the document commit and the tool result stored a finding twice. #16: a superseded adjudication still wrote its verdict after a kill. #19: a resumed publish task posted the review of the old diff. |
| 3. Correctness and logic | 54 | #16: dedupe let an unevidenced P0 swallow an evidenced P1, so a blocker became advisory. #18: a rename made every base static result read as introduced. #12: `diff.renameLimit` and `diff.orderFile` were not pinned. |
| 4. Contracts, API, and schema | 17 | #13: the SARIF lacked `partialFingerprints` and `tool.driver.rules`. #13: `parseFinding` accepted unknown members. #18: gitignore-style globs were accepted and never matched. |
| 5. Tests missing or weak | 10 | #11: the boundary test gated Pi Durable but not pi-ai. #15: scripted goldens never checked tool results. #21: the skills test passed when a skill called foreign executables. |
| 6. Docs drift | 7 | #11: the spike changed decisions and left `design.md` alone. #12: `design.md` contradicted itself on where standards live. #21: the plan closed milestone 1 before `publish` had ever run. |
| 7. Conventions in `AGENTS.md` | 7 | #12, #15, #16: TSDoc on unexported internals. #10: a progress-log entry without pull request and issue links. #15: a duplicated helper. |
| 8. Design challenge | 4 | #11: the harness wrapper re-exported Pi's raw API, so it quarantined import paths, not churn. #13: a finding's ID depended on the model's wording. #21: the repository picked each contributor's model provider. |
| 9. Other: host, portability, performance | 7 | #21: `.git` is read-only under the Codex sandbox. #21: the Bash tool's ten-minute limit killed a review. #15: loading lenses for 2,000 paths took 22 seconds. |

Buckets 1 and 3 overlap: about 15 of the correctness findings are fail-open behaviour on hostile input. Codex's findings land mostly in buckets 1, 2, and 8. Opus's and Claude's land mostly in 3, 4, and 5.

## What today's checks could cover

- The `correctness` lens covers bucket 3, and part of bucket 2 through its `state-ordering` rule. Two of its rules work against bucket 1. It drops failures only a caller outside the repository could cause, which rules out hook environment variables, the user's git configuration, and installation tokens. Its `melian/injection-attempt` rule flags injection text in the change, not code that is open to injection.
- The `contracts` lens covers a small part of bucket 4: declared contracts that changed and broke a caller. Most bucket-4 findings are about strictness or compliance with a specification, which the lens leaves out on purpose.
- The guardrails in the root `melian.yaml`: `focused-test`, `dynamic-import` (which now covers part of a #12 gap), `build-output`, and `config-key-table`, the only docs-drift rule.
- Biome and tsc check mechanics only. They would have caught none of the 151.

Buckets with no check today:

- 1: no lens asks whether the head controls its own judge, environment, or output.
- 2: no lens knows Pi Durable's replay and idempotency rules.
- 5: test adequacy.
- 6: docs drift beyond the one key-table rule.
- 7: `AGENTS.md` rules such as TSDoc on internals, classes for stateful objects, and progress-log links; Biome is not configured for them.
- 8: design challenge.
- 9: host and portability.

## What a static rule could express

About 11 of the 151, roughly 7%:

- TSDoc on unexported symbols: 3.
- Duplicated helpers: 2, and only with a duplication detector.
- A bare `#N` or a missing link in a progress-log entry: 2.
- A GitHub Action pinned to a tag rather than a commit: 1.
- A symlinked skill directory: 1.
- A required-files rule that `docs/design.md` changes when `packages/*/src` does: 1, and noisy.
- Side-effect and dynamic imports past the boundary guard: 1, now largely the `dynamic-import` guardrail.

The other 140 or so need a model that reasons about inputs, crashes, or intent. Buckets 1 and 2 hold 45 findings, most of them high severity, and are the largest gap.

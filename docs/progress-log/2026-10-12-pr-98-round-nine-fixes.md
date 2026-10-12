# Round nine fixes for [pull request #98](https://github.com/melian-agent/melian/pull/98)

Merged origin/main at 22a821b2. The pipeline guideline keeps both sides’ content. The regenerated lockfile combines main’s Markdown toolkit and the branch’s Stryker entries. Every version, registry URL, integrity, dependency edge, engine and bin map matches a parent.

| Commit | Finding and change |
| --- | --- |
| `e9ebf0fe` | Merge main; retain both guideline sections, both dependency families and full-tier parity in twelve new goldens. |
| `ef4505ae` | Block wrong-result: read test.include without coverage, plugin or unrelated include properties. |
| `25e24350` | Block unguarded-effect: unlock, remove confined trees and prune before removing scratch; tolerate missing paths on retry. |
| `0e155a8d` | Stryker failure visibility: capture bounded supervisor stderr; name missing and non-regular logs without following links. |
| `6cd30676` | Acknowledge terminal-escape: deny /dev/tty reads and writes; add a controlling-terminal host proof. |
| `1d256f87` | Maintainer trust rule: require a base-repository head and a writer pusher; permit author fallback only when GitHub supplies no matching push event. |
| `01d5204b` | Acknowledge untested-behaviour: prove pre-ready control-directory removal on fake process controls. |
| `0fe73c80` | Acknowledge criterion-selection-bias: configured Vitest root or dir uses the whole suite until path rebasing is implemented. |
| `8e9d3f08` | Gate fixture: include the confined tree-removal command while retaining exact installation allowances. |
| `afcb56f5` | Gate style: use a template literal in the stderr-bound assertion. |

Every changed production control has a failing mutation recorded in tmp/fix98-r9-report.md. Signal-sending source is never mutated in place. Extracted cleanup and supervisor code runs only on fake process controls. Bounds have tests at 4,096/4,097 characters and 32/33 stderr lines.

The merge gate passed after the golden-policy parity fix. The final whole gate passed after the command-count and style fixes: 126 test files and 3,948 tests passed; 62 tests skipped. Formatting, type checking, dependency checks and the high-severity audit gate passed. Two moderate transitive audit advisories remain.

The report records both gates’ exact summaries, conflict resolution, lockfile review, each commit and each mutation proof. It names the real seatbelt, directory-swap and process-table tests the coordinator must run on the host. The terminal-open proof and its allow-again mutation also need that host run.

New decisions record cleanup order, the head-writer trust rule and the configured-root fallback. The implementation plan and comparison records were left alone.

# Round eight fixes for [pull request #98](https://github.com/melian-agent/melian/pull/98)

Merged origin/main at 8cd1bec0. The conflicts retained mutation readiness and Codex Terra verifier policy. Each fix was committed and pushed separately.

| Commit | Finding and change |
| --- | --- |
| `ad0ec842` | Merge origin/main 8cd1bec0; preserve mutation readiness and Terra verifier policy in both conflict files. |
| `b9dfdaf3` | Block path-traversal: confine restoration, writes and recursive cleanup; reject linked components. |
| `3c3c9399` | Block secret-exposure: regular, no-follow log/report/cache reads. |
| `4594508b` | Block wrong-result: select Vitest defaults and head include patterns, including spec files. |
| `33a9fee2` | Block fail-open-default: exported runStaticTool requires trustedWriter. |
| `18d4025f` | Selection self-review: anchor default patterns to the actual Vitest installation. |
| `ecf48229` | Scratch self-review: launch trusted housekeeping from /. |
| `e203297a` | Acknowledge stale-task-write: fresh parent authority retires A’s old child across B’s crash and A’s takeover. |
| `921e1a44` | Untested process-record hook: add fake-only rejection test. |
| `d7a0a088` | Correct its copied mutation harness to use stripped source with complete fakes. |
| `cacaa588` | Stale CLI guideline: describe the budget as one advisory. |
| `3054a04f` | Maintainer policy: one P3 advisory counts budget and ignoreStatic omissions together; timeout remains P2. |
| `57684472` | checks.ts survivors: prove publication with an absent authority document; trust false killed by the public gate. |
| `d95d7e30` | compiler-graph.ts survivors: reject backup config suffix; prove closure membership and shorthand guards. |
| `ee62e814` | mutation-static.ts survivor: assert exact trust bits on cache partitions. |
| `bc3f6e1f` | sandbox.ts survivors: call detection inside tests; prove root bound, probes and environment. Remove internal TSDoc. |
| `21a00106` | Host-only evidence: swap directories after validation during confined deletion and no-follow write. |
| `34d6e01a` | Cleanup self-review: unlock and prune registration instead of host recursive deletion. |
| `90e57c85` | Signal-rule self-review: exclude static.ts liveness probes from automatic mutation. |
| `4c767e74` | Selection self-review: computed keys and object spreads use the whole suite. |
| `f1669f90` | Host real-backend test expects the computed wrapper’s whole-suite fallback. |
| `b9f9df33` | Inventory correction: remove the unreachable absolute-relative-path condition. |
| `b575eaad` | Documentation consistency: Vitest patterns replace the decision’s stale hand list; record computed-wrapper cost. |

Mutation proofs remove or invert each changed control. Signal-sending code is copied into isolated fake controls, never mutated in place. Ten survivor locations were killed. The extensionless compiler fallback is equivalent; the true checks trust variant is equivalent after its preceding gate.

The report is `tmp/fix98-r8-report.md`. It records every proof and failing test, conflict resolution, gate summaries and host-only skips. The coordinator must run real seatbelt, directory-swap and process-table tests on the host.

The merge gate passed. The final gate’s first attempt hit the one-second fake version-probe timeout under load. Its whole-gate retry passed: 121 test files and 3,389 tests passed; 61 tests skipped. Formatting, type checking, dependency checks and the high-severity audit gate passed. The two existing moderate transitive audit advisories remain. The final gate log is `tmp/fix98-r8-check.log`.

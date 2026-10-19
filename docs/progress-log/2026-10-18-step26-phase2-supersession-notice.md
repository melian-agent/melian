# Step 26 phase 2: whole-retirement notices

[Pull request #150](https://github.com/melian-agent/melian/pull/150) implements the maintainer's 2026-10-18 ruling after the attack. The grammar commit is `bd5fc861`; this change adds the notice and completes step 26.

Each new or changed Supersedes edge draws one P3 advisory `guardrail/supersession-drop` notice. The notice still appears when every clause is restated. Its ID and trigger exclude sentence evidence. Core registers its enabled switch and per-rule resolution key. The pipeline adds it to the guardrails dispatch used by the CLI, without a core dependency on decisions.

Evidence compares the direct target's base text with the successor, following Git renames and using head text only for a new target. Whitespace collapses before sentence segmentation. Inline code stays whole. The repository has no GFM extension, so tables supply one clause per source row. Declaration exclusion keeps the original parsed paragraph; reparsing an indented continuation had turned it into code. That regression failed first and now passes. Cooked code spanning an excluded declaration line fails closed because mdast no longer supplies a decoded line map.

Paragraph evidence and notice placement count LF, matching read_file. CR-only regression tests failed with lines 3 and 4 instead of line 1, then passed after the coordinate fix. The parser still uses CommonMark physical lines to exclude just a declaration. The shared-target golden also prevents duplicate successor labels when a file declares both forms.

Five deterministic goldens cover a dropped clause, every clause restated, a target nowhere, an amendment leaving its target active, and a late contextual link. Other tests cover switches, resolution, base authority, graph failures, renames, unchanged edges, chains, source bounds and evidence bounds. Every model request count stays zero. No existing asserted outcome changed. The earlier grammar entry records verification-pass becoming active again on main.

The mutation inventory and failing/passing logs live under tmp/step26-phase2-*. Each changed guard has a failing mutation. Initial selections that missed a guard were rerun against tests that reached it. These hand probes do not replace the coordinator's cold Stryker run on the host.

Validation: the final whole gate passed lint, dependency checks, types, the audit threshold and 4,904 tests, with 53 skipped. Four existing process tests failed on the Codex sandbox’s ps restriction, including the supervisor’s toolFailed/invalidOutput mismatch. No timeout occurred. A separate 13-test direct-query run passed after its mutation proof. The coordinator must rerun the whole gate on the host. No live review or companion ran, as the brief forbids model calls. The coordinator retains the host gate and review loop.

The 36 partial Supersedes declarations remain an open audit under step 26. Their meaning stays whole retirement. No decision or progress-log file on main was edited. Comparisons stop at the direct target; earlier losses in a chain remain unaudited. Other layouts remain with [issue #151](https://github.com/melian-agent/melian/issues/151).

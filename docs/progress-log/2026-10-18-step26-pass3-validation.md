# Step 26 pass 3: validation

[Pull request #150](https://github.com/melian-agent/melian/pull/150).

The host reported fourteen survivor findings at d8039fbc. The installed Stryker instrumenter enumerated 83 exact mutants on their lines, including StringLiteral mutants excluded by repository policy. Each replacement ran alone against direct tests. Eighty-one fail; two are equivalent. Production and dependency files are unchanged.

The equivalent for `4f5a3fdf1f81de75` replaces `retired !== undefined` with true; the remaining comparison against undefined is false. The equivalent for `5b964f225dc56331` forces the oldPath conditional false; the next decision-path filter rejects the extra undefined value. Other mutants sharing those finding IDs are killed.

Commits 05cca46e, 8fb5d3e3, 27cdce44 and 53592319 add the tests. Restored focused runs pass: 183 decision-files tests, 72 Markdown tests, 40 supersession tests and the guardrail-notes test. The inventory is appended under `tmp/step26-phase2-mutation-inventory.md`. Exact replacements, failing tests and dismissal reasons are in `tmp/step26-pass3-report.md`.

The whole gate ran at 53592319 with Node 24 and four workers. Biome, dependency pins, release ages, tool checks, type checking and the high-severity audit threshold passed. Vitest recorded 4,930 passed, 53 skipped and four failed across 167 files in 565 seconds. No test timed out. The four failures are the existing sandbox ps denials:

- `mutation-process-real.test.ts`: hands a real child's pid to process.kill, behind a fake that records the call — `ps failed: undefined`.
- `mutation-real.test.ts`: uses Vitest related selection and judges the changed line within a minute — `ps failed: undefined`.
- `mutation-real.test.ts`: reruns only the mutants a later head changes or whose killing test changed, and keeps the earlier survivor — `ps failed: undefined`.
- `mutation-static.test.ts`: ends when the supervisor ends it, and starts no second Stryker once the first has been stopped — its fixture invokes ps before signalling its runner; the denial produces toolFailed instead of invalidOutput.

The full gate therefore exited 1 and needs host validation. Its log is `tmp/step26-pass3-check.log`. The audit also reports two moderate advisories below the gate threshold. No live model call or external review ran. The pull request remains draft; the final local report records CI on the delivered head.

# Stage telemetry pass 6: adjudication after hunk merging

[Pull request #135](https://github.com/melian-agent/melian/pull/135), after [pull request #131](https://github.com/melian-agent/melian/pull/131) landed. The coordinator’s merge made adjudication version 3: main’s version 2 already added `files`.

Recorded running adjudication tasks and findings through main’s own code at `ddf7c113` (version 1) and `ba8be99e` (version 2). Both use fake models. SQLite reopen tests prove that version 1 keeps two different snippets separate, while version 2 keeps its files and merges them through their shared hunk. Both retain their complete input and report timing unavailable. The old generic reopen assertion failed first because it expected version 2; it now names each task’s current version. The whole gate found the same assumption in the terminal test’s task token. Reproducing it alone failed on its missing start. Using the current task versions passes all 22 reopen and terminal tests.

Five mutations failed: removing the version-1 empty-files fallback, inventing files for version 1, dropping version-2 files, removing the legacy timing marker and reverting the task version to 2. Restoring production source passes all ten reopen tests. No production line changed in this pass.

Audited every task and document version changed by either pull request. Adjudication was the only collision. Check 2→3, decision 1→2 and publication 2→3 remain valid. Telemetry’s check-source and timing families are new version-1 kinds. Main’s hunk change versioned no other durable definition. The design and pipeline guideline now describe adjudication version 3 and both upgrade paths. No decision or implementation step status changed.

The final whole gate exited 1: 4,475 passed, 53 skipped and four failed in 296.89 seconds. All timing tests passed. The four failures need `ps`, which the sandbox denies; three other process tests skipped through their existing capability probe. No test was disabled. Formatting, dependency checks, type checking and the configured audit threshold passed. The coordinator must rerun the gate on the host. No live model call ran.

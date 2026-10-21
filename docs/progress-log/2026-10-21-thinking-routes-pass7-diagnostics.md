# Thinking routes: escape diagnostic text

[Pull request #157](https://github.com/melian-agent/melian/pull/157), pass 7, fixes finding `64bd6c193e68eb80` and its baseline-comparison path.
An invalid `MELIAN_EVAL_THINKING` entry and a saved baseline’s thinking value could print raw terminal controls.
Both diagnostics now use core’s existing `visibleText` escaping.
The parser retains JSON quoting around the rejected entry.

Tests build U+202E, U+2028 and C1 U+0085 with `String.fromCharCode`.
They check the parser, both comparison operands, stderr for rejected overrides and stdout for baseline comparisons.
Before the fix, twelve assertions fail on raw controls.
With the fix, all 74 tests in the three affected files pass.
Restoring `JSON.stringify(entry)` alone causes six failures.
Removing the comparison’s escaping causes six failures.
Both mutations were restored.

No decision or step status changes.
The implementation plan stays unchanged.
The pass report under `tmp/m2/scratch-thinking/thinking-routes-pass7-report.md` records the gate, sandbox denials, commit and push.

The whole gate ran three times and stopped at the existing Vite high-severity audit finding.
The brief forbids dependency-file changes.
A full-suite retry passed 5,308 tests, with 53 skipped and four sandbox failures.
Three failures explicitly report a denied `ps`; the mutation supervisor test reports `toolFailed`.
Three earlier five-second timeouts cleared on the full retry.
All 74 tests in the changed eval files passed in both full-suite runs.

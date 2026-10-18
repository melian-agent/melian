# Token telemetry: output mutation proof

[Pull request #146](https://github.com/melian-agent/melian/pull/146) moves triage measurement and printing into a callable function. The executable keeps its opt-in, validation, file output, baseline comparison and exit status. Tests inject a fake provider and print sinks; they load no credentials and call no live model.

The output test checks the requested questions before answering. It holds two passes, detached usage per pass, the chosen model and fingerprint, exact score text and escaped terminal controls. Removing the runner callback, mode object, rendering callback, usage observer or escaping fails. Empty measurement options fail too.

The six host findings group eleven mutants. The supplied text omits extra replacements, and the task seatbelt denies the stored round. The installed Stryker instrumenter enumerated every replacement on the original lines in memory. All four retry replacements and both callback replacements fail. All five possible choice-filter replacements fail, covering both host survivors. No mutant is claimed equivalent. Instrumenter API positions are zero-based, unlike report lines.

All 22 hand probes are killed and restored. The append-only inventory is tmp/token-telemetry-mutation-inventory.jsonl. The report is tmp/token-telemetry-pass2-report.md. The final focused run passes all 37 tests in four files.

The cause test fix is 2d3eee73. Triage retry and score tests are 79f0850e. Golden retry tests are ab8f6538. Each commit was pushed before the next change. Their CI runs passed on their exact heads.

The first whole gate passed 4,599 tests, skipped 53 and failed four ps-dependent tests under the seatbelt. No test timed out despite load above 55. No test was weakened. The final whole-gate and exact-head CI results are retained in the local report. The coordinator must still run the whole host gate and mutation check. The plan stays unchanged for this fix pass. No model-based review ran under the brief’s ban on live calls.

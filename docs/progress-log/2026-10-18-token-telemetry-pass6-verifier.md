# Token telemetry: prove returned verifier usage survives

[Pull request #146](https://github.com/melian-agent/melian/pull/146), final cold-round finding `23ce585de58147fa`.

Reading `missing..revision` on the returned `runVerifierGolden` path passed all 72 existing verifier and output tests. Three new cases reject it: the scripted null-guard decoy, a separately routed fake judge, and an unjudged result returned normally.

The routed cases check the exact resolved revision, both model stages, each provider's nonzero usage and their combined total. Every case passes its unchanged result to the printer and checks spend. The mutation fails all three cases; restoring the correct read passes 75 tests across two files.

No production behaviour, guard or stored shape changes. The inventory and pass report under `tmp/` record each failed mutation and passing run.

The whole sandbox gate exits 1: 4,732 passed, 53 skipped and four process-table failures across 159 files. No test timed out. Formatting, types, dependency checks and the high audit threshold pass. The report lists all three ps-dependent skips and four failures. The host must rerun the whole gate outside the sandbox. Log: `tmp/token-telemetry-pass6-check.log`.

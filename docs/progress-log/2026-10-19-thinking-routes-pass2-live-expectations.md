# Thinking routes: align live-runner assertions

The full gate for [pull request #157](https://github.com/melian-agent/melian/pull/157), pass 2, found two live-runner tests with old expectations.
The score header must include thinking unset, and saved measurements now use format 3.
The header pattern still requires the complete escaped name, score and per-pass telemetry.
The saved-file assertions still require complete and incomplete states, and comparison still refuses an incomplete baseline.

Both tests failed in the full gate before this update. All five live-runner cases pass after it.
The product fixes are `42528319` for policy lineage, `f763d46b` for triage identity, and `080d8724` for verifier thinking.
The pass report records the repeated whole gate and CI on the final head.

# Prove local tool error reporting

[Pull request #89](https://github.com/melian-agent/melian/pull/89) now tests failed inventory opens and readiness probes with both Error objects and thrown strings. Doctor reports the failure. Readiness reports a mismatch without fetching.

The catch and formatting mutations fail the new assertions. The restored tool suite passes all 12 tests.

# Token telemetry: merge the trust floor

[Pull request #146](https://github.com/melian-agent/melian/pull/146) merges main at `942fe6c0894e621682e6f3f39c0f53aab6a662af`, including [pull request #144](https://github.com/melian-agent/melian/pull/144).

The merge keeps both sides without conflicts. Findings, verdicts and published stay at versions 10, 10 and 8. Their definition files match main exactly. Token telemetry uses separate document families, so it needs no competing version bump.

The migration, publication, token telemetry and ledger migration suites pass: 47 tests across four files. The whole gate follows after the two success-path assertion fixes. This fix pass changes no step status or decision.

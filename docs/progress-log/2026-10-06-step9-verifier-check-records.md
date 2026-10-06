# Verifier fixtures supply check records

The first gate after merging main into [pull request #85](https://github.com/melian-agent/melian/pull/85) found three verifier callers without check records. They use raw harnesses and lens-only manifests.

The verifier eval and both test call sites now supply `checks: []`. This preserves the raw-harness refusal and leaves automatic checks with capable review wrappers.

Validation uses the fake-model verifier suites and the full gate. Results are recorded in `tmp/merge85-report.md`.

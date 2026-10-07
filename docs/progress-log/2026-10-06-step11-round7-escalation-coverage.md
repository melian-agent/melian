# Step 11: prove escalation transcript coverage

Confirmed finding 482d3f58274e618a from [pull request #89](https://github.com/melian-agent/melian/pull/89). Existing caller integrations exercised quick and careful separately, so they did not prove escalation transcript inclusion.

The new fake-model integration reads line 1 at quick, reports a P1, then reads line 20 at careful. It opens real cached caller context from a fixture executable. It checks the careful record, exact stored coverage lines and hunk, unchanged coverage ID on attachment, and no extra model calls.

Replacing recordCoverage’s lens expansion with ran.lenses removes line 20 and fails the new case. The previous integration cases remain green under that mutation. No production change is needed for this finding.

The full gate passed with Node 24.18.0 and two Vitest workers: 86 files, 1,991 tests passed and 50 skipped. The audit found no vulnerabilities.

# Incomplete triage measurements cannot be baselines

Status: accepted for milestone 2, step 32.

A triage run can finish golden A and fail on golden B's second pass. Its saved choices contain only A, while its golden list includes both. Comparing a complete run against that file can report a regression caused by missing choices.

Version-2 measurement JSON records completion explicitly. A failed run writes `complete: false` alongside its available choices and telemetry before throwing. A successful run writes `complete: true`. Comparison returns `incomparable` with a clear incomplete-baseline message before computing differences.

Older, unversioned measurement files remain readable as complete. Their writer did not record completion, so the reader cannot reconstruct whether they failed. A fixture written by the previous implementation proves reopening and comparison remain compatible.

This extends the eval-spend contract for [pull request #146](https://github.com/melian-agent/melian/pull/146). It changes no durable pipeline document or triage question version.

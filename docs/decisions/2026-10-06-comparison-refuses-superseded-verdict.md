# Comparison refuses a superseded verdict

An interrupted dismissal commits the finding’s dismissed lifecycle and a replacement adjudication task. The old verdict remains stored until that task records. Comparison accepted it and showed the finding as live.

Comparison now accepts only a current, decided verdict. Its preflight and write commit check the indexed task, the recorded decision and the findings version. This applies publication’s freshness rule within the comparison transaction, before it can write. It preserves older verdicts that predate decision records.

The comparison harness still installs no task and asks no model. An undecided review is `CompareError` `notReviewed`; the caller must finish the dismissal or review. The SQLite regression uses a real dismissal interrupted after its commit, reopens storage and verifies refusal without writes. Completing the same adjudication makes comparison available with the dismissed label.

Supersedes: 2026-10-05-comparison-as-a-capability.md, for reading a stored verdict while replacement adjudication is undecided.

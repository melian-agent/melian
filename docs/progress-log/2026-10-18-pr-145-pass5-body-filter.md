# Prove the reported review-body filter

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 5.
The earlier probe changed the dismissal renderer at line 373. The report named the inline/body filter at line 378.
The dismissal test passes all six mutants the installed instrumenter produces on the reported line.
A mixed inline/body test now kills all six by asserting the body contains only the outside finding's marker.
Vitest relates this test file to publication.ts, so test discovery needs no change.
The restored publication suite passes. Exact runs and the appended inventory are in `tmp/orphan-thread-pass5-report.md`.
No production behaviour or document version changes.

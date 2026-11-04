# Main before caveats

Recorded from production code at `460f68f0`, before any source file changed, using fake models only.
A recording test reviewed `crashRepository` through `reviewChangeset` with `static.enola` enabled and no caller context, so the lens record carries the note "Callers unavailable: the host supplied no graph context". It wrote a walkthrough, recorded the review's spans, and published to `fakeGitHub` through `publishReview`.

`previous.sqlite` is the closed SQLite store after that run.
`recorded.json` holds the version-4 `melian.lenses`, version-5 `melian.adjudication` and version-6 `melian.publish` task inputs read through the store, each with its definition's initial checkpoint; the version-12 verdict, version-9 published and version-3 review index documents; the stage telemetry as `melian telemetry --json` prints it; and the posted review body and ledger.

The recording test is kept outside the repository with its log.

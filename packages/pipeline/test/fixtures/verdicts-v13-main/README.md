# Main's version-13 verdict document

Recorded from production code at `799a54bf`, `main` before the walkthrough recorded its route, using fake models only, with that commit's own install.
A recording test resolved a two-commit repository from `test/fixtures/repo.ts`, stored a pull-request provenance for its revision in the version-13 `VerdictDocument`, and ran `summarizeReview` once on a scripted light model, which wrote a walkthrough with no route.

`previous.sqlite` is the closed SQLite store after that run. `recorded.json` holds the revision key, the root conversation, and the verdict document as main read it back.

The recording test is kept outside the repository.

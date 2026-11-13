# Main's version-14 verdict document

Recorded from production code at `33fe7f18`, `main` after lens routes took the verdict document to version 14 and before the walkthrough recorded its route, using fake models only, with that commit's own install.
The recording test is the one `verdicts-v13-main` describes: it resolved a two-commit repository from `test/fixtures/repo.ts`, stored a pull-request provenance for its revision, and ran `summarizeReview` once on a scripted light model, which wrote a walkthrough with no route.

`previous.sqlite` is the closed SQLite store after that run. `recorded.json` holds the revision key, the root conversation, and the verdict document as main read it back.

The recording test is kept outside the repository.

# Main's pending publisher recording

`publisher-pending-v8-main.json` was written by main at `ac4e8c07`.
An isolated `git archive` copy ran unchanged source through `publishReview`, fake models and `fakeGitHub`.
A personal token named Alice posted one review. The fake transport then threw before publication recorded the review.
The recording retains the version-8 published document, publisher document and fake GitHub state verbatim.
No stored shape was built by hand.

The recorder is `tmp/orphan-thread-pass9b-record-publisher.ts`.
`tmp/orphan-thread-pass9b-producer-proof.txt` records the byte comparison against main's package and script files.
A linked worktree could not be created because the sandbox denied `.git/worktrees`; the archive supplied the same source.

The test stores the old document in SQLite, closes it and reopens through version 9.
Recovery uses the pending ledger's login while the transport would answer `/user` with 502.
It checks the accepted review and roots, then persists and reopens the migrated document again.

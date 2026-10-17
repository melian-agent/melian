# Signed bot review recovery, pass 8c

[Pull request #145](https://github.com/melian-agent/melian/pull/145) implements the coordinator's attacked viewer ruling.
An H1 review from a personal token used to pin the viewer when `/user` refused. Recovery then missed the bot's accepted H2 review.
Scans now leave the viewer unknown. Unknown-user recovery requires GitHub's Bot author type and takes the lowest numeric review ID per signed revision, fingerprint and round.
Later copies and their roots confer no ownership. Known-user recovery keeps its author filter and list order.
The Bot filter also protects addressed edits through `reviewMarker`.
The [GitHub guideline](../guidelines/github.md#markers) records the personal-token recovery gap and the lowest-ID check's absence from `address()`.

The four required provider regressions failed before the fix. An expanded run reproduced eight failures, including a SQLite crash/reopen test.
That crash test failed with a foreign-publisher ledger refusal after recovery pinned the old author; after the fix it recovers H2 and its roots without another review.
Both test files then passed: 129 tests. The existing copied-review-and-root test remains unchanged, apart from adding Bot identity to its shared fixture.
The shared fake now supplies GitHub's Bot type for its publisher; its user shape accepts that field.
Existing unknown-user fixtures in provider, publication and addressed-ownership tests also gain Bot identity. No existing assertions were weakened.

## Hand mutation inventory

Each mutation ran separately against provider.test.ts, exited 1 with assertion failures, and was restored before the next mutation.
Logs use `tmp/orphan-thread-pass8c-mutant-<name>.log`. The append-only scratch inventory records each replacement in full.
The host must still run `static.mutation`: the Codex seatbelt denies `ps`.

| Mutation | A test that failed |
|---|---|
| `sort-removed` | ignores a later bot copy and its root even when the copy is listed first |
| `length-guard-removed` | returns no publication markers from empty review and comment listings |
| `length-bound-inclusive` | returns no publication markers from empty review and comment listings |
| `length-guard-inverted` | returns no publication markers from empty review and comment listings |
| `sort-known-filter-removed` | keeps list order and repeated signed keys when /user is known |
| `sort-known-filter-inverted` | ignores a later bot copy and its root even when the copy is listed first |
| `sort-reversed` | ignores a later bot copy and its root even when the copy is listed first |
| `duplicate-guard-removed` | ignores a later bot copy and its root even when the copy is listed first |
| `duplicate-viewer-filter-removed` | keeps list order and repeated signed keys when /user is known |
| `duplicate-viewer-filter-inverted` | ignores a later bot copy and its root even when the copy is listed first |
| `duplicate-membership-inverted` | rejects a later review copying the signed review and root while /user is unavailable |
| `key-registration-removed` | ignores a later bot copy and its root even when the copy is listed first |
| `key-without-revision` | keeps bot reviews with a distinct signed revision |
| `key-without-fingerprint` | keeps bot reviews with a distinct signed fingerprint |
| `key-without-round` | keeps bot reviews with a distinct signed round |
| `bot-filter-removed` | ignores a lower-id human copy of the bot's signed key |
| `bot-filter-inverted` | rejects a later review copying the signed review and root while /user is unavailable |
| `known-author-filter-removed` | keeps the known personal author filter when a foreign bot copies the signature |
| `known-author-filter-inverted` | skips a ghost reply author and keeps reading signed answers |
| `identity-branch-inverted` | skips a ghost reply author and keeps reading signed answers |
| `author-guard-removed` | ignores a lower-id human copy of the bot's signed key |
| `scan-viewer-restored` | recovers H2 after an H1 personal review without learning a viewer from either scan |

All 438 publication tests across 16 files pass after those fixture updates. The full gate runs after this commit; its result belongs in the local pass-8c report.

# Restore the publication trust clauses that partial supersessions retired

Restores clauses for [2026-10-06-first-status-replay.md](2026-10-06-first-status-replay.md): the active decisions the partial `Supersedes:` chains below ended in. It declares no graph edge, so each of them can be superseded on its own.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

Where a clause below conflicts with any other active decision, including the ones named above, that decision wins. These clauses fill gaps the partial supersessions left; they override nothing.

[2026-10-06-publisher-attribution-resume.md](2026-10-06-publisher-attribution-resume.md) superseded [2026-10-06-writer-trust-status.md](2026-10-06-writer-trust-status.md) to add the resume rules, and said it kept the rest. [2026-10-06-explicit-publication-trust.md](2026-10-06-explicit-publication-trust.md) superseded the attribution decision to make the trust policy explicit, and the decision named above superseded that one for a repeated first status. Each kept its target's other rules without restating them. The index retired each target whole. The clauses below still hold on main; this file restates them and changes nothing.

## From [2026-10-06-publisher-attribution-resume.md](2026-10-06-publisher-attribution-resume.md)

- Before resuming an interrupted task, publication records the full current publisher attribution. A changed trust setting or previously known login, publisher permission or author permission supersedes the old task before any write.
- Unknown legacy fields do not invent an identity or prevent migration.
- A status-crash regression switches from a writer to another login with maintain permission. The new task posts one review and one ledger and records the current attribution.

## From [2026-10-06-explicit-publication-trust.md](2026-10-06-explicit-publication-trust.md)

- Every public publish caller must supply the committed root writer-trust policy explicitly. The API requires it and rejects omission before any write.
- Only version-1 publish task and legacy publisher and published document migrations default to trusted writers.
- Tests cover a base refusing writer trust while the head enables it, its error status and text with exit 0, and a trusted clean review producing success.

## From [2026-10-06-writer-trust-status.md](2026-10-06-writer-trust-status.md)

- The committed root policy at the pull request base controls writer trust. With `trust.writers: false`, publication still posts the review and ledger, sets `melian/review` to `error`, prints the reason and exits successfully. Only milestone 3's Actions host will count under this policy.
- Each revision records the publisher login, repository permission, author permission and trust setting. Unknown reads stay unknown. Old records default to trusted writers without a known poster.
- An author without write permission does not block a maintainer publishing a full review.

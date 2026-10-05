# Repeating the first status after a crash

Supersedes: 2026-10-06-explicit-publication-trust.md.

Publication retains explicit base trust and current attribution on resume. GitHub accepts the first review status before the durable record commit. A crash in that gap repeats the write on resume. We accept this repeat: normal publication writes two statuses, and a crash in this gap writes three. The latest status still links to the ledger.

The claim that recovery happens “without a second post” applies to reviews and ledger comments, not status writes. The status-crash regression pins three statuses and one review and ledger. Repeating the completed publication adds no writes.

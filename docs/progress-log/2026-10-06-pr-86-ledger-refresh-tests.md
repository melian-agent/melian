# Ledger attribution after writer trust changes

[Pull request #86](https://github.com/melian-agent/melian/pull/86), Melian second-round finding 3b8c568b57e3bf0a, lacked assertions for attribution refreshed without another review. The trust-toggle cases now require the one ledger to say writers are trusted. They also require the latest stored ledger round to record trusted writers and retain one posted review.

Removing the current round's attribution refresh fails both cases: the ledger still says writers are untrusted. Restoring the refresh passes the publication suite. The required-status rehearsal and switch remain pending.

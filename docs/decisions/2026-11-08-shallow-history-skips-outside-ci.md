# A shallow clone outside CI skips the questions history check

Amends: [Triage records keep their reachable history](2026-10-12-triage-records-keep-reachable-history.md), shallow history

Status: accepted on 2026-11-08 by the maintainer, in the coordinator session, as recorded on [pull request #329](https://github.com/melian-agent/melian/pull/329#issuecomment-6718154467), for [issue #325](https://github.com/melian-agent/melian/issues/325).

Problem: a Claude Code cloud session clones shallow, so the gate's check of `questions.json`'s history failed closed on every clean `main`. A cloud builder's gate could then never pass alone, and the host had to confirm it.

Choice: outside CI, on a shallow clone, the real-checkout test checks the current fingerprint, then skips the walk over earlier records and prints how to fetch the history. Under `CI`, which checks out the whole history, a shallow clone still fails closed. `recordHistory` itself still refuses unreadable, empty or shallow history for every caller, and the fixture tests still prove it. A test on one shallow clone shows the `CI` variable alone deciding: unset, the history walk skips with its reason; set, the walk runs and fails.

The threat is measurement drift, not an attacker. A stored triage measurement names a question-set version, and a later run is compared with it by version. An agent that rewords a question and pastes the new fingerprint over the old version's entry, rather than bumping the version, makes every stored measurement of that version describe other questions, and the comparison reports a difference that is not one.

The check has two layers. The current file against the current questions needs no history, so the test runs it before it skips; it catches a rewording with no edit to `questions.json`. Only the walk over earlier records catches an overwritten entry. CI runs that walk on every pull request before it merges, so the skip delays a builder's feedback; it opens no path to `main`.

A local shallow run therefore proves nothing about the history, and says so. CI remains the check that a version's fingerprint never changed.

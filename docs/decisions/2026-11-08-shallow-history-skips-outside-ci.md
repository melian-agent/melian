# A shallow clone outside CI skips the questions history check

Amends: [Triage records keep their reachable history](2026-10-12-triage-records-keep-reachable-history.md), shallow history

Status: proposed by the builder agent for [issue #325](https://github.com/melian-agent/melian/issues/325), awaiting the maintainer's read.

Problem: a Claude Code cloud session clones shallow, so the gate's check of `questions.json`'s history failed closed on every clean `main`. A cloud builder's gate could then never pass alone, and the host had to confirm it.

Choice: outside CI, the real-checkout test skips on a shallow clone and prints how to fetch the history. Under `CI`, which checks out the whole history, a shallow clone still fails closed. `recordHistory` itself still refuses unreadable, empty or shallow history for every caller, and the fixture tests still prove it.

A local shallow run therefore proves nothing about the history, and says so. CI remains the check that a version's fingerprint never changed.

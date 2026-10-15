# tests-fake-answers-unasked

The change adds `downgrade`, whose instructions ask the model for the priority one step below the ticket's, and a request that never carries the priority. Its test's fake answers `P3` to every request, so it passes whatever the request holds.

Seeded from C1 of the [comparison record](../../comparisons/2026-10-14-pr-116.md) for [pull request #116](https://github.com/melian-agent/melian/pull/116): the verifier was asked to lower a severity it was never shown, and every lowering golden was scripted, so no test saw it. The record called it unowned. The golden expects two defects. The request that lacks the priority is a wrong result in changed code, `correctness`'s `wrong-result`. The fake that hid it is `tests`' `fake-answers-unasked`.

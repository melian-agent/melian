# tests-fake-answers-unasked

The change adds `downgrade`, whose instructions ask the model for the priority one step below the ticket's, and a request that never carries the priority. Its test's fake answers `P3` to every request, so it passes whatever the request holds.

Seeded from C1 of the [comparison record](../../comparisons/2026-10-14-pr-116.md) for [pull request #116](https://github.com/melian-agent/melian/pull/116): the verifier was asked to lower a severity it was never shown, and every lowering golden was scripted, so no test saw it. The record called it unowned. The `tests` lens owns it through `fake-answers-unasked`, where a test fakes the request, and reports the missing input in the same finding.

A live `correctness` lens may also report `downgrade`'s request at `src/triage.ts`. That sighting does not merge with the test's and costs precision; read it as a sign that the boundary needs a hand-off, not as a golden to loosen.

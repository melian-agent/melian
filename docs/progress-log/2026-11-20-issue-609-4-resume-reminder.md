# A resume after a crash in a reminder unlocks only the provider the reminder reached

[Issue #609](https://github.com/melian-agent/melian/issues/609), the third fix pass on [pull request #619](https://github.com/melian-agent/melian/pull/619), for Codex's third adversarial review, and for the advisories of the first own-build round.

Codex found that `resumedProviders` read only a conversation's own counter. Say a prober finished on its first model, and its reminder then failed over to the second. A crash inside the reminder resumed with both providers unlocked, though the first had already failed. The function now counts a conversation's route from its reminder's counter, `lens:<key>:plan` or `lens:<key>/prober:answer`, once that counter exists, and from the conversation's own counter before.

The fix commit is `23c7e26de`. Its crash test, with the fixture `probing-reminder-failover-crash.ts`, was written first. On the head before it, `resumedProviders` returned `['second', 'first']` where `['second']` was expected. After it, `probing-crash.test.ts` passed 50 of 50.

[The inventory](2026-11-20-issue-609-4-resume-reminder-mutants.json), from `melian mutants list 1441d73fa...23c7e26de --claims-in packages/pipeline/src/review.ts`, lists 14 mutants: 10 generated and 4 string literals ignored by configuration. A scratch runner applied each generated mutant and ran its named test alone, after that test passed unmutated. All 10 were killed: 5 by the new crash test, 3 by the review-crash test of a crashed lens's resumed model, and 2 by the stored-route test. The two `started.attempts` mutants survived the first test the runner picked, and the stored-route test killed both.

The round's advisories each got a commit: the decision links [pull request #532](https://github.com/melian-agent/melian/pull/532), the long sentences in `docs/design.md` and the pipeline guideline are split, and the test that holds a planner reply releases it in `finally`.

Timing: mutants 1 × 6 min; mutants 1 × 2 min (two reruns).

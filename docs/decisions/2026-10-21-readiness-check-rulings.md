# The maintainer's rulings at the milestone 2 readiness check

Status: accepted for milestone 2.

Amends: [2026-10-06-shadow-retirement-merged-window.md](2026-10-06-shadow-retirement-merged-window.md), the early hand-written comparison records stay outside the window and are not backfilled.
Amends: [2026-10-15-review-outcome-task.md](2026-10-15-review-outcome-task.md), `melian learn` runs on demand, after a pull request that took more than four rounds, which settles its last open question.

On 2026-10-21 the maintainer took the coordinator's recommendation on every open question in [the readiness questions](../readiness-check-questions.md). Each ruling is recorded here, and each question is struck there.

## Rulings

- **Question 1.** Leave the early hand-written comparison records outside the retirement window. Do not backfill them.
- **Questions 3 and 4.** Plan step 23's build pull requests 3 and 4 settle them: they group rounds by pull request and let `#N` adjudication span rounds. [The rounds decision](2026-10-18-compare-rounds-exact-rule.md) holds the rule. Until step 23 completes, statistics still count detached rounds as separate comparisons.
- **Question 5.** Run the audit of partial `Supersedes:` lines. Add one restating decision per gap. Use `Amends:` ([pull request #150](https://github.com/melian-agent/melian/pull/150)) for narrow changes from now on.
- **Question 6.** The recorded-pid supervisor is enough on macOS, as a stated limit. Never signal a process group, a negative pid or zero.
- **Question 7.** Fix the repeated primary in the family notice, as a one-test follow-up.
- **Question 9.** Triage each of the two design goldens as either a declared defect or a negative golden.
- **Question 14.** [The exact rule](2026-10-18-supersession-check-exact-rule.md) answered it: the supersession notice is P3 advisory.
- **Question 15.** `melian learn` runs on demand, after any pull request that took more than four rounds, not after every merge.
- **Question 18.** One writer per store is a stated limit while the coordinator is the only publisher. A cross-process lock is milestone 3 work.

# Step 23a, pass 8: review-of-record nits

[Pull request #152](https://github.com/melian-agent/melian/pull/152) fixes the review of record's four P3 findings. This fix pass leaves the implementation plan alone.

An unchanged CLI review now attaches to main's legacy adjudication despite supplying a check-run identity. The main-written decided SQLite fixture is reviewed twice. Its task stays 9 and no round is minted. Before the fix it changed to task 14. All 37 rounds tests pass. Four hand mutations fail the legacy attachment and minted-identity controls.

The legacy attachment fix is commit `f22bfc5b`.

A resumed publication now ends superseded while its revision has no indexed adjudication. The SQLite reopen probe first reproduced a `published` task alongside fresh publication's `notReviewed` refusal. Both missing-adjudication and missing-entry cases now post no review or status and start no provider session. All 34 publication-round tests pass. Five hand mutations fail, including deleting the guard or early return. A new decision records the maintainer's ruling and retains the current-round check. No stored version changes.

The triage publication fix is commit `6d357d4e`.

Round listing retains unreadable legacy heads, sorts them last, and shows their date as `unknown`. Text and JSON include the commit or mint date. The fixture without its git bundle reproduced exit 1 before the fix. All 72 CLI and pipeline rounds tests now pass. Eleven hand mutations fail date-ordering, date-source or listing assertions, including the git-error fallback.

The unreadable-head listing fix is commit `6eb0130f`.

An absent round ID now reports "has no round". A stored round without a verdict still reports "has no decided round". The absent legacy-form key reproduced the wrong message before the fix. All 34 CLI rounds tests pass. Removing or inverting the new guard fails, as does removing the undecided-round guard.

The missing-round diagnosis fix is commit `b7768f01`.

The first whole gate stopped at TypeScript: the attachment regression passed a string instead of the public API's structured check-run identity. The test now uses base, head, tier, policy and task. Restoring the original attachment call again fails with task 14 instead of 9. Restoring the fix passes all 38 rounds tests.

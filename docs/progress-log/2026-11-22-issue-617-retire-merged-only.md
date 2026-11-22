# Issue 617: retire removes only a merged pull request's folder

[Pull request #639](https://github.com/melian-agent/melian/pull/639), third fix pass, for [issue #617](https://github.com/melian-agent/melian/issues/617).

The round at 2ab0b992 raised one finding from the design lens, `b6f3bad63866fea4`. Retiring a record-only folder leaves no mark, so a late relay can write back a passing round without the later round that replaced it and blocked. If the pull request then reopens at the same head, the gate passes a revision whose last round blocked. The coordinator directed on 2026-11-22 that a retirement remove a folder only when its pull request is merged, since a merged pull request cannot reopen and nothing gates on one. A pull request closed without merging keeps its folder until [issue #641](https://github.com/melian-agent/melian/issues/641)'s carry-over mark exists. The coordinator told the maintainer, who may overrule it.

`retire(seen, merged)` now takes the set of names whose pull requests GitHub says are merged. A name `merged` leaves out is kept unread and reported as kept, so a caller that cannot say keeps the folder. Pull request C's job supplies the set from GitHub's answer for each nominee.

The tests came first. Three new tests in `what a retire keeps` failed on fa341fa4a's parent for the reported reason, since each unmerged folder was removed: 3 failed and 76 passed. With the change, state-git ran 15 files and 318 tests, all passing. The existing tests call `retire` through a helper that names every nominee as merged.

[The retention decision](../decisions/2026-11-21-shared-tip-retires-finished-pull-requests.md) records the coordinator's direction, keeps closed pull requests' records until issue #641, and says in its limit paragraph what a late relay would do to the gate. The guideline and the plan's step 46 bullet say the same.

The [inventory](2026-11-22-issue-617-retire-merged-only-mutants.json) lists fa341fa4a's 4 mutants. Each ran against its named test alone and was killed.

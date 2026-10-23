# Delta re-review

Planned for milestone 2, plan step 24. [The decision](../decisions/2026-10-23-delta-re-review-as-designed.md) holds the exact rules and the list to attack before any build.

Problem: a round after a fix pass reviews the whole pull request again. On [pull request #174](https://github.com/melian-agent/melian/pull/174), five fixes of under 50 lines each took five rounds of about 35 minutes: lenses, the verifier and Stryker over every changed line, each time. The rounds also sample, so a full round can miss the lines the fix changed.

Example: round 1 at head `A` finds an untested guard in `publish.ts` line 40 and a wrong default in `config.ts` line 12. The fix pass edits `config.ts` alone. Round 2 should read the `config.ts` hunk, keep the `publish.ts` finding open without reading it again, and decide whether the default is fixed.

Solution: `melian review <range|#N> --delta`. The round builds on the newest decided round in the store that it can safely extend, its anchor, and reviews the diff from the anchor's head to the new head.

## What a delta round does

1. **Picks its anchor.** Same base, an ancestor head, and no merge commit, policy, dependency, configuration or test setup change in between. The anchor needs the same review identity and selection, a full round at the root of its chain, and every check of its own run. The delta must be inside its bound. Git answers the ancestry and merge questions. Failing any rule runs a full round and prints why.
2. **Carries the anchor's findings.** From the anchor's own sightings, one per producer, copied while the anchor is still its key's current round, each lens sighting is mapped by git from the anchor's head to the new head. One whose cited lines the delta left alone carries, with its lines moved and its verification kept. One whose lines the delta changed, or whose file git reports deleted, is re-judged at the first new-side line after its hunk; a heavily edited rename can read as a delete. The carry itself never resolves a finding.
3. **Runs lenses on the delta.** Each lens whose paths the delta touches runs at the root's level or its default within its band, whichever is higher, without triage. Its prompt holds the delta's diff and the pull request's file list. It is handed every carried finding of its own, as escalation hands a quick run's findings to the next level, since a fix elsewhere, such as a new test, can answer one. It restates, refutes, or leaves each. A restated finding keeps the stricter of its two severities.
4. **Runs the checks.** Guardrails and static tools run over the whole range, as in a full round. Stryker mutates the delta's production lines and the line of every carried survivor, and the run is provisional.
5. **Adjudicates under its own key**, `<base>..<head>@<anchor round>`, so it never shares a task, a sighting or a verdict with the full round that may follow at the same base and head. Minting that full round retires every delta round at its base and head, in the transaction that also holds `--delta`'s refusal, so a delta a crash left pending can never decide after it. Every round key comes from one method over base, head and scope, and a key with `@` but no delta scope is refused.

Cause is always classified against the pull request's whole diff, base to new head. Location in the delta never makes a finding `introduced` by itself.

## Why a delta round cannot approve

Its verdict carries a provisional check record, `review.delta`, which Melian writes from the round's own scope. So the verdict reads `not reviewed`, `melian review` exits 2, and `melian publish` sets `melian/review` to `error`. The merge-group job copies only `success`, so a head last reviewed by a delta round cannot leave the queue. Only a full round, cold where the tier holds the mutation check, approves. This puts the convergence rule, "the last round before the queue is a full one", in the store rather than in a script.

## What a reader sees

`melian findings` shows the full round at a base and head when one is decided, and otherwise the newest delta round there, with a first line naming the scope, the anchor and the root. Published, a delta round's review body and ledger say it is a delta round and count its carried findings; carried findings keep their threads open. `melian compare "#N"` lists delta rounds as members with their scope, and counts a carried finding once, at the round that first sighted it, even when a later head renumbers its ID. With no `--round`, a decided full round at the head wins over delta rounds there.

## When rounds run in full

By default, every round. With `--delta`, the first round of a changeset runs in full. So does a round after a base change, a force push or rebase, or a merge of `main`. So does one after a policy or standards change, or a change of review identity. So does one whose anchor had a failed lens or an incomplete check, or whose delta changes dependencies, configuration or test setup. So does one whose delta is over 1,000 changed lines or half the pull request. `--cold` and `--delta` together are refused. The coordinator marks the last round by running it full and cold.

## What it saves

Every pull request still runs two full rounds, the first and the cold final, and every delta round still runs the static checks over the whole range. So deltas pay off only on a pull request with three or more rounds. On [pull request #174](https://github.com/melian-agent/melian/pull/174), running rounds 2 to 4 as deltas would have saved about 60 to 75 of its 175 minutes. The cost is that a late defect in unchanged code surfaces only at the final full round.

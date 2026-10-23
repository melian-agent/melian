# Delta re-review

Planned for milestone 2, plan step 24. [The decision](../decisions/2026-10-23-delta-re-review-as-designed.md) holds the exact rules and the list to attack before any build.

Problem: a round after a fix pass reviews the whole pull request again. On [pull request #174](https://github.com/melian-agent/melian/pull/174), five fixes of under 50 lines each took five rounds of about 35 minutes: lenses, the verifier and Stryker over every changed line, each time. The rounds also sample, so a full round can miss the lines the fix changed.

Example: round 1 at head `A` finds an untested guard in `publish.ts` line 40 and a wrong default in `config.ts` line 12. The fix pass edits `config.ts` alone. Round 2 should read the `config.ts` hunk, keep the `publish.ts` finding open without reading it again, and decide whether the default is fixed.

Solution: `melian review <range|#N> --delta`. The round builds on the newest decided round in the store that it can safely extend, its anchor, and reviews the diff from the anchor's head to the new head.

## What a delta round does

1. **Picks its anchor.** Same base, an ancestor head, no merge commit or policy change in between, the same review identity, a full round at the root of its chain, every lens of the anchor run, and a delta inside its bound. Git answers the ancestry and merge questions. Failing any rule runs a full round and prints why.
2. **Carries the anchor's findings.** From the anchor's own sightings, one per producer, copied while the anchor is still its key's current round, each lens or mutation sighting is mapped by git from the anchor's head to the new head. One whose cited lines the delta left alone carries, with its lines moved and its verification kept. One whose lines the delta changed is re-judged. One whose file the delta deleted is gone.
3. **Runs lenses on the delta.** Each lens whose paths the delta touches runs at the level the root round chose, without triage. Its prompt holds the delta's diff and the pull request's file list. It is handed its own changed findings, as escalation hands a quick run's findings to the next level: it restates, refutes, or leaves each to the verifier.
4. **Runs the checks.** Guardrails and static tools run over the whole range, as in a full round. Stryker mutates only the delta's lines, and the run is provisional.
5. **Adjudicates under its own key**, `<base>..<head>@<anchor round>`, so it never shares a task, a sighting or a verdict with the full round that may follow at the same base and head. Minting that full round retires every delta round at its base and head, so a delta a crash left pending can never decide after it.

Cause is always classified against the pull request's whole diff, base to new head. Location in the delta never makes a finding `introduced` by itself.

## Why a delta round cannot approve

Its verdict carries a provisional check record, `review.delta`, which Melian writes from the round's own scope. So the verdict reads `not reviewed`, `melian review` exits 2, and `melian publish` sets `melian/review` to `error`. The merge-group job copies only `success`, so a head last reviewed by a delta round cannot leave the queue. Only a full round, cold where the tier holds the mutation check, approves. This puts the convergence rule, "the last round before the queue is a full one", in the store rather than in a script.

## What a reader sees

`melian findings` shows the full round at a base and head when one is decided, and otherwise the newest delta round there, with a first line naming the scope, the anchor and the root. Published, a delta round's review body and ledger say it is a delta round and count its carried findings; carried findings keep their threads open. `melian compare "#N"` lists delta rounds as members with their scope, and counts a carried finding once, at the round that first sighted it.

## When rounds run in full

By default, every round. With `--delta`, the first round of a changeset, after a base change, a force push or rebase, a merge of `main`, a policy or standards change, a change of review identity, a failed lens in the anchor, or a delta over 1,000 changed lines or half the pull request. `--cold` and `--delta` together are refused. The coordinator marks the last round by running it full and cold.

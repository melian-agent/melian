# Coverage and delta review

Planned for milestone 2, plan step 24, with the shared ledger in milestone 3. [The decision](../decisions/2026-10-23-coverage-ledger-and-delta-review.md) holds the exact rules, the voids, and the numbered list to attack before any build.

Problem: a round after a fix pass reviews the whole pull request again. On [pull request #174](https://github.com/melian-agent/melian/pull/174), five fixes of under 50 lines each took five rounds of about 35 minutes: lenses, the verifier and Stryker over every changed line, each time. The rounds also sample, so a full round can miss the lines the fix changed, and the rule that the last round before the queue is full costs a whole round at the end of every pull request.

Example: round 1 at head `A` finds an untested guard in `publish.ts` line 40 and a wrong default in `config.ts` line 12. The fix pass edits `config.ts` alone. Round 2 should read the `config.ts` hunk, keep the `publish.ts` finding open without reading it again, decide whether the default is fixed, and, if it is, let the pull request pass.

Solution: a coverage ledger, `melian.coverage`, in the changeset's storage. For each changed line of the diff and each check that applies to it, the ledger says which round covered the line, at what level, under what identity. The delta is every changed line some check has not covered. `melian review` reviews exactly the delta, and a review is valid when the delta is empty and nothing above advisory is open. The maintainer's words: "any series of reviews that together cover the full diff at the configured level for the files in the diff, are a valid review."

## What covers a line

A changed line is a line a hunk adds at the head, or a line a hunk removes from the base. A round covers it for a check when the round reviewed the same base under the same policy and standards; the line maps unchanged through git from the round's head to the current head; every lens that applies to the file received the line, in the prompt's hunk or through a read, in a run recorded `ran` at or above the file's required level; and every finding on the line is settled at the current head. Guardrails, Biome, tsc and Enola run over the whole range every round and cover the whole diff at that head. `static.mutation` covers the production lines it mutated; a survivor's line is mutated again every round until a test kills it or the maintainer dismisses it.

## The ledger

The review-coverage artifacts already record, from durable transcripts, which lines each lens read or searched and which hunks and declarations those reads touched. They prove delivery, count tool reads alone, and live in the cache, outside the state branch. The ledger adds a document in the store: per round, the base, head, tier, policy fingerprint, standards paths, Melian version, writer leave and the git mapping from the previous head; per lens, its `name@version@level`, status, and the hunks and lines delivered per file; per static check, the lines it ran over or mutated, with the test files Stryker ran; and the coverage carried from the previous round in the head's coordinates, so one record answers for a head. `melian findings` and `melian review` print a `Coverage` section, complete with its rounds or incomplete with each gap and its reason, and the JSON carries the same.

## What a round does

1. **Computes the delta** at intake from the ledger and git, per check, and fixes it in the round's input, so a resume reviews the same lines.
2. **Carries the previous round's findings.** Each lens sighting is copied per producer under a `carried/` prefix at the new head, mapped by git. One whose cited lines the delta left alone carries with its verification. One whose lines the delta changed, or whose file git reports deleted, is changed, never gone, and is re-judged at the first new-side line after its hunk. The carry never resolves, lowers or reopens a finding; cause is recomputed against the whole diff.
3. **Runs lenses on the delta.** Each lens whose delta is not empty runs, at the higher of the previous round's level and its default within its band, without triage. Its prompt holds the delta's hunks and the pull request's file list. It is handed every carried finding of its own, as escalation hands a quick run's findings to the next level, and restates, refutes or leaves each. A restated finding keeps the stricter severity; a changed finding it leaves goes to the verifier. A lens whose delta is empty is skipped with leave.
4. **Runs the checks.** Guardrails and static tools run over the whole range. Stryker mutates the delta's production lines and each carried survivor's line, from nothing, so its record is `ran`; Melian no longer hands Stryker an earlier head's report.
5. **Adjudicates the whole head**, carried and new findings together, with one more check record, `review.coverage`: `ran` when the ledger now covers every changed line, otherwise `skipped` without leave naming the gaps, which leaves the review not reviewed.

A repeat review whose delta is empty under an unchanged identity attaches to the current round and spends nothing. `--rerun` runs the failed checks and lenses again. `--cold` reviews the whole diff from nothing.

## Voids

Coverage from a round is void, whole or in part, after a base change, a force push or rebase, a merge commit between the round's head and the current head, a policy or standards change, a review-identity change, a failed or ended lens, a check record that did not run, a change to a lockfile, `package.json`, a `tsconfig`, a Vitest configuration, a test setup file or a test file, or a delta over 1,000 lines or half the diff, which runs cold. The decision says which void all coverage and which void one lens or one check's. A void leaves lines uncovered; the round reviews them.

## The status

`melian/review` passes when the ledger shows an empty delta and nothing above advisory is open. An incomplete ledger leaves the review not reviewed and the status `error`, naming the gaps. The merge-group job is unchanged. `melian publish` posts the current decided round; its body and the ledger comment say which lines the round reviewed and which rounds cover the diff. A carried finding has a sighting at the head, so it stays open with its thread.

## Round identity

Every round's key comes from one method, `Revision.key(scope)`, whose one scope today is the whole diff and gives `<base>..<head>`; a scope it does not know is refused, and no caller builds the key by hand. The key carries no approval: a review passes only on an empty ledger delta, which no key can forge. Rounds at one head are told apart by their IDs, as step 23 built them. `melian.rounds` records each round's scope and ledger record, and the findings document holds carried sightings beside new ones.

## Sharing, in milestone 3

The ledger is why the state branch exists. A writer's `melian publish` pushes the changeset's storage to `melian/state`; the Actions host opens it, verifies each round's head writer and policy fingerprint itself, computes the delta from the ledger, runs that, and publishes under the GitHub App. Writers and the App may push; one writer holds a changeset's lease at a time, and a refused push keeps its results locally and resumes by taking the branch's copy and running again, which costs the delta the branch lacks. The agent never accepts a round of a fork's head, a worktree policy, a non-writer's push, or a status. No signature is needed while writers are trusted and push permission alone writes the branch.

## What it costs

A defect in unchanged code that no round's context reading reached waits for a maintainer or a `--cold` round; a single full round carries the same risk. The whole-range static checks run every round. A writer's deliberate plant-then-revert stays within writer trust, as it did under the unconfined decision; the cold final run is no longer required, and `--cold` remains the reviewer's choice.

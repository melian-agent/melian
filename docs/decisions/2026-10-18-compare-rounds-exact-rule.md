# `melian compare` addresses rounds by a stored round ID

Supersedes: [2026-10-15-compare-addresses-revisions-by-head.md](2026-10-15-compare-addresses-revisions-by-head.md)

For plan step 23, phase 1, before any code.

## What survives from the direction

Problem: once a pull request merges, `melian compare` and `melian findings` cannot reach its stored rounds. The CLI finds a stored verdict by the revision a range resolves to now. After the merge `origin/main...HEAD` resolves to an empty diff, so no range names the revision that was reviewed. Two rounds at one revision also share one slot, `base..head`: `review.ts` deletes the stored verdict when a new triage decision task replaces the old one. The records for [#113](https://github.com/melian-agent/melian/pull/113), [#114](https://github.com/melian-agent/melian/pull/114), [#116](https://github.com/melian-agent/melian/pull/116) and [#117](https://github.com/melian-agent/melian/pull/117) quote the refusal and were written by hand. [#111](https://github.com/melian-agent/melian/pull/111)'s used a scratch clone that reached only the latest revision. None of the five feeds `melian compare stats`.

These clauses stand unchanged:

- A stored round is found by what Melian recorded about it, never by the range that made it.
- `melian compare "#N"` gathers the rounds of a pull request, merged or open, and a recurring finding can be adjudicated across them.
- Thread import keeps every rule of [the comparison-sites decision](2026-10-05-comparison-sites.md).
- Until this is built, records after a merge are written by hand.
- How `compare stats` counts a pull request whose rounds sit in several changesets stays [readiness question 3](../readiness-check-questions.md). Whether `--of` may name a recurring ID stays readiness question 4.

## Round identity and numbering

A round begins in the commit that creates a revision's triage decision task without attaching to a stored one, the commit that today clears the revision's verdict. That commit mints the round's ID from a counter in a new root document, `melian.rounds`: `<changeset ID>.r<n>`, with `n` counting from 1 in each storage. The document maps each revision key to its current round. A resume after a crash and a repeat review attach to the stored decision task and keep the current round; a dismissal creates none. `--rerun` starts a round only when it replaces the decision task.

Each round record holds its base, head and range mode, the time of the commit that minted it, and a copy of its verdict and provenance as last decided. Every commit that records a verdict writes the copy too. When a later round takes the key, the earlier round keeps its last copy, frozen. A round frozen before its verdict was decided stays undecided, and comparison refuses it with `notReviewed`, as now.

A round number is for display only. Within `#N`, members are numbered from 1 by mint time, ties by round ID. The snapshot below keeps the numbers until the next refresh. No write takes a number.

A storage written before this change has no `melian.rounds`. Each verdict key `k` there reads as one legacy round, `<changeset ID>.k<first 16 hex digits of sha256(k)>`. Read-only commands synthesise them and write nothing; the next commit that starts a round or writes a comparison at `k` records the legacy round first.

## Writes name one round

`compare` import, `match`, `unmatch` and a range's `adjudicate` each write one comparison in one storage. A round ID names its storage through its changeset ID, resolved only to `<state directory>/<changeset ID>.sqlite`. The state directory is chosen once per command; Melian never searches another root, so a round stored elsewhere is invisible. Every command that writes accepts `--round <id>`:

- With a range target and no `--round`, the write goes to the current round at the revision the range resolves to, as today.
- With `#N` and no `--round`, the write goes to the one member round at GitHub's head. It refuses, listing the rounds, when there are none or several.
- A `--round` that names a foreign round, or a round not in the state directory, is refused.

`ComparisonDocument` keys its comparisons by round ID instead of by `base..head`, so two rounds at one revision hold two comparisons.

## Which rounds belong to `#N`

GitHub is the authority on which commits belong to the pull request. The stored round record is the authority on what each round reviewed. Branch names and changeset IDs play no part; a changeset ID hashes ref names that a deleted branch or detached worktree lacks.

A `#N` command that can reach GitHub reads the pull request and its timeline through GraphQL. It reads the commit list, every `HeadRefForcePushedEvent`'s before and after commits, every `BaseRefChangedEvent`, and the merge commit if there is one. `#N`'s heads are the commit list, the force-push commits and the current head. A timeline or commit list that GitHub pages incompletely fails closed, and nothing is written.

Melian then reads `melian.rounds` from every storage in the state directory, through the storage's detached reads, as stats does now. A round whose head is one of `#N`'s heads is a candidate. A candidate is a member when all three hold:

1. its range mode is three-dot;
2. its base is not one of `#N`'s commits or force-push commits, which excludes a delta round and `AGENTS.md`'s mutation round over fix commits;
3. git answers that its base is an ancestor of the merge commit, for a merged pull request, or of GitHub's current base commit, for an open one.

Any other candidate is foreign: listed with the rule it failed, never written. A commit missing from the clone after fetching makes a candidate foreign, with that reason.

Three cases:

- **Force-pushed.** A round at a head the push discarded is a member, because the timeline's before commit names that head. If git has dropped the discarded commit, the round is foreign, never guessed in.
- **Retargeted after a stacked parent merged.** A round against the parent branch keeps its old base, which the parent's merge commit made an ancestor of the new base, so it stays a member. A squashed or unmerged parent leaves those rounds foreign.
- **Branch and detached worktrees.** Both are scanned alike, by stored head and base. A branch round and a detached round at one revision are two members.

The `#N` command stores the result in the pull request's own storage, `pull-<hash>.sqlite`, named by `pullRequestChangesetId`. It goes in a new root document, `melian.pull-request-rounds`. The snapshot holds GitHub's answer, the numbered members, and the foreign rounds with reasons. Export and stats read it offline. Every `#N` command that reaches GitHub refreshes it in the same commit as its own write, and says when members or numbers changed.

## Thread import's head rule

Import is a write that names one round. GitHub places threads at the current head, so `melian compare "#N" --from github` imports into a member round at GitHub's current head, or the one `--round` names. A merged pull request's current head is its final head. With no member round at GitHub's head, import refuses and writes nothing. A thread first written on an earlier head stays external-only, with that commit.

## A cross-round adjudication after a crash

`melian compare adjudicate "#N" <id>` writes one record to `melian.pull-request-rounds`, keyed by finding ID, with a round adjudication's fields, history and golden carry-forward. One commit in one storage leaves a crash with nothing or the whole adjudication, so nothing has to be finished. This drops the direction's premise of one write per changeset, which had a crash window.

The record applies to every member round in the current snapshot that holds the ID. A round's own adjudication of the same ID, from a range or `--round`, wins when its `at` is later; on a tie, the round's own wins. `adjudicate "#N" <id> --round <id>` writes the round's own record instead.

## Stored shapes

- `melian.comparisons` goes from version 1 to 2, keyed by round ID. The migration maps each version 1 key `k` to its legacy round ID. The reopen test needs a fixture written by `main` at `ac4e8c07`'s own code, with comparisons at two keys and an adjudication history.
- `melian.rounds` is new, at version 1. Reopen tests: a storage `main`'s code wrote reads as legacy rounds without a write, and a crash between minting and deciding a round reopens to the same round.
- `melian.pull-request-rounds` is new, at version 1, with a reopen test from SQLite.
- `melian.verdicts` does not change.
- `compare export --json` keys its comparisons by round ID.

`melian findings --round <id>` reads a round's frozen verdict.

## For the attack

1. The base test. A three-dot round whose base is an ancestor of the merge commit but not the merge base the pull request showed passes as a member, though it reviewed another diff. A stale local `origin/main` does it. Condition 3 tests reachability because the base branch's past tips are gone.
2. The frozen copy. It is correct only if every commit that records a verdict also writes the current round's copy. A missed writer silently diverges, the single-slot-overwrite class. A frozen round can never be dismissed again.
3. The snapshot overlay. A refresh that drops a member withdraws every `#N` adjudication from it without a write to that round. A commit git has dropped would do it. Precedence by `at` also trusts the adjudicator's clock.

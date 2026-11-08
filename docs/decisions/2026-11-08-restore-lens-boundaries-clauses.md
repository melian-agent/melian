# Restore the lens-boundaries clauses that partial supersessions retired

Amends: [2026-10-05-deleted-guard-stays-with-correctness.md](2026-10-05-deleted-guard-stays-with-correctness.md) and [2026-10-08-every-findings-cap-leaves-review-not-reviewed.md](2026-10-08-every-findings-cap-leaves-review-not-reviewed.md), restoring clauses that partial `Supersedes:` lines retired.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

Where a clause below conflicts with any other active decision, including the decisions this file amends, that decision wins. These clauses fill gaps the partial supersessions left; they override nothing.

[The deleted-guard decision](2026-10-05-deleted-guard-stays-with-correctness.md) superseded [the boundaries decision](2026-10-04-lens-backlog-boundaries.md) for its one sentence on a deleted throw. [The per-file hand-offs decision](2026-10-05-per-file-hand-offs.md) superseded the boundaries decision for its every-file hand-off rule, and [the durability lens decision](2026-10-05-durability-repository-lens.md) for its one-sided hand-off. [The capped-neighbour decision](2026-10-07-capped-neighbour-leaves-review-not-reviewed.md) superseded the per-file hand-offs for a handed defect a capped neighbour refuses. [The every-findings-cap decision](2026-10-08-every-findings-cap-leaves-review-not-reviewed.md) superseded the capped-neighbour decision for its rendered hand-off condition only. The index retired each target whole. The clauses below still hold on main. This file restates them and changes nothing.

## From [2026-10-04-lens-backlog-boundaries.md](2026-10-04-lens-backlog-boundaries.md)

- `trust-boundary`, `removed-behaviour`, `tests`, and `conventions` ship as built-in lenses in the default `full` tier, each one angle with its own rules, and each body says which defects belong to a neighbour.
- A wrong value, a null dereference, or a dropped error in a line the change wrote is `correctness`'s; `removed-behaviour` reports what a deleted or moved line stopped doing, citing the deleted lines at the base.
- A deleted check that stood between untrusted input and something that trusts it is `trust-boundary`'s, not `removed-behaviour`'s. A deleted or weakened assertion is `tests`'.
- `correctness` hands back in turn: a changed declared contract and the callers it breaks go to `contracts`, a deleted cleanup, error path, or ordering goes to `removed-behaviour`, a value an author or outside party controls reaching a sink or passing a check goes to `trust-boundary`, and a defect in a test goes to `tests`, each through its `handoffs`.
- `trust-boundary` reports a judge-control or fail-open finding only when an attacker-controlled input demonstrably reaches a result trusted outside the untrusted run, shown through callers, entry points, or what the base declares, never because a comment or name the change wrote says who controls the input. It leaves ordinary execution of the revision under test, its tests, test runner, plugins, and build configuration alone, and a loosely pinned dependency to the standards or a static rule.
- `removed-behaviour` treats a replaced behaviour as deliberate, and so not a removal, only when the base or the design document states the purpose.
- `tests` reports a missing test only where the repository tests that code or the code beside it, and reports a vacuous test once, at the test, not again as untested behaviour.
- `conventions` reports only a rule it can quote word for word from the standards and a line that breaks it, reports nothing when the repository has no standards, and reports a stale document at the document's line with the changed code as `cause`.
- The `unhandled-error` rule stays broad: it covers a failure the change dropped, swallowed, or left to crash the caller, so in the `standard` tier, where `correctness` runs alone, a deleted rethrow is still reported.
- A document that still states a contract's old behaviour is `conventions`' to judge against the standards, never a `contracts` dependant: a dependant is code.
- A golden declares a second finding for one defect only where a second lens's own instructions claim it: `correctness-deleted-guard` and `removed-behaviour-dropped-guard` each expect both `correctness`'s `wrong-result` and `removed-behaviour`'s `dropped-guard`.

## From [2026-10-05-durability-repository-lens.md](2026-10-05-durability-repository-lens.md)

- `durability` lives in Melian's own repository, at `.melian/lenses/durability/LENS.md`, not under `packages/core/lenses/`.
- It reviews `packages/pipeline/src/**`, `packages/github/src/**`, and `packages/cli/src/**`.
- Melian's root `melian.yaml` names it in the `full` tier beside the built-in lenses.
- A repository lens is read from the revision the host chooses, as policy is, so a pull request cannot rewrite the lens that reviews it.

## From [2026-10-05-per-file-hand-offs.md](2026-10-05-per-file-hand-offs.md)

- A lens hands a defect to a neighbour in the files the neighbour reviews among its own, and keeps it in the rest. When the neighbour reviews some of the lens's files, the lens's instructions name the neighbour, the defects it owns, and those files, quoted as the change's data.
- When the neighbour reviews every file, the instructions say so without a list. When it reviews none, no hand-off renders.
- A list holds at most 40 files and 4 KiB; past either, the hand-off to that neighbour is left out, the lens keeps its defects in every file, and the lens's check record names the neighbour.
- A renamed file counts as one file: a neighbour selected through its old path covers its head path, and one over its head path covers its old path.
- The standards section keeps the stricter rule: a breach goes to `conventions` only when `conventions` reviews every file the lens reviews.
- Melian's own repository extends the built-in `correctness` and `removed-behaviour` at `.melian/lenses/correctness/LENS.md` and `.melian/lenses/removed-behaviour/LENS.md`, each with a `handoffs` entry for `durability`.
- `durability` keeps a superseded or stale task's write even when it races a live caller, so its hand-off to `correctness` and the overrides' hand-offs to it name one owner for that defect.

## From [2026-10-07-capped-neighbour-leaves-review-not-reviewed.md](2026-10-07-capped-neighbour-leaves-review-not-reviewed.md)

- The `ended` record of a lens at its findings budget gives a reason naming the budget, and the lenses that could have handed it defects when there are any.
- `handedBy` records that a hand-off instruction rendered for the neighbour, not that the handing lens found a defect, so an `ended` reason may name a lens that handed nothing.

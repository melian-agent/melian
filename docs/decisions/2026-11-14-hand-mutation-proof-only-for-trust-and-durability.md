# The hand mutation proof is owed only for code that guards trust or durability

Amends: [Tested means a failing mutation](2026-10-07-tested-means-a-failing-mutation.md), which guards must be proved by a run mutation before a commit
Amends: [Builders enumerate Stryker mutants before claiming coverage](2026-10-21-builder-mutant-inventory.md), which changes owe an inventory
Amends: [a mutation proof runs each claim against its named test alone](2026-11-04-mutation-proof-scope.md), which mutants a builder proves

The maintainer ruled on 2026-11-14, in the coordinator's session: "Lets narrow it."

## The problem

Every pull request owed an inventory of every mutant Stryker would plant in its changed lines, each run by hand against a named test. Across the last 20 merged pull requests that took 19% of builders' reported working time, 1,139 of about 5,900 minutes, behind only gates and Melian rounds. On 2026-11-14 it also produced a ruling, two docs pull requests, and a 150-line tool change that took six review passes.

What it bought is thin. First runs do find untested code: [pull request #404](https://github.com/melian-agent/melian/pull/404) found 27, 5 and then 6 survivors and wrote tests for them. But no one has shown that a survivor pointed at wrong behaviour, or that the tests lens would not have flagged the same lines. Fifteen full reruns between 5 and 7 November found nothing the first runs had missed. The ten test-quality findings the rounds raised in that window were all outside what the enumerator lists.

## The rule

- A builder owes the enumeration-first inventory, with every claimed mutant run by hand, only for changed code that guards trust or durability.
- Trust code decides who or what Melian trusts, what a verdict blocks, what runs with a credential or outside a sandbox, or what a key matches. Durability code writes or migrates a stored shape, resumes after a crash, or publishes.
- Every other change owes no inventory. Its fix starts with a failing test, its new behaviour has a test, and the tests lens reports `untested-behaviour` at its usual severity.
- The pull request's description lists its changed files that guard trust or durability, or says there are none. The review of record checks that list against the diff, and a file left off it is a P2 finding.
- An inventory already written for a pull request in flight stands for the code it covers, and no one extends it to ordinary code. A later commit on that pull request that changes trust or durability code still appends and proves its own mutants, as every fix pass does.

## What this gives up

The 2026-10-07 decision said a guard, branch, bound or early return counts as tested only when a test fails with it inverted or removed, and that the builder runs that mutation. For ordinary code the builder no longer runs it. A branch whose test passes with the branch removed can now merge if the tests lens misses it; the maintainer chose that cost when he narrowed the proof, with "untested branches in ordinary code go unproved" named as the risk. The standard itself stands, and a reviewer or a lens that shows such a test still reports it.

An untested branch in ordinary code is no longer proved absent. A wrong classification, a trust file left off the list, removes the proof where it matters most; the review of record's check of the list is the guard, and it is a reader's judgement.

## What it does not decide

Whether `melian mutants verify` is still worth building in full. Its first part, the local command, continues. The Actions job waits on the maintainer.

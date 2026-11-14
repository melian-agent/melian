# `melian mutants verify` is not built

Amends: [`melian mutants verify` runs Stryker in sharded Actions jobs](2026-11-13-mutants-verify-runs-stryker-in-shards.md), the job and its commands are not built
Amends: [mutation evidence by enumeration and verification](2026-10-24-mutation-evidence-by-enumeration-and-verification.md), its per-claim verifier is not built; its intent that the tests lens uses the enumeration stands as a later step
Amends: [Stryker leaves this repository's review rounds](2026-10-24-stryker-off-the-hot-path.md), the interim rule becomes the standing rule
Amends: [a mutation proof runs each claim against its named test alone](2026-11-04-mutation-proof-scope.md), the hand-run proof is the standing proof, not a stopgap
Amends: [the final hand rerun is waived until `melian mutants verify` lands](2026-11-10-final-rerun-waived-until-mutants-verify.md), the waiver has no end date
Amends: [reruns are scoped to the pull request](2026-11-09-reruns-scoped-to-the-pull-request.md), the bullet that `melian mutants verify` replaces the hand reruns
Amends: [a coverage ledger decides what a round reviews](2026-10-23-coverage-ledger-and-delta-review.md), mutation coverage from verification records, which nothing now writes

The maintainer decided on 2026-11-14, in the coordinator's session, to stop building `melian mutants verify`: "so the mutant tool reduces to: listing mutants and the ability to filter them to a specific subset of code". Nothing that runs mutants gets built. Earlier the same day he narrowed the hand mutation proof to code that guards trust or durability, with "Lets narrow it.", in [the narrowing decision](2026-11-14-hand-mutation-proof-only-for-trust-and-durability.md).

## The problem

[The shards decision](2026-11-13-mutants-verify-runs-stryker-in-shards.md) planned an Actions job that proves kills with sharded Stryker. It was meant to replace a hand proof that every pull request owed. The narrowing decision cut that proof to the few files that guard trust or durability. The tool would now automate a proof that a handful of files owe.

Example: a pull request that edits an ordinary lens prompt owes no inventory since the narrowing, so the job would run for nothing. One that edits the publish task owes a proof on a few hundred mutants, which a builder can run by hand.

The cost of the tool stays. The planned build was four pull requests and 5,000 to 6,000 changed lines, and its builder is needed on the shared-record builds. Stryker has been dear to run here: [pull request #98](https://github.com/melian-agent/melian/pull/98) reached 13,000 changed lines, AGENTS.md carries about ten learnings on its failure modes, and the maintainer took it off review rounds on 2026-10-24. The hand proofs took 19% of builders' reported working time over the last 20 merged pull requests, and nothing shows the gaps they found were defects.

## The rule

- `melian mutants verify`, `melian mutants verdict`, the sharded Actions job, `melian/mutants`, `.melian/mutants/answers.yaml`, the signed cache of kills and the end check are not built.
- The mutant tool reduces to `melian mutants list` and `melian mutants sample`, both built, and a filter to chosen files ([issue #418](https://github.com/melian-agent/melian/issues/418), in review).
- The hand proof the narrowing decision describes, for code that guards trust or durability, is the standing proof. The phrase "until `melian mutants verify` lands" is gone from the rule.
- The final rerun of earlier claims at the last head stays waived, on purpose and with no end date. Each fix pass proves its own commits' mutants in that code, and that is the pull request's proof.
- Nothing builds the per-claim verifier of the 2026-10-24 decision either: its seven control runs, two-failure rule, fresh worktrees and verification records. The coverage ledger of that decision's step 24 therefore has no mutation records to read. Its mutation rows wait for a source of evidence that a later decision names.

## What stands

- Enumeration and sampling, as built in [issue #239](https://github.com/melian-agent/melian/issues/239).
- The 2026-10-24 decision's intent that the `tests` lens uses the enumeration. The maintainer's idea for later is to give the lens the list of mutants on the lines it reviews ([issue #241](https://github.com/melian-agent/melian/issues/241)). Its first step, reading the list, needs no mutant run.
- From the shards decision, its choice 1 as it applies to hand proofs and policy notices: the coordinator's standing authority of 2026-10-17 to accept equivalent mutants with reasons and hand proofs, and to read policy notices, reporting each. The maintainer confirmed it on 2026-11-14, in the coordinator's session: "I agree with allowing you to accept the written answer of a builder." Its lost-options reasoning for that choice stands too.
- `static.mutation` as an opt-in audit, with the rules of [mutation reruns, as built](2026-10-16-mutation-reruns-later-changes.md), and the Stryker learnings in AGENTS.md.
- The targeted-rerun scope of [the targeted-rerun decision](2026-11-07-targeted-mutant-rerun.md) for a builder who reruns claims by choice, and every other clause of the decisions above that this file does not name.

What does not stand from the shards decision: everything about the Actions job, the shards, the plan, `melian/mutants`, `answers.yaml` and the acknowledge finding it raised, the reuse of kills and its cache, the runner and its timeouts, the end check, and its choices 2 to 6, which only ruled on how that job worked. Where a hand proof needs an answer on file, the builder writes it in the pull request, and the coordinator reads it as before. Its section 7, which said the build's pull request retires the waiver and shrinks AGENTS.md's hand proof to survivors, is void. The hand proof stays for trust and durability code, as the narrowing decision sets it.

## What this gives up

- A kill is proved by a builder's run, never by a tool. A builder can mis-record one, as [pull request #294](https://github.com/melian-agent/melian/pull/294) showed with 64 claims that proved nothing. The review of record's `--sample` is the check.
- A later change can let an earlier kill survive, and no rerun catches it. This was the cost of the waiver, and it is now permanent.
- Customers get no mutant proof from Melian, only the list and the sample.
- The unfinished work is kept, not deleted: branch `archive/mutants-verify-240` holds two commits. One is a core class that decides a run from Stryker's report and an answers file, with 24 passing tests. The other is the pipeline run, the CLI command and a real-Stryker test that never ran.

## What would reopen it

A defect in trust or durability code that reaches `main`, and that a mutant run would have caught. On that decision the coordinator closed [issue #240](https://github.com/melian-agent/melian/issues/240), [issue #414](https://github.com/melian-agent/melian/issues/414), [issue #415](https://github.com/melian-agent/melian/issues/415) and [issue #416](https://github.com/melian-agent/melian/issues/416) as not planned on 2026-11-14. A new issue would carry the case, starting from the archive branch.

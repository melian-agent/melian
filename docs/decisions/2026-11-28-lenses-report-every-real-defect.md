# Lenses report every real defect they meet, on a severity scale

Amends: [Restore the lens-boundaries clauses that partial supersessions retired](2026-11-08-restore-lens-boundaries-clauses.md), what a hand-off tells the lens to do

That decision restates the hand-off clauses of [the per-file hand-offs decision](2026-10-05-per-file-hand-offs.md) and [the boundaries decision](2026-10-04-lens-backlog-boundaries.md), which are no longer active themselves.

Status: agreed by the maintainer on 2026-11-28, in the coordinator's session ("655 looks good, go ahead"), for [issue #655](https://github.com/melian-agent/melian/issues/655).

Choice: A lens reviews as the review of record does. It first learns what the change promises, then attacks each promise. It reports every real defect it meets, whichever lens would own it: under one of its own rules when one fits, and otherwise under `melian/other-defect`, a rule Melian defines for every lens beside `melian/injection-attempt`. It reports a suspicion it could not trace to its end too, saying which step it could not trace. Hand-offs now describe each neighbour's focus; they no longer tell the lens to leave a defect to the neighbour. Every lens rates a finding on one severity scale, by what happens once the change is merged, and the verifier may lower by one step a finding whose own scenario does not meet its level. A document that describes a behaviour no longer refutes a claim that the behaviour breaks something.

## Problem

A lens held back. Its body told it to drop what it could not prove, to leave a defect no rule fits, and to leave a neighbour's defects to the neighbour. The review of record does none of that, and found more. Example: on five merged pull requests, [#597](https://github.com/melian-agent/melian/pull/597), [#601](https://github.com/melian-agent/melian/pull/601), [#604](https://github.com/melian-agent/melian/pull/604), [#625](https://github.com/melian-agent/melian/pull/625) and [#643](https://github.com/melian-agent/melian/pull/643), Melian found 35% of the 24 defects reviewers found at the time, and the review of record 42%.

## Measurement

The coordinator ran the rewrite as an uncommitted experiment, two blind passes on each of the five pull requests:

| Setting | Defects found | Cost per change | Blocking findings in ten runs (deserved) |
|---|---|---|---|
| `main` | 35% | $5.93 | 9 (3) |
| Rewritten lenses, no severity scale | 48% | $8.29 | 22 (6) |
| Rewritten lenses with the severity scale | 50% | $8.05 | 8 (3) |

Reporting outside the rules raised recall and, alone, more than doubled the blocks. The severity scale brought the blocks back to what `main` raised without losing a deserved one.

## Why a rule of Melian's

`report_finding` refuses a rule the lens does not declare, so the model reads the exact IDs and never guesses. A catch-all a lens had to declare would leave every repository lens without it. So `melian/other-defect` is defined once, as `melian/injection-attempt` is: the review adds it to every lens's rules, the policy section lists it with its description, and the hook accepts it. The `melian/` prefix keeps it apart from any rule a lens declares. It holds the lens's own severities; only the injection rule passes outside them. Any other rule a lens does not declare is still refused.

## Consequences

- A golden's expectation matches file and rule, so a live lens that reports a golden's defect under `melian/other-defect` scores it as noise until the expectation lists the rule among its `alternativeRules`, under [the parity decision](2026-11-16-parity-is-with-the-review-of-record.md).
- No key changes. A lens request already holds its rendered instructions and the verifier's version follows its text, so stored runs under the old prompts are never reused; the first round after this lands asks every lens and the verifier again once.
- `findings:` budgets, routes, tiers and levels do not change here. The experiment raised every findings budget to 50; that needs its own ruling.

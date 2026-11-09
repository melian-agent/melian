# Verify each lens's claims as that lens ends

Status: accepted by the maintainer, 2026-11-07, option A in [issue #253](https://github.com/melian-agent/melian/issues/253#issuecomment-6702565990).

Amends: [design.md](../design.md), step 7 of the review flow, which verified each merged candidate once after every lens had ended.
Amends: [2026-11-08-restore-verifier-clauses.md](2026-11-08-restore-verifier-clauses.md), that a revision and input attach to one verification task, and that a replacement task judges every claim again. Waves are verification tasks of their own, and a final task copies the outcome of a wave that still stands for a candidate, judging only the rest.
Amends: [2026-11-08-restore-credentials-clauses.md](2026-11-08-restore-credentials-clauses.md), that one defect is verified once. A defect whose membership never changes is still verified once; one a later lens joins is verified again with every sighting, and the last verification decides.

## Problem

Verification waited for the slowest lens. On the rounds of [pull request #217](https://github.com/melian-agent/melian/pull/217) and [pull request #207](https://github.com/melian-agent/melian/pull/207), the design lens ran 144 to 312 seconds while the others ended in 15 to 77, and verification began only after it stopped.

Starting early has a cost. Every built-in lens covers `**`, so a lens still running can join any defect another lens reported, by snippet or by a shared hunk. Example: correctness ends at 40 seconds with a report on `src/publish.ts:6-7`, and design reports the same default at lines 5-7 at 300 seconds. To verify correctness's claim at 40 seconds is to verify it before its defect is complete.

## Decision

A defect is verified as soon as the lenses that reported it have ended. The lens task records each lens's end. The review then starts a wave: a verification task over the candidates the ended lenses form, while the others run.

- A defect whose membership never changes is verified once.
- A defect that gains a sighting after its first verification is a new candidate. The next wave clears its claims' verdicts and verifies it again with every sighting. Only that verification decides it.
- The final step, once every lens has ended, forms candidates as before, under the same reuse identity. It copies each wave outcome whose candidate is unchanged and asks only for the rest. A repeat review attaches to the task it ran before.

Option B, holding back any defect a running lens could join, saves nothing while every lens covers every file. Option C, judging each claim alone with the other members as context, changes the verifier's prompt and its reuse identity.

## Consequences

A defect the slow lens joins costs one extra verification. Waves run one at a time: the review waits for the running wave before it starts the next. Problem: the first round of [pull request #294](https://github.com/melian-agent/melian/pull/294) found two waves running at once, so the cap of eight verifier conversations held per wave, and a later wave cleared a claim while an earlier wave was still judging it. Example: wave 1 reads claim A, wave 2 clears A and refutes the merged candidate, and wave 1 then stores A as confirmed, which outranks the refutation. Solution: one wave at a time, and a wave owns its writes only until a later wave verifies any of its claims, which the report commit checks, so a replay after a crash is refused too. A wave records the verifier version it ran under, and the final step reuses its outcome only under that version. A lens that ends while a wave runs therefore waits for it; the first wave still overlaps the slower lenses. [Issue #313](https://github.com/melian-agent/melian/issues/313) proposes one verification task per revision, which would remove the wait. The waves live in their own root document, `melian.verification-waves`; a lens task that replaces another starts the entry afresh, so the sweep aborts a replaced run's waves. The verification task is version 3, whose input may carry the reused outcomes.

# A claim's first report stands unless a stronger verdict follows

Status: agreed by the maintainer on 2026-11-28, in the coordinator's session ("agree to both changes"), for [issue #657](https://github.com/melian-agent/melian/issues/657).

Amends: [2026-10-13-re-scope-held-for-the-compiler.md](2026-10-13-re-scope-held-for-the-compiler.md), its sections "What survives: conflicting reports" and "Goldens", for the conflicting reports and the lowering refused for want of evidence
Amends: [2026-11-08-restore-verifier-clauses.md](2026-11-08-restore-verifier-clauses.md), the strongest-verdict rule it restores from the verifier task-scope and conflicting-reports decisions

Choice:

1. `report_verdict` refuses a second report of a claim unless its verdict is stronger than the stored one. A replay of the stored report is taken. Otherwise the first report stands whole: its reason, its evidence, its sameness answers and its lowering. A stronger later verdict still replaces the first report whole, its lowering included, as before. The refusal says which verdict is stored and any lowering it holds.
2. `report_verdict` refuses a lowering with no evidence location at the head before anything is stored, and says that nothing was recorded, so the verifier can send the report again with evidence, or without the lowering.

The old rule is replaced. Under it, a later report at an equal verdict replaced the stored one whole when it was unlowered, so it could undo a lowering and overwrite the reason. It was written for a second judgement of the claim, and it was being met by placeholders.

The goldens of conflicting reports change with it. Both orders now pair a lowered confirmed report with an unlowered plausible one, which leave the claim lowered either way: the weaker is refused after the stronger, and the stronger replaces the weaker before it. A replay after each report shows a replayed report taken and an equal plain report refused. The lowering refused for want of evidence is reported again without the lowering, and the lens's severity stands.

## Problem

A verifier sometimes calls `report_verdict` twice for one claim. The second call's reason is often a placeholder. Both calls were answered `recorded verdict for c1`, and the old rule kept the second whole.

Example: on [pull request #597](https://github.com/melian-agent/melian/pull/597), a blind run's verifier judged finding `45b938f80ee1836d`, a P1 from the design lens, with a full reason, and meant to lower it to P2. It gave no evidence locations, so the fence refused the lowering after the report was stored. Its next call, 3 ms later, was `{"verdict":"confirmed","reason":"Duplicate placeholder; see the lowered report."}`. That placeholder became the finding's only reason. Across 44 runs, about 35 standing findings carry a placeholder as their only reason, and 13 of them block.

## Why each part

- The first report is the verifier's judgement. A second call at the same verdict adds no judgement, and keeping the first is the only way its reason survives. A stronger verdict is a changed judgement and still wins, so a verifier that read further and found the claim real can say so.
- A refused lowering used to arrive only in the answer, after the unlowered report was stored, and then rule 1 would keep that unlowered report. Refusing before the write keeps the verifier's one report a fair one: it learns what is missing while it can still send it.
- The verifier still cannot lower by a second call at the same verdict, which [the re-scope decision](2026-10-13-re-scope-held-for-the-compiler.md) required: that call is refused now, where before it lost to the stored unlowered report.

## What this gives up

A verifier that wants to correct its own reason at the same verdict cannot. It can only send a stronger verdict. A refused report is an error the verifier reads, and a verifier that never sends an accepted report leaves its claim unjudged, so the review reads not reviewed, as it does today for any claim the verifier skips.

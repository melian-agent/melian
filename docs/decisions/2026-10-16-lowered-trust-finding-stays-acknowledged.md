# A lowered trust finding stays at acknowledge

Choice, agreed by the maintainer on 2026-10-16: the verifier's power to lower a severity stands, but a finding it lowers never resolves below `acknowledge` when it comes from the `trust-boundary` lens, or is an `untested-behaviour` finding that guards approval. This is plan step 29, "A floor under lowered trust findings". Nothing is built yet.

## The problem

[The lowering decision](2026-10-12-verifier-lowers-severity-and-sets-scope.md) lets the verifier lower a confirmed or plausible finding one step, with a fence: never a P0, never an injection attempt, never a deterministic finding, never into silence. The fence does not look at what the finding guards.

Example, from [pull request #125](https://github.com/melian-agent/melian/pull/125): in round nine Melian found a cold-run hole as `73ad09e0`, a real P2. The verifier lowered it to a P3 `plausible` advisory, so nobody had to answer it. The Opus review of record found the same hole three rounds later. The power to lower cost a real finding on a trust surface.

## What changes

- A lowering stays visible, with its original severity and reason, as now. After it, a floor of `acknowledge` applies to the defect for two classes: a finding a `trust-boundary` lens reported, and an `untested-behaviour` finding that guards approval. Both are floored only when the verifier lowered them. An unlowered P3 from `trust-boundary` resolves as the table says.
- The floor is a decision-level floor beside the others in `Finding.floored`, and `decidedBy` names it, so `melian findings` shows why a P3 asks for an answer.
- A lowered P1 resolves `acknowledge` already under the default table; the floor matters for P2 to P3, and for a folder whose table maps P2 lower.

## What already holds

The lowering is stored with its original and lowered severity. A lowering never reaches `silent`, and `resolvedAtOriginal` restores the lens's severity where the keys would silence the lowered one. No floor looks at a lowered finding's lens or rule.

## What is not settled

"Guards approval" must come from an authority, not from the model's reading of its own finding: that is the judgement this floor distrusts. The step writes the full decision first. The candidates are path globs in the base `melian.yaml` that name approval code, such as the verdict, status and trust paths, since a pull request is judged under its base's keys; or the lens declaring it in its rule. A model's text does not decide it. [AGENTS.md](../../AGENTS.md) already treats trust and durability as the properties a fix pass's findings must not downgrade; the step reuses its wording.

## What it changes in design.md

The "Lowering has a floor and a fence" list gains the floor, and the floors paragraph under resolution lists it.

# Both failover wordings enter the verification's key

Amends: [Each lens that probes plans, probes and is judged in wording of its own](2026-11-16-probing-wording-per-lens.md), "No verification is asked again", which now holds only until this change lands

Amends: [A verifier's probe evidence fits a fixed budget](2026-11-16-probe-evidence-bounded.md), "Every other verification keeps the key it had", which now holds only until this change lands

Status: the coordinator's answer of 2026-11-18, on approach, for [issue #488](https://github.com/melian-agent/melian/issues/488). It is not a maintainer's ruling.

## Problem

When the verifier's model fails, the next model on its route was always told "Continue judging the labelled claims. Already recorded verdicts remain". When the failed model had done nothing, that told the next one that verdicts existed which no one had given. [Issue #488](https://github.com/melian-agent/melian/issues/488) adds a second wording for that case, which says no claim has a verdict yet and asks for every claim from the beginning. Either wording can reach the verifier, so both belong in the key: [the identity guideline](../guidelines/identity.md) keys what the model is shown.

Two earlier decisions promised that a verification resting on no probe keeps the key it had, so a verdict stored before them attaches and is not asked again. Two tests pinned those keys: `packages/pipeline/test/verification-request.test.ts` and `packages/pipeline/test/verification-request-cut.test.ts`. Adding the fresh wording moves every verification's key, those tests' included.

## Decision

Both wordings enter `verifierText` in `packages/pipeline/src/verification.ts`, as `handover`, in place of the single `continue`, and the two tests pin the new keys. The verifier's version, `verifierVersion`, does not change.

Leaving the fresh wording out of the key would keep the old keys. Then a verification judged under the old wording could stand in for one whose verifier would be told to start afresh, a reuse the key exists to prevent.

Before re-pinning, the builder put the single `continue` back in `verifierText` and ran both tests: all four pinned keys equalled main's at `959a2a69`. So the fresh wording is the only thing that moved them.

## Cost

Every stored verification and wave is asked once more after the upgrade, inside the round that asks its lenses again, since the lens request keys both wordings too. A request names its base and head, so this costs only a review of a revision reviewed before the upgrade, once per such revision. An Actions round throws its store away, so it pays nothing.

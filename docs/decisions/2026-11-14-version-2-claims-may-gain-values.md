# Version 2 of the mutation inventory may gain claim values

Amends: [version-2 samples](2026-11-03-v2-generated-sampling.md), the claim values a version-2 inventory may hold

The maintainer ruled on 2026-11-14, in the coordinator's session, on [pull request #409](https://github.com/melian-agent/melian/pull/409), choosing this over a version bump.

## The problem

[The sampling decision](2026-11-03-v2-generated-sampling.md) keeps the stored version-2 schema and version unchanged. [Issue #406](https://github.com/melian-agent/melian/issues/406) adds a fourth claim, `suite`, for [the suite-assertions decision](2026-11-14-suite-assertions-proved-per-case.md). An inventory holding a `suite` row still says `melianMutants: 2`, and a reader built before that change refuses it as invalid, though it claims a version that reader supports. The Melian round on [pull request #409](https://github.com/melian-agent/melian/pull/409) raised this as finding `041bc339ae3d30f6`.

## The rule

- A version-2 inventory's claims may gain values. The version names the shape the enumerator writes, and the enumerator writes no claims, so its output is unchanged.
- A reader that does not know a claim refuses the whole inventory, and says which claim it does not know. It never reads an unknown claim as a known one, so an older build fails closed. `packages/core/test/mutation-inventory.test.ts` holds this for version 2 and for a legacy inventory.
- Every other part of the version-2 schema stays as the sampling decision set it.

## What this gives up

A build from before a claim value was added cannot sample an inventory holding that value. Sampling it needs a build that knows the claim.

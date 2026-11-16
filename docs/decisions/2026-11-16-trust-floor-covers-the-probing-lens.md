# The trust floor covers Melian's probing lens

Amends: [A verifier cannot clear a protected objection without a maintainer](2026-10-17-trust-floor-exact-rule.md), the protected claims, for `lens.trust-boundary-probes`

Status: ruled by the maintainer on 2026-11-16, in the coordinator's session, for [pull request #494](https://github.com/melian-agent/melian/pull/494).

## Problem

Melian holds every `lens.trust-boundary` claim at a minimum: a verifier that lowers or refutes one leaves it needing acknowledgement. [The trust-floor decision](2026-10-17-trust-floor-exact-rule.md) names the protected claims by their check, and the code names that check twice, in `Finding.trustFloor` and in a restatement's floor.

[Pull request #494](https://github.com/melian-agent/melian/pull/494) adds a second repository lens, `trust-boundary-probes`, which extends `trust-boundary` and probes at `deep`, as [the probing decision](2026-11-16-probing-on-for-melians-own-rounds.md) records. Its claims carry their own check, `lens.trust-boundary-probes`, so neither floor named them.

Example: the probing lens reports a P2 path traversal backed by a failing probe. The verifier lowers it to P3, which advises under the default table. The same claim from `lens.trust-boundary` would need acknowledgement. A restatement of a dismissed root would inherit its dismissal rather than propose it.

## Choice

`lens.trust-boundary-probes` joins `lens.trust-boundary` and `lens.tests` among the checks whose every claim the trust floor protects. Core's `trustFloorChecks` names the three, and both floors read it, so the two lists can no longer drift apart. The floor's minimum, its notes and its stored diagnostics are unchanged, and so is every rule-based protection.

The set names each check whole, with no prefix or pattern, so another lens named `lens.trust-boundary-<something>` is not protected.

## Why

The probing lens holds the trust-boundary lens's own rules and instructions. A finding it reports is the objection the floor exists to keep, and a probe backs it besides. Leaving it outside the floor would let the verifier clear the findings Melian trusts most.

## What it costs

Core names a lens that only Melian's own repository defines. A repository that writes a lens of its own called `trust-boundary-probes` has its claims protected too. That is the stricter side, and no shipped lens has the name.

## Retirement

[Issue #497](https://github.com/melian-agent/melian/issues/497) lets a level that probes also report what it finds by reading. Once it lands, `trust-boundary`'s own `deep` level probes, the second lens goes, and so does this entry in `trustFloorChecks`.

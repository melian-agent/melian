# A verifier cannot clear a trust objection without a maintainer

Supersedes: [2026-10-16-lowered-trust-finding-stays-acknowledged.md](2026-10-16-lowered-trust-finding-stays-acknowledged.md)

Status: proposed for attacking review, plan step 29 phase 1. No runtime change is built by this proposal. Phase 2 waits for the attack.

## Problem and evidence

The verifier may lower a real finding until nobody has to answer it. On [pull request #125](https://github.com/melian-agent/melian/pull/125), round nine reported the cold-run hole as `73ad09e0`, P2 from `trust-boundary`. The verifier lowered it to P3 `plausible`. It became advisory. The review of record found the same hole three rounds later, with a working probe. [The comparison record](../../packages/evals/comparisons/2026-10-16-pr-125.md) records both sightings.

Lowering is not the only way past that boundary. Finding F4 in the attack on [pull request #142](https://github.com/melian-agent/melian/pull/142) points out that refuting every claim removes the defect from the counted groups. A floor on lowered severities alone would leave that route open.

The choice is an acknowledgement floor, not a ban on lowering. A verifier may still report its judgement and reduce severity. For the classes below, lowering or refutation cannot remove the maintainer's obligation to answer.

## Which claims are protected

Classification uses each original claim's producer and rule, before verification and before choosing the merged defect's speaker. A claim is protected when either holds:

1. Its producer check is exactly `lens.trust-boundary`, whatever its rule or path.
2. Its producer check starts with `lens.`, its rule is exactly `untested-behaviour`, and its report's primary path matches the approval paths below.

An extension of the named lens keeps its producer name and qualifies. Another lens calling itself a trust reviewer in prose does not. The second class includes repository lenses declaring that rule, not just `lens.tests`. `mutation/untested-behaviour` from `static.mutation` is deterministic and does not qualify for lowering. Its existing fence remains.

The report's primary path is the canonical repository-relative location Melian stored, not a path extracted from prose or a verifier's evidence. Evidence locations do not widen membership. For a renamed file, membership tests both its old and new path from `Revision`; either match protects the report. Classification belongs to the original report, including a non-speaking member and every sighting of one ID. A refuted claim remains available for this classification.

### The authority for approval paths

Introduce `trust.approvalPaths` in the committed root `melian.yaml`. It is a non-empty array of positive path globs, rooted at the repository. It defaults to `["**"]`. Use core's glob compiler and matcher, including dotfiles and newlines. Reject exclusions, invalid globs and paths escaping the repository. Nested files and preference files cannot set it, just as they cannot set `trust.writers`.

The host supplies this root policy from its chosen source. A pull request always uses the base commit. A checked-out local range keeps its existing working-tree policy rule. A head's added or narrowed list cannot classify that head's findings. Unreadable or invalid policy refuses review; it never becomes an empty list. In core, `ResolutionSource.approvalPaths` carries the root list to adjudication. Absence on an older caller means `["**"]`.

Here, "guards approval" means membership in that policy list. No model decides whether a function grants approval. The default protects every lens-reported test gap; a maintainer may narrow it after reviewing the repository's approval surface. For example, `["packages/*/src/**", "scripts/**", ".github/**"]` covers Melian's source and workflow paths, and leaves documentation fixtures outside it. This proposal does not narrow Melian's own policy.

A narrowed list can miss approval code or a report placed outside it. That is a limit of explicit path policy. Adding approval code outside the list requires updating the list. The default avoids that omission at the cost of more acknowledgements. No classifier can recover a claim a lens never reports, or reclassify a different rule by reading its prose.

## Lowering and the floor

An accepted lowering keeps its existing meaning: severity changes by one step, and the verification record keeps the original, target and reason. A P2 lowered to P3 stays P3. It does not revert to P2 for display or ordinary resolution.

For a protected claim with an accepted lowering, the defect's final resolution is at least `acknowledge`. Resolve the standing reports under their own tables and ceilings, apply the existing caps, take their strictest result, then apply floors. The trust floor never turns `block` into `acknowledge`.

A P1 lowered to P2 usually resolves `acknowledge` already. The floor matters for P2 to P3, and for a path whose table or ceiling would advise or silence the result. An unlowered protected claim keeps its ordinary resolution unless it is refuted under the next rule. An unlowered P3 that stands may remain advisory.

All other lowering fences survive: never raise severity; never lower P0; never more than one step; never to `nit` or a severity the policy resolves `silent`. Never lower an injection attempt, a deterministic report, or a defect with a deterministic co-report. Only the LLM executor may lower a confirmed or plausible claim, with evidence Melian reads back. A refuted report cannot also request lowering. A refused lowering still records the verdict and returns its refusal reason.

The existing second fence against silence remains: if policy would silence an accepted lowered severity, resolution reads the original severity and records `resolvedAtOriginal`. The new floor then applies after caps. It also overrides a `silent` ceiling or mapping when the restored original would still be silent. Lowering and its reason stay visible.

## Refutation

A verifier's refutation of a protected claim retains an unresolved objection at exactly an `acknowledge` minimum. It does not retain that claim's original blocking requirement. Refutation may therefore reduce a P1 objection from `block` to `acknowledge`, but only a maintainer's dismissal clears it.

The verifier still stores `verdict: refuted`, its reason and evidence. Do not rewrite it as plausible or confirmed. Exclude the refuted claim from ordinary resolution and severity selection, as step 27 does today. Separately, its protection supplies the floor. If every claim is refuted and at least one is protected, start ordinary resolution at `silent`, apply the floor, and keep the defect in `findings.acknowledge`, never solely in `refuted`.

If another report stands, keep that report's ordinary requirement and headline under step 27, then apply the floor. A standing P0 still blocks. A standing P3 beside a protected refutation needs acknowledgement. If every claim is refuted and none is protected, the defect keeps today's `refuted` handling. An unjudged protected claim alone gets no new floor: the existing unjudged cap and incomplete-verifier rule stand.

This rule covers verifier refutation. A higher scrutiny lens's explicit withdrawal of its own quick finding remains the escalation rule; it is not a verifier judgement. Other lenses' refutations and lowerings may still remove obligations. The proposal deliberately protects these two classes, not every finding that might concern trust.

## Merged defects, dismissal and the status

Step 27's grouping, speaker ID, alias ownership and ordering stay independent of verification. Do not regroup to implement this floor. Inspect original claims from every live report, including a member the speaker outranks and a sighting that did not win its ID. Do not infer a trust lowering from a merged `originalSeverity`, a `reportedBy` label, or another claim's lowered verdict. The same protected claim must hold the lowering or refutation.

A protected lowered or refuted member floors the whole defect after caps, whichever member speaks. A dismissed report listed as context is not live and supplies no floor. Dismissal follows step 27: a member ID or `--only` dismisses that report alone; dismissing a speaker does not dismiss members joined only by a hunk. A live protected member therefore keeps an acknowledgement after another member is dismissed. A dismissed protected report supplies no new acknowledgement until the existing lifecycle reopens it.

Pre-existing and unproved affected claims get the same floor after their caps. They never become `block` because of it. Unlike the display-only lift for "Pre-existing, important", the trust floor counts toward the status even when it alone lifts a finding above `silent`.

Step 28 owns the status mapping. Once it lands, an undismissed floored finding counts once as an acknowledgement and makes `melian/review` fail. A maintainer's dismissal with a reason clears that obligation, subject to step 28's authority rules. Step 29 adds no dismissal command, writer inference, CLI exit code or status exemption. Before step 28 lands, an acknowledgement still does not fail the published status; step 29 alone cannot promise a merge gate.

## Stored decision and presentation

When it raises the requirement, `decidedBy.floor` names `lowered-trust` or `refuted-trust`. Refutation wins that label when both reasons apply. Existing stronger floors and requirements remain in force.

Add optional `decidedBy.trustFloor`, an array of `{ id, source, ruleId, action, path }`. `source` is the original producer, including its version when present; `action` is `lowered` or `refuted`; `path` is the report's primary path. Include every qualifying live claim whose judgement calls for the minimum, even when another requirement already meets it. Deduplicate by claim identity and action, and sort by ID, check, version, rule and action. The existing claim verification records supply the verdict, severities and reason. A lowering on a merged member must remain readable there even if the speaker's severity did not change.

Terminal `review` and `findings`, JSON, inline GitHub comments, body findings and the ledger show the obligation. Each protected judgement has a line identifying its claim ID, check and rule, judgement, original and lowered severity when applicable, and reason. The fixed explanation is **Trust floor: acknowledge required; maintainer dismissal needed.** For refutation add **Verifier refuted this claim; maintainer review still required.** These lines render by default, even without the terminal's decision-detail option. Escape every model string through the existing terminal and GitHub renderers.

For the motivating case, the maintainer sees P3 lowered from P2, `plausible`, the verifier's reason, and the trust-floor explanation in the acknowledgement group. A refuted protected defect appears there with its refutation, not under a hidden all-findings option. A standing speaker beside a protected refutation keeps its own headline and lists the refuted member's objection separately. The verification summary still counts that claim as refuted. It is not a confirmed finding for eval recall merely because policy requires an answer.

Phase 2 must version stored shapes that gain these fields, preserve older records without inventing judgements, and add reopen tests from fixtures written by each supported old version. A new review recomputes policy and the floor; displaying an old stored verdict does not silently re-adjudicate it. Dismissal continues to decide from its stored adjudication input, so that input must retain the approval paths and rename outline used by the review. No dismissed objection reopens solely because the floor was added.

## Validation and rollout

Phase 1 commits ordinary failing regression tests against the current code and records their output. They stay red to expose what phase 2 must build. No implementation, stored migration or live model run belongs in this phase.

Phase 2 must kill mutations for classification by check, rule and path; missing policy defaults; base-policy provenance; rename membership; claim-specific lowering; refutation retention; caps and ceilings; strictest merged requirements; dismissed context; status counting; and each output. Use real zero-context diffs for hunk merges. Add scripted goldens for lowered trust P2, standing trust P3, approval test gaps inside and outside the list, other lowered lenses, and protected refutation. The whole gate must pass after implementation.

The proposal changes the "Verification", "Lowering a severity", and resolution-floor passages in `design.md`. Those passages remain labelled planned until phase 2. The pull request body carries their proposed wording for the attacking reviewer.

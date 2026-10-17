# A verifier cannot clear a protected objection without a maintainer

Supersedes: [2026-10-16-lowered-trust-finding-stays-acknowledged.md](2026-10-16-lowered-trust-finding-stays-acknowledged.md)

Status: built in [pull request #144](https://github.com/melian-agent/melian/pull/144), after the phase-1 attack and coordinator rulings F1–F5.

## Problem and evidence

A verifier may lower or refute a real finding until nobody has to answer it. On [pull request #125](https://github.com/melian-agent/melian/pull/125), round nine reported `73ad09e0`, a trust-boundary P2 about a cold run reusing planted mutation results. The verifier lowered it to plausible P3, which advised. The review of record found the hole three rounds later with a probe. [The comparison record](../../packages/evals/comparisons/2026-10-16-pr-125.md) records both sightings.

The attack read 217 rounds from 78 stores. The phase-1 floor would have raised 12 distinct findings: two lowered and ten refuted. Two refuted trust P1s, `be0f7db9` and `1222cd57`, are valid in [the record for pull request #98](../../packages/evals/comparisons/2026-10-16-pr-98.md). Refutation therefore needs the floor too. F1 reduces the protected refutations needing acknowledgement from ten to five under the historical policies.

Example: a trust P2 under `P2: advisory` advises before verification. An unconditional acknowledgement floor would make the same claim stricter after the verifier lowered it. The solution bounds each claim's minimum by what it required at its reported severity. Verification keeps its judgement; policy decides what the maintainer must answer.

## Protected claims

Classify original live claims by their stored reporting check and rule, before choosing the merged speaker. Protect:

- every `lens.trust-boundary` claim;
- every `lens.tests` claim, including rules added later;
- every lens claim with rule `untested-behaviour`;
- every lens claim with rule `melian/injection-attempt`.

Every path qualifies. There is no `trust.approvalPaths` key or path classifier. Evidence and prose cannot enrol a claim. An extension keeps the named lens's check and qualifies. A deterministic `mutation/untested-behaviour` report is outside this set and keeps its existing lowering fence.

The tests lens owns vacuous, weakened and skipped tests, including ones guarding trust boundaries. Protecting only `untested-behaviour` would let those rules escape. Other lenses' trust-related rules stay outside the set. Examples include design's `fail-open-default`, `capability-by-class` and `trust-by-label`, and the correctness and removed-behaviour hand-offs. This is an explicit limit. No floor recovers a claim a lens never reports. A higher scrutiny lens's withdrawal of its quick claim is not a verifier judgement and supplies no floor.

## The minimum

For each protected claim the verifier lowered or refuted, resolve that same claim at its reported severity, ignoring verification. Use its own check, rule, lens version, path policy, table and ceiling. Apply the same cause caps as ordinary resolution. As in step 27, those caps read the merged defect's cause and proof. Existing policy, injection and important-pre-existing floors still apply to this ordinary counterpart.

The claim's minimum is the lesser of `acknowledge` and that ordinary counterpart's resolution. Take the strictest of the standing reports' ordinary results and every protected minimum. A minimum never weakens a stricter result. The new floor cannot rate a judged claim above its ordinary counterpart.

Thus a default introduced trust P2 lowered to P3 needs acknowledgement. Under `P2: advisory`, it stays advisory. An advisory ceiling or pre-existing cap also stays advisory; a silent counterpart supplies no visible obligation. A P1 refutation drops its ordinary block but keeps acknowledgement under default policy. A refuted P3 test gap advises, just as the same claim confirmed would. Unjudged and standing unlowered claims receive no new floor.

An accepted lowering still changes severity by one step and records its original, target and reason. The floor never rewrites P3 as P2. Every previous fence survives: never raise severity; never lower P0, more than one step, to nit, or to a severity policy resolves silent. Never lower an injection attempt, a deterministic report, or a defect with a deterministic co-report. Only the LLM executor lowers a confirmed or plausible claim, with evidence Melian reads back. A refuted claim cannot request lowering. A refused lowering still records its verdict and returns the refusal reason.

Resolution checks the silence fence again. If a later policy silences an accepted lowered severity, use the original severity and record `resolvedAtOriginal`. The new floor respects the original counterpart's policy rather than overriding its tables, ceilings or caps.

## Refutation, merging and dismissal

Keep `verdict: refuted`, its reason and evidence. A refuted claim supplies no ordinary blocking requirement beside a standing report. When every claim is refuted and at least one is protected, begin ordinary resolution at silent and apply the protected minima. Retain the defect in its resolution group when any minimum is above silent. Otherwise keep the existing hidden `refuted` group. A standing P0 still blocks beside a protected refutation. The verification summary still counts each refuted claim as refuted.

The floor runs before adjudication partitions all-refuted defects. A floor applied only inside resolution would still disappear in that partition, as the existing injection-attempt floor did.

Step 27 still owns grouping, alias ownership, speaker IDs and ordering. Inspect the original claims of every live report, including non-speaking members and losing sightings of one ID. A label or merged original severity cannot lend one claim another's judgement or severity. The same protected claim must hold the lowering or refutation. Newly merged claims retain their own reported severity.

Dismissed context supplies no live minimum. Step 27 also owns dismissal: a member ID or `--only` dismisses that report alone; a speaker's dismissal includes snippet members but leaves members joined only by a hunk live. A remaining protected member can therefore ask again. Dismissed findings stay outside all counts. The existing lifecycle alone decides when a changed defect reopens.

An unresolved floored defect counts once. A visible protected minimum still counts when the important-pre-existing floor already meets the same resolution; that floor’s label alone cannot make it a display-only lift. Unlike the display-only important-pre-existing lift, its protected minimum counts toward attention. [Step 28](2026-10-16-acknowledge-fails-the-status.md) owns the status mapping and dismissal authority. Until [pull request #142](https://github.com/melian-agent/melian/pull/142) lands, acknowledgement alone does not fail the published status. This step adds no status exemption, command, exit code or writer inference.

## Stored decision and outputs

`decidedBy.floor` names `lowered-trust` or `refuted-trust` when that minimum raises the result. Existing stronger requirements remain. On a tie the first deciding floor keeps its label.

Optional `decidedBy.trustFloor` retains each qualifying claim's ID, source, rule, primary path, reported severity, action, minimum and verification record. It includes minima already met by another requirement. Deduplicate by ID, check, version, rule and action, then sort by those keys. It stays outside publication fingerprints with the rest of `decidedBy`.

Terminal output, JSON, inline GitHub comments, body findings and the ledger carry these diagnostics. Default rendering names the claim, reporting check and rule, judgement, reported severity, minimum and reason. A lowering also shows its target and reason, even on a non-speaking member. When any minimum is acknowledge, show **Trust floor: acknowledge required; maintainer dismissal needed.** For lower minima, say that reported-severity policy requires no acknowledgement. Refutations also say **Verifier refuted this claim; maintainer review still required.** Each host escapes the text with its existing renderer.

A protected refutation in a counted group appears in comparisons through `Verdict.attention()` and remains open in SARIF. That is an obligation to review, not a confirmed claim. Golden scoring already excludes refuted claims and grants no recall credit for this floor. This step changes neither comparison scoring nor SARIF's severity mapping.

## As built

`Finding.trustFloor` derives each minimum through the existing resolution walk, caps and ordinary floors. `Defect.decision` gathers them from its reports. `Finding.floored` applies them and stores their diagnostics. Adjudication retains all-refuted defects only when a protected minimum is visible. `Finding.trustFloorNotes` supplies plain text that terminal and GitHub renderers escape.

A member claim gains optional `severity`; old stored claims leave it absent. The floor uses an old claim's lowering source severity when available, otherwise the report's original severity. Original producer sightings retain their severities, so reading them anew reconstructs exact claims. Nothing invents missing historical judgement or severity on a stored verdict.

FindingsDocument rises from 8 to 9, VerdictDocument from 9 to 10, and PublishedDocument from 7 to 8. Their existing migrations preserve old values. No task definition or configuration changes. Verifier transport omits the new claim severity: the existing trusted label remains its authority, and the attachment key keeps the previous claim shape. The recorded fixture uses the previous definitions before implementation. Its SQLite reopen test checks unchanged old output, then persists a fresh adjudication and reopens its new diagnostics. Displaying an old verdict does not re-adjudicate it or reopen a dismissal.

Phase 1 recorded red regressions. Phase 2 rewrites them to the rulings and records both the red and green runs. Direct core tests cover the floor, caps, merging, same-ID severities, refutation, dismissal exclusion and diagnostics. GitHub tests cover the shared comment renderer. A hand mutation inventory accompanies the pass; the coordinator runs the host mutation check before the first full round. No live model call belongs to this pass.

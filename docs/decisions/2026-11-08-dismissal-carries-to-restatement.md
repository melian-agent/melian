# A dismissal carries to a restatement

Amends: [An unresolved acknowledgement fails the status, as built](2026-10-17-acknowledge-status-exact-rule.md), a restatement that inherits a dismissal counts as dismissed
Amends: [Dismissal](2026-10-04-dismissal.md), a dismissal's identity and who it names

Status: decided by the maintainer on 2026-11-08, in two sessions, for [issue #315](https://github.com/melian-agent/melian/issues/315). Rulings 1 and 2 were given in the builder's session. Rulings 3 and 4 were revised in the coordinator's session after its attacking review. [The rulings](https://github.com/melian-agent/melian/issues/315#issuecomment-6718171211) and [the review](https://github.com/melian-agent/melian/issues/315#issuecomment-6718266328) are on the issue. [Issue #334](https://github.com/melian-agent/melian/issues/334) owns how an inheritance changes the verdict's fingerprint.

## Problem

A dismissal attaches to one finding ID, and the ID hashes the rule, the file and the snippet. A lens that words the same defect afresh in a later round cites other lines. The new lines give a new ID, so the dismissal does not carry, and the maintainer dismisses the same ruled defect again, a round each time.

Example: [pull request #282](https://github.com/melian-agent/melian/pull/282) raised the tsc `extends` gap three times, as `46f82987584733f5`, `b1a6ff512ad0f7d0` and `f91696ff1acd9e99`. Each needed its own dismissal under one ruling, and each restatement cost a round of about 15 minutes.

## Decision

A live lens finding N at revision R inherits the dismissal of an earlier finding D when every condition below holds. The verifier judges sameness. Melian applies everything else, and fails closed.

1. **D is a root.** D carries a human dismissal, recorded by `melian dismiss`, that stands. An inherited dismissal is never a root, so chains cannot form. D's dismissal records the severity the verdict showed when it was made. A dismissal stored before this decision has no recorded severity and never carries.
2. **Same rule, same file.** N's path at R is D's path, with no rename. Every lens claim merged into N has D's rule. N has no deterministic member: a static, guardrail or mutation report is never dismissed by inheritance. A `melian/injection-attempt` claim neither inherits nor proposes.
3. **D's dismissal still stands at R.** Its accepted trigger still holds under the reopen rule D's own sighting would meet: for an introduced D, a hunk of D's file at R has the accepted trigger hash. For an affected D, every accepted proving hunk is at R.
4. **The region is unchanged.** Git maps D's region from D's last-seen head to R's head, through `git diff --unified=0` with core's pinned diff flags, `--attr-source=<R's base>` and `--no-renames`. A hunk that touches D's region, or sits next to it, changes it. So does an insertion inside it or beside it. Every line of N's region must also be untouched in that diff, and every hunk in N's proof must be one D's accepted proof holds. The mapped D region must overlap N's region. A binary file, a `-diff` file and any git failure leave the region unmapped, and nothing carries. Core's `Revision` overlap test reads a zero-count side as no touch, so the mapping does not reuse it.
5. **The verifier judges each claim the same.** The verifier sees D's failure scenario and evidence, never D's dismissal reason. It answers `same` or `different` against each predecessor, for every lens claim merged into N. A claim with no judgement, an unjudged quick claim, a failed or refused verifier, and a `different` answer all leave N live.
6. **The severity fence.** The highest severity any lens reported for N's claims, before any lowering, must not exceed D's recorded severity.
7. **Trust-floor claims propose.** When any claim merged into N comes from `lens.trust-boundary` or `lens.tests`, or has the rule `untested-behaviour`, N does not inherit. It stays live at its floor and names D as a likely match, so one `melian dismiss` accepts it. A restatement held back by the fence proposes in the same way.
8. **Choosing among predecessors.** Melian applies the fence and the trust-floor rule to each predecessor judged `same`. It then takes the one with the latest dismissal. Each N names one root at most.

**Each round re-derives the inheritance.** After verification and before adjudication, one commit replaces the revision's whole set of inheritances and proposals, built from that round's stored judgements. So a `different` answer revokes an earlier inheritance, and so does a `verifierVersion` bump, whose new records start empty. An inheritance also lapses on read when its root reopens or its dismissal is replaced.

**What it amends.** The acknowledgement rule says a maintainer clears an acknowledgement by dismissing it by ID. An inherited dismissal also clears it, because the maintainer dismissed the same defect under its root's ID. The dismissal decision says a dismissal names who made it. An inherited one is stored with `melian` as its dismisser and `inheritedFrom` naming the root, so no record claims a person dismissed an ID they never saw. Every other clause of both decisions stands.

**Attribution.** An inherited dismissal is shown as "dismissed, inherited from `<D>`", with D's reason and time. It never names D's dismisser. The terminal, the review body, the inline reply, the ledger and the status all show it. A proposal is shown as "likely the same as dismissed finding `<D>`", with the command that accepts it.

## Why

**Why the verifier judges sameness, and Melian judges the rest.** Rule, file and region are facts git and the stored record answer. Whether two worded claims describe one defect is a judgement only a reader can make, and the verifier already reads both claims' code.

**Why the trust floor proposes instead.** The trust floor exists so the verifier alone cannot silence a protected claim. A `same` answer from the verifier would do exactly that. Arguing sameness is also not something the injection defences can catch: a head that wants a protected claim silenced can word it to look like a dismissed one. A proposal costs the maintainer one command and keeps the floor's guarantee.

**Why git maps the region.** A restatement usually arrives after a fix push, which moves lines. A rule limited to one revision would miss most of the cases on [pull request #282](https://github.com/melian-agent/melian/pull/282) and [pull request #308](https://github.com/melian-agent/melian/pull/308). Git is the authority on how lines moved, and the pinned flags keep its answer independent of the user's configuration.

**Why the fence.** The dismissal answered a defect at the severity the maintainer saw. A restatement at a higher severity asks a question the maintainer has not answered.

## What this gives up

- A restatement whose code moved by an edit next to it never inherits. Neither does one that a lens merged with a claim under another rule, or one with a deterministic co-report. Each stays live, and the maintainer dismisses it as before.
- A wrong `same` from the verifier silences a non-floor claim that is a different defect. The fence bounds it to the dismissed severity, and the inheritance is shown, naming the root, wherever the dismissal is.
- Every dismissal made before this decision keeps today's one-ID behaviour.

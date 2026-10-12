# The verifier may lower a severity one step and propose a pre-existing scope

Status: planned for milestone 2, step 17, "The verifier lowers severity and sets scope". Nothing here is built.

Problem: the verifier can keep a finding or drop it, and nothing in between. A lens sets the severity, and a verifier that confirms the mechanism also confirms that severity, however narrow the failure turns out to be. The verifier also answers whether the failure was there before the change, and nothing reads that answer.

Example: a lens reports a P2 on a parse call that fails for one malformed input. The verifier reads the callers and confirms it. It also finds that the only caller validates that input first, so the failure needs a second defect to appear. The finding is real, so it is not refuted. It stays P2 and the author must acknowledge it.

Two tools show the same gap from outside. In [the CodeRabbit sample](../research/2026-10-12-coderabbit-categories.md), authors dismissed 15% of major findings and 4% of minor ones. The severity the reviewer was surest of was the one most often rejected. And the `code-review` plugin for Claude Code keeps a list of false positives that excludes pre-existing issues, as [the note on its review angles](../research/2026-10-12-claude-code-review-angles.md) records.

## What exists today

`report_verdict` already takes three answers, `code`, `guard`, and `base`, beside the verdict. It validates them and stores none. It reads a refutation's evidence locations back and returns them to the verifier, and stores none of those either. The `verification` record holds the verdict, the reason, an optional correction, the executor, the model, and the version. So step 17 changes a stored shape, and it owes a version bump and a reopen test written by the old version.

## Choice

The verifier may lower a finding's severity by one step, and never raise it. It may propose that a finding is `pre-existing`, and Melian decides that mechanically. Both move a finding toward requiring less, never more.

### Lowering

- A lowering is one step: P1 to P2, or P2 to P3. No other lowering exists.
- A P0 is never lowered. Nothing is lowered to `nit`, or to any severity the default table resolves `silent`.
- A `melian/injection-attempt` finding is never lowered.
- A deterministic finding is never lowered, and neither is a defect a static, guardrail, or mutation check co-reported.
- A lowering rides only on a `confirmed` or `plausible` verdict.
- A lowering needs evidence locations, as a refutation does. Melian reads them back and, from step 17, stores them. Without them the lowering is refused and the lens's severity stands.
- Only the LLM verifier lowers. The decision-model executor may not.
- A lowering is always shown with the original severity and the verifier's reason: in the terminal, the ledger, and the JSON. An author reads "P3, lowered from P2" and why.
- The lens's severity stays stored. Adjudication resolves the finding at the lowered one.

### Scope

Cause by location stays the authority, as [cause by location](2026-10-03-cause-by-location.md) set it. The verifier proposes `pre-existing`. Melian accepts the proposal only when all of these hold:

1. None of the finding's evidence locations, whatever its role, sits on a changed line.
2. No deterministic check co-reported the defect.
3. The finding is not `affected`. An `affected` finding rests on a proving `cause` location in changed code, and this route never demotes one.
4. The verifier names the failing lines, and Melian itself confirms they are byte-identical in the pre-image of the same path at the base. A renamed file's pre-image is its old path.
5. The verifier's reason states that the whole failure path existed at the base, its trigger and its guard included.

A copy of base code to a new place is `introduced`. Every line of the copy is an added line, so rule 4 fails. A function moved to another file fails the same way. The change wrote those lines, and the change answers for them.

Example of what the rules stop: a helper sat behind validation at the base. The head adds a caller that skips the validation. The helper's failing lines are byte-identical at the base, but the lens's `cause` location is the new caller, a changed line. Rule 1 refuses the proposal, and the finding keeps its cause.

Example of what they allow: a lens reports a finding over a whole function, lines 10 to 40, because the change edited a comment on line 20. Location makes it `introduced`. Its evidence and the failing lines are lines 30 to 32, untouched and identical at the base. The proposal holds, the cause reads `pre-existing`, and the advisory cap applies.

Melian cuts hunks to changed lines alone. So that is the only kind of finding the route reaches: one whose own range overlaps a changed line while none of its evidence does. The lens's own cause stays stored beside the result.

### Conflicting reports

The grain is the claim. Each lens sighting is one claim, and a lowering or a scope proposal belongs to the stored record for its claim.

- The strongest verdict still wins: `confirmed` over `plausible` over `refuted`, as [conflicting verifier reports](2026-10-06-verifier-conflicting-reports.md) set it. A weaker report leaves the record unchanged.
- On equal verdicts for one claim, the record keeps the higher severity and the stronger scope: `introduced` over `affected` over `pre-existing`. A later equal report never weakens a stored one. So two `confirmed` reports that disagree on a lowering leave the finding unlowered, in either order.
- The merged defect takes the highest severity among its claims after lowering. A claim no verifier judged keeps its own severity. The merge keeps the strongest cause any member gave, as it does today.

The guard runs in the report's commit, replay included.

## What this leaves alone

A correction stays text shown beside the finding, which changes nothing. The lowering is a separate typed field. So this refines [the verification pass](2026-10-04-verification-pass.md) and [the verifier as built](2026-10-05-verifier-as-built.md), and replaces neither. It leaves [resolution ownership](2026-10-03-resolution-ownership.md) alone: the verifier stores a severity and a proposal, and only adjudication writes a resolution.

Lowering is not scoring. Milestone 4 plans a decision model that scores severity and confidence as calibrated probabilities. A lowering has no number, and `confidence` stays reserved for the decision model. Each lowering, stored beside the lens's severity and joined to what the author did next, becomes calibration data for that scoring.

## What this gives up

A second model can still move a P1 out of the blocking set without refuting it: P1 to P2 stops blocking under the default table. The verifier reads the head, which the author writes, so an author can argue a severity down. The fence bounds the loss to one step, never to silence, and never on a P0. The original severity is always shown. The failure to design against is unchanged: a real P1 lost on a model's word.

## Goldens

They live in the verifier corpus, `packages/evals/verifier/`.

Lowering:

- a narrow trigger that earns one step;
- a P0 that keeps its severity;
- a lowering refused for want of evidence;
- a deterministic co-report that keeps its severity;
- a hostile claim that argues its own severity down, and is not lowered.

Scope:

- a pre-existing callee reached by a new caller stays `introduced` or `affected`;
- a removed guard stays the change's;
- a changed configuration value that triggers old code stays the change's;
- a copy-pasted buggy function stays `introduced`;
- a true pre-existing case is capped at advisory.

Conflicting reports:

- duplicate calls for one claim in both orders, one lowering and one not;
- two scope answers that conflict;
- a replay after each report.

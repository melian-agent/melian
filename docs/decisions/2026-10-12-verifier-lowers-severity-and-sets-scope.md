# The verifier may lower a severity one step and set a pre-existing scope

Status: planned for milestone 2, step 17, "The verifier lowers severity and sets scope". Nothing here is built.

Problem: the verifier can keep a finding or drop it, and nothing in between. A lens sets the severity, and a verifier that confirms the mechanism also confirms that severity, however narrow the failure turns out to be. The verifier also answers whether the failure was there before the change, and nothing reads that answer.

Example: a lens reports a P2 on a parse call that fails for one malformed input. The verifier reads the callers and confirms it. It also finds that the only caller validates that input first, so the failure needs a second defect to appear. The finding is real, so it is not refuted. It stays P2 and the author must acknowledge it.

Two tools show the same gap from outside. In [the CodeRabbit sample](../research/2026-10-12-coderabbit-categories.md), authors dismissed 15% of major findings and 4% of minor ones. The severity the reviewer was surest of was the one most often rejected. And the `code-review` plugin for Claude Code keeps a list of false positives that excludes pre-existing issues, as [the note on its review angles](../research/2026-10-12-claude-code-review-angles.md) records.

## What exists today

`report_verdict` already takes three answers, `code`, `guard`, and `base`, beside the verdict. It validates them and stores none. It reads a refutation's evidence locations back and returns them to the verifier, and stores none of those either. The `verification` record holds the verdict, the reason, an optional correction, the executor, the model, and the version. So step 17 changes a stored shape, and it owes a version bump and a reopen test written by the old version.

## Choice

The verifier may lower a finding's severity by one step, and never raise it. It may set a finding's cause to `pre-existing` when it shows that the whole failure existed at the base. Both move a finding toward requiring less, never more. An important pre-existing finding still surfaces.

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

Location still classifies every finding first, as [cause by location](2026-10-03-cause-by-location.md) set it. The verifier's answer may then outrank location, toward `pre-existing` only. It never promotes a finding to `affected` or `introduced`.

The verifier sets `pre-existing` when it shows that the whole failure path existed at the base. It names evidence locations at the base for three things:

1. the trigger that reaches the code;
2. the absence of the guard;
3. the failing code.

Melian checks mechanically what it can. Each named base location must exist at the base and hold the lines the verifier quotes. Melian reads them back and stores them. A proposal with a missing location, or one whose lines differ, is refused, and the finding keeps its cause.

Four cases stay `introduced` or `affected`, whatever the base holds:

- **A new caller.** The head adds a caller or an entry point that first reaches base code.
- **A removed guard.** The head removes the guard that stopped the failure.
- **A changed trigger.** The head changes a configuration value or a default that first triggers the failure.
- **A copy.** The head puts a copy of base code in a new place. A new instance of a defect is introduced, and the old instance does not excuse it.

The verifier's reason must say why none of the four applies. A reason that leaves one out is refused. A deterministic co-report keeps its own cause, and the merge keeps the strongest cause any member gave. So a re-scoped lens claim never demotes a defect that a static check or a guardrail reports as `introduced`.

Example of a re-scope that holds: a change moves a function to another file unedited, and no caller changes. Every line is an added line, so location reads `introduced`. The verifier names the old function at the base, its unchanged caller, and the missing guard there. The move is not a copy, since the old place is gone. The cause becomes `pre-existing`.

Example of one refused: a helper sat behind validation at the base, and the head adds a caller that skips the validation. The helper's failing lines are at the base, but the trigger is new. The finding keeps its cause.

### Important pre-existing findings still surface

Problem: a pre-existing finding is capped at advisory and noticed once, in a capped section. That is right for an old nit. It is wrong for an old P0, and it would make a re-scope a quiet way to bury a finding.

Solution: two kinds of pre-existing finding are important.

- any finding the verifier re-scoped, at any severity;
- any pre-existing finding at P0 or P1, however it got its cause.

An important pre-existing finding is never silent and never dropped from the review. It is listed under its own heading, "Pre-existing, important", in the terminal, the ledger, and the JSON. A re-scoped one shows the verifier's reason and the original scope. It is raised once per finding, as a pre-existing finding is today. It does not block by default.

Its cap becomes configuration. A `resolution.preExisting` key, which [resolution per lens and per rule](2026-10-12-resolution-per-lens-and-per-rule.md) defines, sets the ceiling for pre-existing findings by severity. The default is `advisory`. A team can require an acknowledgement for a pre-existing P0 or P1 in a folder.

The threshold is this decision's reading of the maintainer's words, "if important": P0 and P1, plus anything the verifier re-scoped. The maintainer may adjust it.

### Conflicting reports

The grain is the claim. Each lens sighting is one claim, and a lowering or a re-scope belongs to the stored record for its claim.

- The strongest verdict still wins: `confirmed` over `plausible` over `refuted`, as [conflicting verifier reports](2026-10-06-verifier-conflicting-reports.md) set it. A weaker report leaves the record unchanged.
- On equal verdicts for one claim, the record keeps the higher severity and the stronger scope: `introduced` over `affected` over `pre-existing`. A later equal report never weakens a stored one. So two `confirmed` reports that disagree on a lowering leave the finding unlowered, in either order.
- The merged defect takes the highest severity among its claims after lowering. A claim no verifier judged keeps its own severity.

The guard runs in the report's commit, replay included.

## What this leaves alone

A correction stays text shown beside the finding, which changes nothing. The lowering is a separate typed field. So this refines [the verification pass](2026-10-04-verification-pass.md) and [the verifier as built](2026-10-05-verifier-as-built.md), and replaces neither. It leaves [resolution ownership](2026-10-03-resolution-ownership.md) alone: the verifier stores a severity and a scope, and only adjudication writes a resolution.

It refines cause by location and [the out-of-diff decision](2026-10-03-out-of-diff.md). Location still proves `introduced` for every finding no verifier re-scopes. A pre-existing finding still never blocks. What changes is that a verifier with base evidence may say an added line holds an old defect.

Lowering is not scoring. Milestone 4 plans a decision model that scores severity and confidence as calibrated probabilities. A lowering has no number, and `confidence` stays reserved for the decision model. Each lowering, stored beside the lens's severity and joined to what the author did next, becomes calibration data for that scoring.

## What this gives up

A second model can move a P1 out of the blocking set without refuting it, by one step down or by a re-scope. The verifier reads the head, which the author writes, so an author can argue for either. Melian checks that the base locations exist and hold the quoted lines. It cannot check that they add up to the whole failure path. That rests on the verifier and on the four rules. The fence bounds a lowering to one step. The heading keeps every re-scoped finding in front of the author with its reason. The failure to design against is unchanged: a real P1 lost on a model's word.

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
- a function moved unedited, with its caller unchanged, becomes `pre-existing`;
- a proposal whose base location does not hold the quoted lines is refused;
- a deterministic co-report keeps its cause beside a re-scoped lens claim.

Surfacing:

- a re-scoped P2 is listed under "Pre-existing, important" with the reason and the original scope;
- a pre-existing P0 that the table maps to `silent` is still listed, and does not block.

Conflicting reports:

- duplicate calls for one claim in both orders, one lowering and one not;
- two scope answers that conflict;
- a replay after each report.

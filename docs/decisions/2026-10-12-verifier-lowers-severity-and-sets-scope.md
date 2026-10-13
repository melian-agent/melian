# The verifier may lower a severity one step and set a pre-existing scope

Status: planned for milestone 2, step 17, "The verifier lowers severity and sets scope". Nothing here is built.

Supersedes: [2026-10-03-cause-by-location.md](2026-10-03-cause-by-location.md)

The supersession is in part. The decision log retires a superseded file whole, so [the section below](#what-survives-of-cause-by-location) restates every clause of it that still holds.

Problem: the verifier can keep a finding or drop it, and nothing in between. A lens sets the severity, and a verifier that confirms the mechanism also confirms that severity, however narrow the failure turns out to be. The verifier also answers whether the failure was there before the change, and nothing reads that answer.

Example: a lens reports a P2 on a parse call that fails for one malformed input. The verifier reads the callers and confirms it. It also finds that the only caller validates that input first, so the failure needs a second defect to appear. The finding is real, so it is not refuted. It stays P2 and the author must acknowledge it.

Two tools show the same gap from outside. In [the CodeRabbit sample](../research/2026-10-12-coderabbit-categories.md), authors dismissed 15% of major findings and 4% of minor ones. The severity the reviewer was surest of was the one most often rejected. And the `code-review` plugin for Claude Code keeps a list of false positives that excludes pre-existing issues, as [the note on its review angles](../research/2026-10-12-claude-code-review-angles.md) records.

## What exists today

`report_verdict` already takes three answers, `code`, `guard`, and `base`, beside the verdict. It validates them and stores none. It reads a refutation's evidence locations back and returns them to the verifier, and stores none of those either. The `verification` record holds the verdict, the reason, an optional correction, the executor, the model, and the version. So step 17 changes a stored shape, and it owes a version bump and a reopen test written by the old version.

## Choice

The verifier may lower a finding's severity by one step, and never raise it. It may propose that a finding is `pre-existing`, and the proposal holds only when Melian itself confirms it. A model's prose never moves a finding out of the blocking set by itself. An important pre-existing finding still surfaces.

### Lowering

- A lowering is one step: P1 to P2, or P2 to P3. No other lowering exists.
- A P0 is never lowered. Nothing is lowered to `nit`. Nothing is lowered to a severity that the table in force at the finding's path resolves `silent`.
- A `melian/injection-attempt` finding is never lowered.
- A deterministic finding is never lowered, and neither is a defect a static, guardrail, or mutation check co-reported.
- A lowering rides only on a `confirmed` or `plausible` verdict.
- A lowering needs evidence locations, as a refutation does. Melian reads them back and, from step 17, stores them. Without them the lowering is refused and the lens's severity stands.
- Only the LLM verifier lowers. The decision-model executor may not.
- A lowering is always shown with the original severity and the verifier's reason: in the terminal, the ledger, and the JSON. An author reads "P3, lowered from P2" and why.
- The lens's severity stays stored. Adjudication resolves the finding at the lowered one.

### Scope

Location classifies every finding first. The verifier may then propose `pre-existing`, and never a stronger cause. Melian accepts the proposal only when it confirms all four of these itself. Anything Melian cannot check refuses the re-scope, and the finding keeps the scope location gave it.

**(a) No evidence on a changed line.** The finding has no `cause` location and no other evidence location on a changed line. One exception: a line in a file that git reports as renamed with identical content. Git reports no edit there, so the line is not the change's.

**(b) The failing lines are the same lines.** The verifier quotes the failing lines at the base. Melian compares them with the head's failing lines, byte for byte, and finds the base file through git's rename map. So a renamed file is found by its base path. An edited copy fails, a copy at a new path fails, and a one-character edit fails.

**(c) The trigger is untouched.** The verifier must name the trigger, and each location on the path from the trigger to the failure. A re-scope with no named trigger is refused. Every named location must lie outside every hunk of the diff, at the base and at the head.

**(d) Four typed answers, cross-checked.** The verifier answers four fields, not prose: `newCaller`, `removedGuard`, `changedTrigger`, and `copy`. Each must be `false`, with a base location that supports it. Melian cross-checks what it can against the diff, and any hit refuses the re-scope:

- a hunk adds a call to the failing symbol;
- a hunk deletes lines inside the guard that encloses the failing code, or inside the function that holds it;
- a hunk changes a configuration key or a default that the named trigger reads;
- the head holds an instance of the failing code whose twin still exists at the base. That is a copy.

Melian finds the enclosing function with the compiler, as the change prompt does. Where it cannot, in a file the compiler does not read, the re-scope is refused.

What the rule still cannot see:

- A flag flipped in a file the verifier never names. Rule (c) catches it only when the verifier names the flag's reader as the trigger and the flag as part of the path.
- A base location in dead code. The lines exist at the base and nothing reached them. Rule (c) catches the change that makes them reachable only when the verifier names that route.

Both fail toward not re-scoping only when the trigger is named. That is why the verifier must name one.

What the route reaches. Melian cuts hunks to changed lines alone, so location already reads `pre-existing` for most findings that pass (a). Two kinds remain. One is a finding whose own range overlaps a changed line while none of its evidence does. The other is an `affected` finding whose proof sits in a file renamed with identical content. The rule is narrow by construction: each exclusion that could be argued in prose is now a check.

Example of a re-scope that holds: a lens reports a finding over a whole function, lines 10 to 40, because the change edited a comment on line 20. Its evidence and failing lines are lines 30 to 32, identical at the base. Its caller is unchanged and outside every hunk. The cause becomes `pre-existing`.

Example of one refused: a helper sat behind validation at the base, and the head adds a caller that skips the validation. An older caller at the base skips it too, and the verifier names that one as the trigger. A hunk adds a call to the failing symbol, so the cross-check under (d) refuses.

A deterministic co-report keeps its own cause, and the merge keeps the strongest cause any member gave. So a re-scoped lens claim never demotes a defect that a static check or a guardrail reports as `introduced`.

### Important pre-existing findings still surface

Problem: a pre-existing finding is capped at advisory and noticed once, in a capped section. That is right for an old nit. It is wrong for an old P0, and it would make a re-scope a quiet way to bury a finding.

Solution: a heading of its own, "Pre-existing, important".

- **Membership.** A pre-existing finding whose original severity is P0 or P1. Or a finding the verifier re-scoped whose original severity is P2 or higher. The original severity is the lens's, before any lowering. A re-scoped P3 or nit is an ordinary pre-existing finding.
- **Where.** Under that heading in the terminal, in the JSON, and in the ledger on the pull request. A re-scoped member shows the verifier's reason and the original scope.
- **How often.** Once per finding ID per pull request. The ledger tracks it, as it tracks pre-existing findings today. On later revisions it is shown as carried, not new.
- **The verdict.** A member never changes the verdict or the exit code, unless a folder's `preExisting` cap asks for an acknowledgement.
- **The floor.** A member never resolves below `advisory`. This overrides a `silent` mapping and a `silent` ceiling for members, on purpose. The caps apply first, then the floor.

Lens budgets bound how many findings a lens reports, so the heading needs no bound of its own.

The `preExisting` cap is a key that [resolution per lens and per rule](2026-10-12-resolution-per-lens-and-per-rule.md) defines. The membership threshold is this decision's reading of the maintainer's words, "if important". The maintainer may adjust it.

### Conflicting reports

The grain is the claim. Each lens sighting is one claim, and a lowering or a re-scope belongs to the stored record for its claim.

- The strongest verdict still wins: `confirmed` over `plausible` over `refuted`, as [conflicting verifier reports](2026-10-06-verifier-conflicting-reports.md) set it. A weaker report leaves the record unchanged.
- On equal verdicts for one claim, the record keeps the higher severity and the stronger scope: `introduced` over `affected` over `pre-existing`. A later equal report never weakens a stored one. So two `confirmed` reports that disagree on a lowering leave the finding unlowered, in either order.
- When an equal report replaces a stored one, the record keeps the winning report's reason and evidence.
- The merged defect takes the highest severity among its claims after lowering. A claim no verifier judged keeps its own severity.

The guard runs in the report's commit, replay included.

## What survives of cause by location

The superseded decision chose: location proves `introduced` only; `affected` needs lens evidence; `pre-existing` otherwise. Its reason: a location heuristic must never make an old defect block. All of it survives, as the first classification:

- Location proves `introduced` only. A finding on a changed line, or in an added file, is `introduced`.
- `affected` needs lens evidence: a `cause` location in changed code, which Melian checks against the hunks.
- Everything else is `pre-existing`.
- A location heuristic must never make an old defect block.

What changes is one step after that classification. The verifier may propose `pre-existing` for a finding location classified otherwise, and Melian accepts it only under rules (a) to (d). The verifier never proposes a stronger cause.

## What this leaves alone

A correction stays text shown beside the finding, which changes nothing. The lowering is a separate typed field. So this refines [the verification pass](2026-10-04-verification-pass.md) and [the verifier as built](2026-10-05-verifier-as-built.md), and replaces neither. It leaves [resolution ownership](2026-10-03-resolution-ownership.md) alone: the verifier stores a severity and a scope, and only adjudication writes a resolution.

Lowering is not scoring. Milestone 4 plans a decision model that scores severity and confidence as calibrated probabilities. A lowering has no number, and `confidence` stays reserved for the decision model. Each lowering, stored beside the lens's severity and joined to what the author did next, becomes calibration data for that scoring.

## What this gives up

A second model can still move a P1 out of the blocking set by one step down. The verifier reads the head, which the author writes, so an author can argue for that. The fence bounds it to one step, never to silence, and the original severity is always shown. A re-scope no longer rests on the verifier's word: Melian's own checks decide it, and they refuse whatever they cannot check. The price is reach. A real old defect in a file the compiler does not read, or on a line the change reformatted, keeps its `introduced` cause and may block.

## Goldens

They live in the verifier corpus, `packages/evals/verifier/`.

Lowering:

- a narrow trigger that earns one step;
- a P0 that keeps its severity;
- a lowering refused for want of evidence;
- a P2 that is not lowered where the folder's table resolves P3 `silent`;
- a deterministic co-report that keeps its severity;
- a hostile claim that argues its own severity down, and is not lowered.

Scope, each refused unless marked:

- a new caller beside an older unvalidated one;
- a removed guard;
- a flag flipped in another file, with the trigger named;
- an edited copy of a buggy function;
- a moved function with a one-character edit;
- a base location in dead code that the head makes reachable;
- a proposal with no named trigger;
- a renamed file with identical content, which may re-scope;
- a true pre-existing case, which re-scopes and is capped;
- a deterministic co-report, which keeps its cause beside a re-scoped lens claim.

Surfacing:

- a re-scoped P2 is listed under "Pre-existing, important" with the reason and the original scope;
- a re-scoped P3 is an ordinary pre-existing finding;
- a pre-existing P1 that the verifier lowered to P2 is still a member;
- a pre-existing P0 that the table maps to `silent` is listed at `advisory`, and the verdict and exit code do not change;
- a member is new on the first revision and carried on the second.

Conflicting reports:

- duplicate calls for one claim in both orders, one lowering and one not;
- two scope answers that conflict;
- a replay after each report.

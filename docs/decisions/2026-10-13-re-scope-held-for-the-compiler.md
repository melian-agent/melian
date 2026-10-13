# Step 17 ships lowering, and re-scoping waits for the compiler

Supersedes: [2026-10-12-verifier-lowers-severity-and-sets-scope.md](2026-10-12-verifier-lowers-severity-and-sets-scope.md)

The supersession is in part. The decision log retires a superseded file whole, so [the sections below](#what-survives-lowering) restate every clause of it that still holds.

Problem: the superseded decision let the verifier propose that a finding is `pre-existing`, and had Melian accept the proposal only when its own checks confirmed it. Those checks must know who calls the failing code, what guards it, and what triggers it. Step 17, "The verifier lowers severity, and important pre-existing findings surface", first built them by matching names in the text of the diff and the head. Each review then found another way through.

Example: [pull request #116](https://github.com/melian-agent/melian/pull/116) had Codex's adversarial review and four of Melian's own rounds. Every one found a re-scope that should have been refused and was accepted:

- Codex: a guard deleted in a caller, and a new caller under an alias the base already held.
- Round 1: a function declared `export default` under a name, and a file with one NUL byte, which git reads as binary and a search skips.
- Round 2: `parseRecord`, which spells the name through an escape, and an alias past the 300 characters a search shows of a line.
- Round 3: a comment between `export` and `default`, and a base line the verifier chose freely.
- Round 4: an alias on the same line as the function's own declaration.

Each fix was one more special case, and a name built at run time, as `module["parse" + "Record"]` is, has no fix in text at all. This is what [ask the authority](2026-10-12-ask-the-authority.md) forbids: the compiler knows what a name resolves to, and Melian was working it out by hand.

Choice: step 17 ships lowering and surfacing. The verifier may not propose `pre-existing`. Re-scoping waits for a later step, "The verifier re-scopes through the compiler's call graph", which asks the compiler who calls the failing code. Until then location alone decides scope, as [cause by location](2026-10-03-cause-by-location.md) set it.

What this gives up: a finding whose own range overlaps a changed line, while its failing lines and their callers are untouched, keeps its `introduced` cause and may block. So does an `affected` finding whose proof sits in a file renamed with identical content. The author answers either with a dismissal. The verifier's `base` answer, whether the failure was there before the change, is stored with each verdict and changes nothing. It is calibration data for the step that builds the route.

## What survives: lowering

The verifier may lower a finding's severity by one step, and never raise it. A model's prose never moves a finding out of the blocking set by more than that step.

- A lowering is one step: P1 to P2, or P2 to P3. No other lowering exists.
- A P0 is never lowered. Nothing is lowered to `nit`. Nothing is lowered to a severity that the table in force at the finding's path resolves `silent`.
- A `melian/injection-attempt` finding is never lowered.
- A deterministic finding is never lowered, and neither is a defect a static, guardrail, or mutation check co-reported.
- A lowering rides only on a `confirmed` or `plausible` verdict.
- A lowering needs evidence locations, as a refutation does. Melian reads them back and stores them. Without them the lowering is refused and the lens's severity stands.
- Only the LLM verifier lowers. The decision-model executor may not.
- A lowering is always shown with the original severity and the verifier's reason: in the terminal, the ledger, and the JSON. An author reads "P3, lowered from P2" and why.
- The lens's severity stays stored. Adjudication resolves the finding at the lowered one.

As built: the fence against silence is held twice. `report_verdict` refuses the lowering under the table the review fixed when it built the candidate. Adjudication reads the table again, and resolves a lowered finding at the lens's severity when the table then in force silences the lowered one. A policy file edited between the two cannot lower a finding into silence. A lowering carries its own reason, beside the verdict's, because the reason a claim is true is not the reason it is narrow. A refused lowering still records the verdict, and `report_verdict` says why in its result.

## What survives: the stored record

The verification record holds the verdict, the reason, an optional correction, the executor, the model, and the version, as before. It now also holds the `code`, `guard`, and `base` answers, the evidence locations Melian read back, and, for an accepted lowering, the lens's severity, the lowered one, and the reason. The findings document and the verdict document each rose to version 7, with a reopen test over what version 6 wrote. The record holds no scope.

## What survives: important pre-existing findings still surface

Problem: a pre-existing finding is capped at advisory and noticed once. That is right for an old nit and wrong for an old P0.

Solution: a heading of its own, "Pre-existing, important".

- **Membership.** A pre-existing finding whose original severity is P0 or P1. The original severity is the lens's, before any lowering. With re-scoping held, the superseded decision's second kind of member, a finding the verifier re-scoped, does not exist.
- **Where.** Under that heading in the terminal, in the JSON, and in the ledger on the pull request. The JSON keeps a member in its resolution group and lists it again under `preExistingImportant`.
- **How often.** Once per finding ID per pull request. On later revisions it is shown as carried, not new. As built, a member is carried when another revision of the changeset first sighted it, by its own ID or a merged member's, and never for a dismissed report it only lists beside it.
- **The verdict.** A member counts toward the verdict and the exit code exactly as it did before the heading existed: as any advisory finding does, and not at all when the floor alone keeps it above `silent`. It never blocks. The sentence in the superseded decision, "never changes the verdict or the exit code", meant that the heading adds nothing to what an advisory finding already does. It did not mean an important finding counts for less than an ordinary one.
- **The floor.** A member never resolves below `advisory`. This overrides a `silent` mapping and a `silent` ceiling for members, on purpose. The caps apply first, then the floor.

Lens budgets bound how many findings a lens reports, so the heading needs no bound of its own. The `preExisting` cap is a key that [resolution per lens and per rule](2026-10-12-resolution-per-lens-and-per-rule.md) defines, and step 18 builds it. Until then the cap is fixed at advisory. The membership threshold is a reading of the maintainer's words, "if important", and the maintainer may adjust it.

## What survives: conflicting reports

The grain is the claim. Each lens sighting is one claim, and a lowering belongs to the stored record for its claim.

- The strongest verdict still wins: `confirmed` over `plausible` over `refuted`, as [conflicting verifier reports](2026-10-06-verifier-conflicting-reports.md) set it. A weaker report leaves the record unchanged.
- On equal verdicts for one claim, the record keeps the higher severity. A later equal report never weakens a stored one. So two `confirmed` reports that disagree on a lowering leave the finding unlowered, in either order.
- When an equal report replaces a stored one, the record keeps the winning report's reason and evidence.
- The merged defect takes the highest severity among its claims after lowering. A claim no verifier judged keeps its own severity.

The verifier has one chance per claim, by design, so that a second call can never be used to lower: a report whose lowering the fence refused is stored unlowered, and a later equal report does not correct it. So that the one chance is a fair one, the label line Melian writes for each claim, outside the boundary, names the severity the lens reported.

The guard runs in the report's commit, replay included. As built, `report_verdict` reads the record the rule kept, and says so when a lowering was not kept. Verification picks its candidates from the findings as the lenses reported them: a stored lowering can change which finding speaks for a merged defect, and a repeat review would otherwise read as new input and clear the stored judgements.

## What survives of cause by location

The superseded decision had itself superseded [cause by location](2026-10-03-cause-by-location.md) in part and restated it. With re-scoping held, all of cause by location stands again, and nothing comes after it:

- Location proves `introduced` only. A finding on a changed line, or in an added file, is `introduced`.
- `affected` needs lens evidence: a `cause` location in changed code, which Melian checks against the hunks.
- Everything else is `pre-existing`.
- A location heuristic must never make an old defect block.

## What this leaves alone

A correction stays text shown beside the finding, which changes nothing. The lowering is a separate typed field. So this refines [the verification pass](2026-10-04-verification-pass.md) and [the verifier as built](2026-10-05-verifier-as-built.md), and replaces neither. It leaves [resolution ownership](2026-10-03-resolution-ownership.md) alone: the verifier stores a severity, and only adjudication writes a resolution.

Lowering is not scoring. Milestone 4 plans a decision model that scores severity and confidence as calibrated probabilities. A lowering has no number, and `confidence` stays reserved for the decision model. Each lowering, stored beside the lens's severity and joined to what the author did next, becomes calibration data for that scoring.

A second model can still move a P1 out of the blocking set by one step down. The verifier reads the head, which the author writes, so an author can argue for that. The fence bounds it to one step, never to silence, and the original severity is always shown.

## Goldens

Eleven of the superseded decision's twenty-four survive, in the verifier corpus, `packages/evals/verifier/`. The ten for scope and the three that need a re-scope go with the route.

Lowering:

- a narrow trigger that earns one step;
- a P0 that keeps its severity;
- a lowering refused for want of evidence;
- a P2 that is not lowered where the folder's table resolves P3 `silent`;
- a deterministic co-report that keeps its severity;
- a hostile claim that argues its own severity down, and is not lowered.

Surfacing:

- a pre-existing P1 that the verifier lowered to P2 is still a member;
- a pre-existing P0 that the table maps to `silent` is listed at `advisory`, and the verdict and exit code do not change;
- a member is new on the first revision and carried on the second.

Conflicting reports:

- duplicate calls for one claim in both orders, one lowering and one not;
- a replay after each report.

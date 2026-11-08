# Restore the verifier clauses that partial supersessions retired

Amends: [2026-10-06-verifier-refusal-retires-judgements.md](2026-10-06-verifier-refusal-retires-judgements.md), [2026-10-06-verifier-eval-unjudged-results.md](2026-10-06-verifier-eval-unjudged-results.md), [2026-10-06-verifier-explicit-routes.md](2026-10-06-verifier-explicit-routes.md), [2026-10-06-verifier-reading-budget.md](2026-10-06-verifier-reading-budget.md) and [2026-10-06-verifier-undecided-tasks.md](2026-10-06-verifier-undecided-tasks.md), restoring clauses that partial `Supersedes:` lines retired.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

Where a clause below conflicts with any other active decision, including the decisions this file amends, that decision wins. These clauses fill gaps the partial supersessions left; they override nothing.

Five decisions superseded [the verifier as built](2026-10-05-verifier-as-built.md) while each changed one of its rules: [conflicting verifier reports](2026-10-06-verifier-conflicting-reports.md), [unfinished evals](2026-10-06-verifier-eval-unjudged-results.md), [explicit routes](2026-10-06-verifier-explicit-routes.md), [the reading budget](2026-10-06-verifier-reading-budget.md) and [undecided tasks](2026-10-06-verifier-undecided-tasks.md). [The task-scope decision](2026-10-06-verifier-task-scope.md) superseded conflicting verifier reports for the strength rule's lifetime alone. [The replacement decision](2026-10-06-verifier-replaces-adjudication.md) superseded the task-scope decision for its replacement transaction alone, and [the refusal decision](2026-10-06-verifier-refusal-retires-judgements.md) superseded the replacement decision to extend it to refusal. The index retired each target whole. The clauses below still hold on main. This file restates them and changes nothing.

## From [2026-10-05-verifier-as-built.md](2026-10-05-verifier-as-built.md)

- An instance of core's `Merge` holds findings and `ConfigFor`. Adjudication delegates grouping to it; the pipeline uses the same grouping before verification.
- Live defects with a verifying lens claim or an escalation-kept quick claim are candidates. Every lens claim on a candidate is judged. A stored run without `verify` uses its lens definition at that level.
- A defect is removed only when every lens claim is refuted, no deterministic check co-reported it, and no protected claim keeps a visible minimum under [the trust-floor decision](2026-10-17-trust-floor-exact-rule.md).
- Unjudged lens-only defects are capped at advisory, and a silent one stays silent.
- A refutation requires evidence locations that Melian reads back.
- An optional adjudication input flag, `verificationRan`, gates the cap. Old inputs omit it; dismissal keeps the stored flag and verifies nothing.
- Any unfinished, refused, superseded or failed candidate leaves a failed verifier check; budget exhaustion records ended. Adjudication stores not reviewed and capped findings before `verifierFailed` is thrown.
- An unrouted verifier falls back to heavy, medium, then light lens routes, another family first. Library calls without a plan use `config.models.verifier` or their finder route.
- `LensDocument` has an optional verifier role, labelled sighting keys and the current model. That role offers `report_verdict` and refuses `report_finding`.
- Stateless fake replies match the verifier marker and answer every label, confirmed by default. A reserved verifier script key maps finding IDs to outcomes.
- `packages/evals/verifier` holds each case's base, head, candidate, expected verdicts, script and source README.
- `VerificationState` retains one original claim per sighting. A merged speaker carries the strongest judgement, but its original claim stays in `otherClaims` when it imports another sighting's proof or judgement.
- A revision and input attach to one verification task through an optional `ReviewIndex` entry. Spawn creates all owned conversations in one commit. Failover commits the attempt and model together.
- Replacing the task clears the revision's judgements and removes its adjudication owner in the same commit that repoints the index. The sweep aborts that adjudication before waiting for verification. Its commit refuses an unnamed owner.
- Every report commit checks ownership and budget, even on replay. The strongest-verdict rule applies within one task.
- The findings document holds optional verdict maps by revision, producer and verifier version beside sightings. Reads project the latest version onto each claim, and the strongest onto the merged finding. Clearing or replacing a sighting clears its verdicts.
- A planned model optionally stores its family, derived from the catalogue name after removing the vendor prefix and parenthesised qualifier. Another family comes first, preserving order within each group. Provider unlocking includes verification. Doctor prints families and warns when verification falls back to lens tiers. The model flag still routes only lens tiers.
- Refuted defects with no visible protected minimum stay in an optional refuted group, outside publication and blocking counts. A protected refutation stays visible and counted, as [the trust-floor decision](2026-10-17-trust-floor-exact-rule.md) sets. Terminal output reveals them with `--all`; JSON retains every claim. Comments show escaped judgements and corrections. `Verdict.verificationSummary` supplies the counts the terminal verdict and the published review body show.
- Scripted evals plant candidates through `report_finding` and use the durable verifier task. Live verifier runs require their own opt-in selector and accept a separate judge route.
- A fake finder may join an existing opaque model collection through the testing entry. The root policy excludes the seeded corpus from lenses.

## From [2026-10-06-verifier-task-scope.md](2026-10-06-verifier-task-scope.md)

- A replacement task must judge every claim again. Within that task, confirmed outranks plausible, which outranks refuted, including crash replay.

## From [2026-10-06-verifier-conflicting-reports.md](2026-10-06-verifier-conflicting-reports.md)

- `report_verdict` uses Pi Durable's sequential execution mode.
- A weaker replacement leaves the record and findings version unchanged. The guard runs in the report's commit, including replay.

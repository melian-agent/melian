# Verifier as built

Choice: Step 6 takes all thirteen defaults in its brief, as follows.

| Default | Choice | Why |
| --- | --- | --- |
| 1 | An instance of core's Merge holds findings and ConfigFor. Adjudication delegates grouping to it; the pipeline uses the same grouping before verification. | A verifier must judge exactly the defect adjudication counts, including after a dismissal splits it. |
| 2 | Live defects with a verifying lens claim or an escalation-kept quick claim are candidates. Judge every lens claim on a candidate. | A quick claim an escalated run leaves unanswered must still reach judgement. |
| 3 | Remove a defect only when every lens claim is refuted and no deterministic check co-reported it. | One refutation cannot erase another claim or deterministic proof. |
| 4 | Cap unjudged lens-only defects at advisory, retaining silent. | A static or guardrail report carries its own proof and keeps its existing resolution. |
| 5 | A refutation requires evidence locations that Melian reads back. | A judge's unsupported assertion must not drop a real defect. |
| 6 | An optional adjudication input flag, verificationRan, gates the cap. Old inputs omit it; dismissal keeps the stored flag and verifies nothing. | Applying the new cap to an old dismissal would silently unblock the review. |
| 7 | Any unfinished, refused, superseded or failed candidate leaves a failed verifier check; budget exhaustion records ended. Adjudication stores not reviewed and capped findings before verifierFailed is thrown. | The advisory cap limits an unjudged blocker, while not reviewed prevents it passing. |
| 8 | An unrouted verifier falls back to heavy, medium, then light lens routes, another family first. A refused or uncredentialed explicit route fails with its plan reason and lineage, and never falls back. Doctor warns. Library calls without a plan use config.models.verifier or their finder route. | One provider can still review; a policy refusal must not spend tokens on a result it cannot count. |
| 9 | LensDocument has an optional verifier role, labelled sighting keys and the current model. That role offers report_verdict and refuses report_finding. | Read-tool and report errors use findings boundaries and visible text, since diagnostics can contain author-controlled paths. Reusing read tools retains budgets and replay rules. |
| 10 | Fix each candidate at 100,000 tokens and 20 tool calls, with at most eight conversations running together. | These limits bound this step without adding configuration. |
| 11 | The verifier version is a 16-hex hash of instructions, report schema and question set. | A changed judge cannot attach to the previous task's input. |
| 12 | Stateless fake replies match the verifier marker and answer every label, confirmed by default. A reserved verifier script key maps finding IDs to outcomes. | Parallel conversations must not consume one another's replies. |
| 13 | packages/evals/verifier holds each case's base, head, candidate, expected verdicts, script and source README. Four execution-dependent misses accept confirmed or plausible; two decoys require refuted. | This measures whether verification drops real defects independently of finder recall. Lens scoring stays unchanged. |

Choice: VerificationState retains one original claim per sighting. A merged speaker carries the strongest judgement, but its original claim stays in otherClaims when it imports another sighting's proof or judgement. A correction never changes severity, location, cause or ID. The typed questions cover code, guard, base and verdict. Confidence remains reserved for calibrated decision models.

Why: The verifier must never judge one sighting through another's evidence or verdict. Optional fields also preserve older findings and verdict fingerprints.

Choice: A revision and input attach to one verification task through an optional ReviewIndex entry. Spawn creates all owned conversations in one commit. Failover commits the attempt and model together. Only rerun replaces an unfinished attachment. Replacing the task clears the revision’s judgements and removes its adjudication owner in the same commit that repoints the index. The sweep aborts that adjudication before waiting for verification. Its commit refuses an unnamed owner. Every report commit checks ownership and budget, even on replay. The strongest-verdict rule applies within one task.

Why: Replays must neither spend on replaced runs nor overwrite newer findings. beforeTool does not run when Pi replays a tool's execute phase.

Choice: Findings document version 6 adds optional verdict maps by revision, producer and verifier version beside sightings. Reads project the latest version onto each claim, and the strongest onto the merged finding. Clearing or replacing a sighting clears its verdicts. Version 5 reads unchanged; version 4 retains its existing evidence migration. Verdict and review-index documents need no new version.

Why: A verdict belongs to its sighting, not its speaker. Optional shapes avoid changing records or fingerprints that held no verification.

Choice: A planned model optionally stores its family, derived from the catalogue name after removing the vendor prefix and parenthesised qualifier. Another family comes first, preserving order within each group. Provider unlocking includes verification. Doctor prints families and warns on fallback or same-family verification. The model flag still routes only lens tiers.

Why: Family lookup is deterministic and survives stored plans. A maintainer can see weaker verification before spending on a review.

Choice: Refuted defects stay in an optional refuted group, outside publication and blocking counts. Terminal output reveals them with all; JSON retains every claim. Comments show escaped judgements and corrections. Verdict.verificationSummary supplies counts for the future ledger.

Why: Authors can inspect a dropped claim without receiving an inline objection that verification rejected. Host integration stays within the pending ledger's edges.

Choice: Scripted evals plant candidates through report_finding and use the durable verifier task. Live verifier runs require their own opt-in selector and accept a separate judge route. A fake finder may join an existing opaque model collection through the testing entry. The root policy excludes the seeded corpus from lenses.

Why: Integration tests spend no real tokens. An opt-in run can isolate judge quality without asking a finder to rediscover each candidate.

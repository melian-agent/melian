# Verifier as built

Choice: Step 6 takes the brief's default 1: an instance of core's Merge holds findings and ConfigFor. Adjudication delegates its grouping to that instance. VerificationState keeps the speaker and each lens sighting's claim; static and guardrail members carry no claim. A TypeBox verification record holds verdict, reason, optional correction, executor, model, and version. The three code questions and the verdict choice form one typed question set. Confidence stays reserved for calibrated decision models.

Why: Verification must judge exactly the defect adjudication groups. Shared grouping prevents drift after a dismissal splits one. Each claim must travel with its own proof. Optional fields preserve older findings and verdict fingerprints.

Choice: Default 8 falls back from an unrouted verifier to heavy, medium, then light lens routes. A refused verifier tier never falls back. Each planned model optionally stores its family, derived from its catalogue name. Cross-family routes preserve order inside each family. Providers include verification; doctor prints families and warns on fallback or same-family verification.

Why: A contributor holding one provider can still review. A route policy refusal must not spend tokens on a result it cannot count. Family lookup is deterministic and survives a stored plan.


Choice: Defaults 2, 9, 10, 11 and 12 select live defects with a verifying lens claim or an escalation-kept quick claim. Every lens claim on a candidate is judged. LensDocument has an optional verifier role, labelled sighting keys and the current model. The verifier uses the existing read tools and budget meter, with 100,000 tokens and 20 calls per candidate, at most eight conversations at once. Its version hashes instructions, report schema and question set. Scripted responses match a verifier marker and derive their replies from messages alone.

Why: A quick claim an escalated run leaves unanswered must still reach judgement. Reusing read tools retains the existing boundaries and replay rules. Fixed budgets bound this step without adding configuration. Stateless scripts answer parallel conversations correctly.

Choice: A revision and input attach to one verification task through an optional ReviewIndex entry. Spawn creates all owned conversations in one commit. Attempts and model changes commit together. Only rerun replaces an unanswered attachment. Every report commit checks task ownership. Findings document version 6 keeps optional verdict maps by revision, producer and verifier version beside each finding's sightings. Reads project the latest recorded version onto each claim and the strongest onto the merged finding. Clearing sightings clears their verdicts.

Why: Replays must neither spend on replaced runs nor overwrite newer findings. A verdict belongs to its sighting, not its merged speaker. Version 5 migrates unchanged; version 4 also receives the existing evidence migration.


Choice: Defaults 3, 4, 6 and 7 remove a defect only when every lens claim was refuted and no deterministic check co-reported it. An unjudged lens-only defect resolves no higher than advisory. The optional adjudication input flag verificationRan applies this cap only to new reviews. A dismissal keeps the stored flag and runs no verifier. Any unfinished candidate leaves a failed or budget-ended verifier check and a not-reviewed verdict.

Why: A refutation cannot erase another claim or deterministic proof. Capping an old review during dismissal would silently unblock it. The advisory cap limits unjudged findings; the not-reviewed status still prevents an incomplete review passing.

Choice: Default 13 puts execution-dependent misses under packages/evals/verifier, outside the lens corpus. Each has base and head trees, a planted candidate, acceptable verdicts, a script and a source README. Four real defects accept confirmed or plausible, never refuted. Two decoys require refuted. A fake finder plants each through report_finding; the verifier uses the durable task. Live runs select this suite separately and may route another verifier model.

Why: The suite measures whether verification drops a real defect, independently of whether a finder notices it. Scripted tests exercise the integration without claiming to measure a model. Lens scoring stays unchanged.

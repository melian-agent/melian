# The citation habit does not answer to an instruction, so the merge by shared cause must be structural

Choice: an instruction to cite the lines that break was tried, measured, and removed. Opus finders went on citing their own ranges, so a merge cannot wait on the model's citation habit; it has to be structural. A merge of two checks' reports that one hunk caused is held for step 27, "Merge by shared cause", and must meet the requirements below. Until then the merge rule is unchanged: different checks, one file, the same normalised snippet at the same occurrence, overlapping lines, and no fuzzy matching.

## The problem

The merge depends on which lines a model chose to cite. The snippet is the head's text at the finding's lines, so two lenses that cite different ranges for one defect have different snippets and stay apart. On seven design goldens, Opus finders left one fail-open default in `src/publish.ts` as two to four findings: the design lens's `fail-open-default` at lines 6-7, the trust-boundary lens's `fail-open` at lines 5-7, and the removed-behaviour lens's `dropped-guard` at lines 3-8. Sol finders cited line 6 alone in every lens, so the same reports merged and precision was 1.00. [The cross-cells record](../../packages/evals/runs/2026-10-16-finder-verifier-cross-cells.md) holds the runs.

## What was tried: the instruction sentence

Sol's runs showed the snippet rule already merges the case when every lens cites the line that breaks, so the cheapest fix was to ask every lens to do what Sol did. One sentence in Melian's fixed lens instructions said: "Put `line` and `endLine` on the line or lines that break, and cite any wider span as evidence." It touched no stored shape and no merge site.

It did not move Opus. On the design goldens with a Terra verifier, Opus scored precision 0.52 and 0.47 and recall 0.94 and 0.89 over two passes, against 0.52 and 0.51 precision before. The five writer-trust goldens, where three lenses report the one `canPublish` default, still drew two to five reports each, where one or two are expected. Sol held at 0.89 precision and 0.94 recall, as before. [The run record](../../packages/evals/runs/2026-10-16-citation-sentence.md) has the cells. The sentence came out in the same pull request, [pull request #130](https://github.com/melian-agent/melian/pull/130), and never reached `main`.

So the citation habit is the model's, not the prompt's, and the merge has to work from what Melian computes, the diff, rather than from where a model chose to point.

## Held: a merge of reports one hunk caused

A first ruling merged two checks' reports in one file over overlapping lines when the change caused both through the same hunk. [An attacking review](https://github.com/melian-agent/melian/pull/130) broke it, and any merge rule for step 27 must meet what it found:

- **The reports share a hunk, tested on a real zero-context diff.** A hunk is its new lines, or, for a pure deletion, the base lines it removed. Whether a report's `cause` evidence counts beside its own lines is for step 27's design to settle: it reaches a deletion and an unchanged caller whose cause is the changed callee, but it widens with the citation habit this decision cannot fix. Melian diffs with `--unified=0 --inter-hunk-context=0`, so the unchanged blank line 4 of the golden splits the change into two hunks. `Revision.trigger` and `Revision.changeOverlap` name the first hunk a range overlaps, so `dropped-guard` fell on hunk 0 and the other two on hunk 1. The test fixture had invented one hunk. Tests build their hunks through `Changeset.resolve` on a temporary repository, never by hand.
- **The merge inputs store hunk ranges, with a version bump.** No merge site has a `Revision`: not the merge before verification, not adjudication, and not the dismiss path, which re-runs adjudication from its stored input. A finding's trigger and proof cannot stand in for the hunks. The inputs carry each file's hunk ranges, with an `upgrade` and a reopen test, and an input stored without them falls back to the snippet rule and says so.
- **Publication keeps a merged member's thread open.** `Verdict.publication` holds only speaker IDs. A report posted alone on one push and merged under another speaker on the next would be answered as resolved and its thread closed while the defect stands. Hunk boundaries move with unrelated edits, so this would happen often.
- **Grouping is order-independent and does not depend on a lowered severity.** The merge seeds groups by severity. Example: P1 A at lines 1-5, P2 B at 4-7, P2 C at 6-8 group as `{A,B}` and `{C}` before verification; a verifier that lowers A to P2 regroups them as `{C,B}` and `{A}` at adjudication, so the published defect is not the one verified. Grouping reads the severity the lens reported, never a lowered one.
- **Only two lens reports merge this way.** A static, guardrail, or mutation report on the hunk would make the defect not lens-only, which refuses every lowering and keeps a refuted lens speaker above a standing deterministic report, and a dismissal of that speaker would take the deterministic report with it. Deterministic reports merge only by snippet.

The attack's smaller points stand for step 27 too. `melian dismiss` lists the merged reports only after it records the dismissal, so the list is a notice, not a protection. Merges must not chain: reports at lines 1-5, 5-7 and 7-8 stay at least two defects. And a finding in another file, such as the caller at `src/cli.ts:8`, stays its own finding, because it needs its own fix where its comment sits.

## Step 27, as built

This section sets out the rule and how it meets each requirement above. A second attacking review, on [pull request #131](https://github.com/melian-agent/melian/pull/131), found seven gaps in the first proposal; the coordinator's ruling on them is folded in below. The tests are in `packages/core/test/merge-by-hunk.test.ts`, `packages/core/test/publication.test.ts`, `packages/pipeline/test/dismiss.test.ts` and `packages/cli/test/cli.test.ts`.

### The rule, in two passes

**The snippet pass** groups reports by the snippet rule, as before: no check that reported both, one file, the same normalised snippet at the same occurrence, and overlapping lines. Problem: the rule once compared only the check that won each ID. When lens.design and lens.tests both sighted A, and lens.tests also reported B, design won A and the two merged, though lens.tests had said they were two defects.

**The hunk pass** then joins whole snippet groups. It takes part only for a group whose every report is a lens report: the finding's check and every check in its `reportedBy` start with `lens.`. A snippet group that holds a static, guardrail, or mutation report never joins another group. Two groups join when every report of one meets every report of the other under the hunk rule.

Problem: one pass let the two rules compete. Example: on `src/publish.ts`, lens report A at line 6 and `static.mutation` report S at line 6 share a snippet, and lens report B at lines 5-7 meets A through hunk 1. One pass put A with whichever of B and S came first. With A beside B, the defect was lens-only, so the verifier could lower A and nothing blocked where A had blocked. Solution: the snippet pass holds A and S together first. The group is not lens-only, so B stays apart.

Two reports meet under the hunk rule when all of these hold:

- no check reported both, counting the check that won each finding's ID and every check in its `reportedBy`, and they are in one file, with the same lifecycle status;
- no `ruleAliases` entry marks their rules `distinct`;
- their lines overlap at head;
- the change caused both, as their causes set out below.

The causes decide it this way:

- If either is `pre-existing`, they do not meet: a `pre-existing` finding falls on no hunk.
- If both are `introduced`, the lines they share must overlap one hunk's new lines. Their own lines decide it. Their `cause` citations do not count, so a type line both cite elsewhere in the file widens nothing. Two line ranges that overlap each other and one hunk share a line on it, so the code tests this as overlapping lines and a shared hunk.
- Otherwise, their hunk sets must meet. An `introduced` finding's set is every hunk whose new lines its own lines overlap. An `affected` finding's set is every hunk its `cause` locations fall on, through `Revision.changeOverlaps`: a head cause on a hunk's new lines, a base cause on its old lines. Only a location on the change names a hunk, so the `proves` mark adds nothing here, and a claim stored before Melian marked it reads alike. The locations are those of every claim the finding holds, its own and those in `otherClaims`, so which sighting of one ID won the severity does not change the set.

On the golden `design-supersedes-its-own-decision`, Melian's diff of `src/publish.ts` has two hunks: line 3, and lines 5-6 at the base becoming 5-7 at head. The three lens reports at lines 6-7, 5-7 and 3-8 share lines 6-7, 5-7 and 6-7, all inside hunk 1, so they are one defect, and the P0 speaks. The `dropped-guard` report spans both hunks, so its own lines decide it, whatever it cites. The correctness lens's report of the caller at `src/cli.ts:8` is in another file and stays its own finding.

### Callers and deletions, the sixth requirement

Codex's adversarial review of [pull request #130](https://github.com/melian-agent/melian/pull/130) found that a rule on new lines alone misses two cases.

- **An unchanged caller.** Two lenses report the caller of a changed callee, on overlapping lines. Both are `affected`, and the only thing tying them to the change is their proof. Their hunk sets are the hunks their proving causes fall on, so they merge when one hunk proves both, and stay apart when different hunks do.
- **A deletion-only hunk.** It has no new lines, but its old lines are the deleted code. A report that cites the deleted guard as a base `cause` is `affected`, and the deletion hunk is in its set. Two such reports on overlapping lines of the caller merge. A report beside the deletion that cites nothing at the base is `pre-existing`, as `Revision.classifyCause` already says, and merges only by snippet.

A file the change only renamed proves through the rename, which names no hunk, so its reports merge only by snippet. This is accepted: a rename with no edit has one defect class, the broken import, and its reports cite the same line.

The `affected` route reads `cause` citations, so it widens with what a lens chooses to cite, as the attack's sixth finding says. It is kept because an `affected` finding has nothing else tying it to the change, and its lines must still overlap the other report's.

### Where each merge site gets its hunks

The authority is `Revision`. Two methods are added:

- `revision.changeOverlaps(location, findingFile)` returns every part of the change a location falls on. `changeOverlap` returns the first of them, so cause classification and proof do not change.
- `revision.outline(findings)` returns the changed files the findings name, by their own path or an evidence location's, with each hunk's `header` and `text` emptied, as `report_finding` already builds it.

`Merge` and `Adjudication` take an optional `revision`. Without one, the hunk pass does not run.

- **Before verification.** `reviewChangeset` passes the changeset's `Revision`, which it holds in memory, to `new Merge(...)`. The verification tasks store the merge's output, the candidates, not its input, so no stored shape changes there.
- **Adjudication.** `AdjudicationTaskInput` gains `files`: the outline of the files the review's findings name, by location or by evidence location, each hunk as its index and its old and new ranges. Only those files, because the review index stores the whole input as a string for every revision, and a change of 2,000 files would add a megabyte per push. A dismissal adds no finding, so the outline still covers every finding. The task rebuilds the `Revision` with `Revision.from({ base, head, files })`. `AdjudicationTask` goes from version 1 to version 2. Its `migrate` from version 1 passes the input through without `files`, and the task reads an absent `files` as none, so a task stored before the step decides by snippet, as it did. The attach key is the input's JSON, so the first review after the upgrade starts a new task rather than attach to an old one.
- **Dismiss.** `recordDismissal` copies the stored input into a new version 2 task, with no `migrate`. A version 2 input keeps its `files`. A version 1 input keeps none and decides by snippet, the way the verdict being replaced was decided, so a dismissal never regroups a verdict.

Two tests cover the stored shape. The reopen test stores a pending adjudication task on SQLite through a version 1 definition, which stores what version 1 stored: the task's name, its version, its first checkpoint, and an input without `files`. It closes the storage. It then reopens the storage under version 2 and checks that the task migrates, runs, and records the snippet grouping. The second test dismisses a finding of a revision indexed with a version 1 input, after the upgrade, and expects the snippet grouping. The fallback says nothing in the verdict. It only reproduces the grouping the stored verdict already had, so a note would explain no change.

The first review of each revision after the upgrade groups again, so its verification candidates are new and the verifier runs again. `VerificationRecord.after` then keeps the stronger of the old and new verdicts for each claim.

### Publication

`Verdict.held()` lists the IDs of every finding the verdict holds live, with the live members of each, as `Defect.of` reads them. `Defect.of` also leaves out reports that a verdict recorded before Melian marked them lists unmarked. `Verdict.publication` and the publish task's plan of a round both use it. The plan uses it to decide whether to carry a resolution reply still owed from an earlier head.

So a report posted alone and merged on a later push keeps its entry in `open`, and its thread stays open. It is not posted again and not counted as still open. If a later push splits the defect again, the report finds its own entry and is still open, not new. A resolution reply owed for it from an earlier head is not posted while it is a member. A report merged into a dismissed finding is still resolved with that dismissal, as today. This gap existed before the step, for any merge that changed between pushes, so the test uses a snippet merge.

### Grouping order

The snippet pass takes reports by the severity the lens reported, `original()`, then by ID. It once took them by strength, which reads a lowered severity. Problem: one lens with two rules on one snippet, A at P1 and C at P2, beside B from another lens at P2. Before verification the groups were `{A, B}` and `{C}`. A verifier lowered A to P2, and at adjudication they became `{C, B}` and `{A}`, so the published defect was not the one verified. The speaker within a group is chosen the same way, as the next section sets out.

The hunk pass takes snippet groups in order of end line, then start line, then the lowest ID among a group's reports. The reports of a snippet group share their lines, so the group's lines are any member's. Each group joins the first hunk group, in the order the groups opened, whose every report it meets; otherwise it opens a new one.

- Neither pass orders by a lowered severity, so a verifier's lowering never regroups, and the grouping before verification is the grouping at adjudication.
- Each member of a hunk group contains the end line of the group's first member. For reports whose shared lines fall in one hunk, this is greedy interval stabbing, which makes the fewest groups. Example: reports w at line 5, x at 5-6, y at 6-7 and z at 7, where only w-x, x-y and y-z meet, make two groups, `{w, x}` and `{y, z}`. In ID order they made three.
- A report added on a later push moves only groups that open after its start. Example: a1 at line 5, a2 at 5-6 and a3 at 6-7 group as `{a1, a2}` and `{a3}`. A push that adds a0 at line 6 leaves `{a1, a2}` whole and gives `{a0, a3}`. In ID order, a1 split off and was posted fresh.
- No connected components are computed. The pass splits each component the same way every time, and a component whose every pair meets comes out whole.
- The start-line key has no test that fails without it. A brute-force search over every set of three or four reports on hunk 1, from up to three lenses, found none that end line and ID alone group differently. It is kept because the ruling names it and it costs one comparison.

### Verdicts never decide grouping or the speaker

Grouping and the speaker's identity read only what the lenses reported, never a verdict. That covers both passes of `Merge`, `#keeper`, the severity they order by, `original()`, and the verification candidate's key. A refuted claim is handled after grouping, at resolution and display.

Problem: four findings across three reviews each let a verdict feed back into grouping or the speaker:
- the attack's F4 and the record's F2, a lowering that regrouped;
- the round's d19112ac, a refuted speaker replaced by a standing one;
- the round's 9acf210b, a refuted sighting dropped from the severity the merge orders by.

Each made a repeat review regroup, so the candidate keys changed, the stored judgements were cleared, and the verifier was paid to judge the same claims again. A failed request then left a finished review not reviewed. Example: A at P1 and B at P2 share a snippet, and A speaks. The verifier refutes A and confirms B. If the keeper skipped refuted reports, the repeat review's candidate was B, its key no longer matched, and verification ran again.

Solution: one rule that makes the class impossible.

- The speaker is chosen as it was before verification. `ruleAliases` names an owner first, and otherwise the most severe as reported (`compareReported`, the lens's severity, then ID).
- A sighting merge orders by the highest severity any lens reported. `original()` counts every sighting, refuted ones included.
- `readFindings` as reported, the read verification groups from, picks no winner by verdict. Read judged, for adjudication, a refuted sighting never wins its ID while another stands. The finding then takes the standing sighting's severity and prose, and keeps the same ID and the same grouping key.
- A merged defect keeps its speaker's ID, and so its candidate key. What it resolves at is the highest standing severity. When the speaker was refuted, the message and explanation it shows come from the report that stands, the most severe as reported. `Defect.decision` resolves each report and leaves out refuted ones, so a refuted P1 beside a confirmed P2 never blocks as a P1.
- A defect whose claims are all refuted keeps the refuted handling it had.

The cost: `originalSeverity` counts a refuted sighting's severity. A finding that a refuted P1 and a confirmed P2 sighted reads as P2 with an original of P1. Membership of "Pre-existing, important" reads that original. A pre-existing finding is capped at `advisory` already, so this changes no resolution under the default table.

### Dismissing a member

The ID of a member, not the speaker, now dismisses that report alone. This applies to every merge, by snippet too. Problem: with the hunk pass, a report posted alone keeps its thread when a later push merges it under a P0. A maintainer who answers that thread with `melian dismiss` would have dismissed the P0, which they had not read.

The speaker's ID dismisses the speaker and the reports the snippet pass merged with it, which share its code. A report that joined only through the hunk pass stays live, and forms its own defect when the verdict is decided again. Problem: on one hunk, correctness reported `null-dereference` P1 at line 8 and contracts `changed-return` P1 at lines 7-8. The hunk pass merged them and `changed-return` spoke. A maintainer who dismissed it as a false positive also dismissed the null dereference, whose text they had not read, and the verdict passed. `recordDismissal` tells a snippet member from a hunk member by the site of its sighting at the revision, the key the snippet pass groups by, so the stored verdict needs no new field.

Dismissing less never hides a defect. `melian dismiss` prints every report of the defect it left live under "Still live, merged with it before:", by rule, check and ID: the speaker, for a member's ID or with `--only`, and each hunk member. Dismissing the golden's three fail-open reports takes one dismissal for each lens.

A member that a dismissal of the speaker took stays dismissed if a later push splits it away. Lifecycle is per ID, and a dismissal holds until the finding's trigger changes. The dismissal named it by rule, check and ID when it was recorded.

### Limits

- **Distinct defects on one hunk.** Two introduced lens reports on overlapping lines of one hunk merge, whatever their text. An added file is one hunk, and so is a rewritten function. Example: `sql-injection` at lines 40-60 and `untested-behaviour` at 55-58 of a new file become one defect. Resolution holds, because each report resolves on its own, and the speaker stands. `ruleAliases` with `distinct: true` keeps two rules apart.
- **A merged member's own lines.** `alsoReportedAs` holds no lines, so the stored verdict loses a hunk member's lines. `Comparison.compare` matches an external finding at the speaker's site and its head `cause` locations, so comparison recall can move for reasons that have nothing to do with review quality. This is accepted. Adding the lines would bump the verdict document for a comparison concern.
- **One verification budget per candidate.** A candidate has 300,000 tokens and 60 tool calls, whatever its claim count. Larger groups share one budget, so a candidate ends more often, and an `ended` verifier leaves the review not reviewed. The budget is not scaled. The goldens' merged groups hold three claims, and the verifier judges a merged defect once, through its speaker. A scaled budget would pay for the duplicates the merge exists to remove. If live runs show candidates ending, scale it then.
- **A thread orphaned before a merge.** A report whose resolution reply an earlier head owes, and which a later head merges under another, keeps its thread open and gets no reply. `packages/github/test/publish-merged-member.test.ts` holds that. When it later returns alone, it is posted afresh, and the old thread is never answered. That gap predates the step, and an issue tracks it.

No earlier decision file records the merge rule; [docs/guidelines/core.md](../guidelines/core.md#dedupe-across-sources) and [design.md](../design.md#the-pipeline) set it out, and both point here.

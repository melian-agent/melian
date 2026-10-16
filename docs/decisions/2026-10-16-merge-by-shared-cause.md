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

## Step 27's design, proposed

This section proposes the rule and how each requirement above is met. The failing tests are in `packages/core/test/merge-by-hunk.test.ts` and `packages/core/test/publication.test.ts`. The section is not built, and it waits for an attacking review.

### The rule

Two findings meet when all of these hold:

- both are lens reports: the finding's check and every check in its `reportedBy` start with `lens.`;
- different checks report them, in one file, with the same lifecycle status, and no `ruleAliases` entry marks their rules `distinct`;
- their lines overlap at head;
- the snippet rule holds, as today, or the hunk rule does.

The hunk rule depends on each finding's cause:

- If either is `pre-existing`, it does not apply: a `pre-existing` finding falls on no hunk.
- If both are `introduced`, the lines they share must overlap one hunk's new lines. Their own lines decide it. Their `cause` citations do not count, so a type line both cite elsewhere in the file widens nothing.
- Otherwise, their hunk sets must meet. An `introduced` finding's set is every hunk whose new lines its own lines overlap. An `affected` finding's set is every hunk its proving `cause` locations fall on: a head cause on a hunk's new lines, a base cause on its old lines.

Deterministic reports keep the snippet rule alone, for any pair.

On the golden `design-supersedes-its-own-decision`, Melian's diff of `src/publish.ts` has two hunks: line 3, and lines 5-6 at the base becoming 5-7 at head. The three lens reports at lines 6-7, 5-7 and 3-8 share lines 6-7, 5-7 and 6-7, all inside hunk 1, so they are one defect, and the P0 speaks. The `dropped-guard` report spans both hunks, so its own lines decide it, whatever it cites. The correctness lens's report of the caller at `src/cli.ts:8` is in another file and stays its own finding.

### Callers and deletions, the sixth requirement

Codex's adversarial review of [pull request #130](https://github.com/melian-agent/melian/pull/130) found that a rule on new lines alone misses two cases.

- **An unchanged caller.** Two lenses report the caller of a changed callee, on overlapping lines. Both are `affected`, and the only thing tying them to the change is their proof. Their hunk sets are the hunks their proving causes fall on, so they merge when one hunk proves both, and stay apart when different hunks do.
- **A deletion-only hunk.** It has no new lines, but its old lines are the deleted code. A report that cites the deleted guard as a base `cause` is `affected`, and the deletion hunk is in its set. Two such reports on overlapping lines of the caller merge. A report beside the deletion that cites nothing at the base is `pre-existing`, as `Revision.classifyCause` already says, and merges only by snippet.

A file the change only renamed proves through the rename, which names no hunk, so its reports merge only by snippet. This is accepted: a rename with no edit has one defect class, the broken import, and its reports cite the same line.

The `affected` route reads `cause` citations, so it widens with what a lens chooses to cite, as the attack's sixth finding says. It is kept because an `affected` finding has nothing else tying it to the change, and its lines must still overlap the other report's.

### Where each merge site gets its hunks

The authority is `Revision`. One method is added: `revision.changeOverlaps(location, findingFile)` returns every part of the change a location falls on. `changeOverlap` stays as the first of them, so cause classification and proof do not change. `revision.outline()` returns the revision's fields with each hunk's `header` and `text` emptied, as `report_finding` already builds it. `Merge` and `Adjudication` take an optional `revision`. Without one, the hunk rule does not apply and the snippet rule decides.

- **Before verification.** `reviewChangeset` holds the changeset's `Revision` in memory and passes it to `new Merge(...)`. The verification tasks store the merge's output, the candidates, not its input, so no stored shape changes there.
- **Adjudication.** `AdjudicationTaskInput` gains `files`: the outline's changed files, each hunk as its index and old and new ranges. The task rebuilds the `Revision` with `Revision.from({ base, head, files })`. `AdjudicationTask` goes from version 1 to version 2. Its `migrate` from version 1 passes the input through without `files`, so a task stored before the step decides by snippet, as it did. The attach key is the input's JSON, so the first review after the upgrade starts a new task rather than attach to an old one.
- **Dismiss.** `recordDismissal` copies the stored input, so a version 2 input keeps its `files`. A version 1 input keeps none and decides by snippet, the way the verdict being replaced was decided, so a dismissal never regroups a verdict.

The reopen test opens storage that the version 1 definition wrote, holding a pending adjudication task. The fixture is written by today's code through a committed script, never by hand. The test checks that the version 2 definition migrates the task, runs it, and records the snippet grouping. The fallback says nothing in the verdict. It only reproduces the grouping the stored verdict already had, so a note would explain no change.

### Publication

`Verdict.publication` holds every finding in a group that needs attention, and every silent one. It now also holds the IDs in each such finding's `alsoReportedAs` that are not marked `dismissed`. A report posted alone and merged on a later push keeps its entry in `open` and its thread stays open. It is not posted again and not counted as still open. If a later push splits the defect again, the report finds its own entry and is still open, not new. A report merged into a dismissed finding is still resolved with that dismissal, as today. The test is in `publication.test.ts`. It uses a snippet merge, because this gap exists today, whenever a merge changes between pushes.

### Grouping

`Merge.defects` groups by lifecycle status first, as now. Within a status, it takes findings in ID order, never in strength order. Each finding joins the first group, in the order groups were opened, whose every member it meets. Otherwise it opens a new group.

- IDs do not depend on severity, input order, or a verifier's lowering, so the grouping before verification is the grouping at adjudication.
- The speaker is still chosen by strength within a group, so a lowering can change who speaks, but never who is in the group.
- The meets relation is symmetric. The greedy pass in ID order is a deterministic split of each connected component into groups whose members all meet. A component in which every pair meets comes out whole. One that does not splits the same way every time.
- No connected components are computed: they would add a pass and change no group.

The snippet rule now also needs every member to meet, rather than any. Reports that share a snippet at one occurrence sit on the same lines, so this changes no group the snippet rule makes today.

No earlier decision file records the merge rule; [docs/guidelines/core.md](../guidelines/core.md#dedupe-across-sources) and [design.md](../design.md#the-pipeline) set it out, and both point here.

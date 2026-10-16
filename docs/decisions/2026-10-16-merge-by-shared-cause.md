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

No earlier decision file records the merge rule; [docs/guidelines/core.md](../guidelines/core.md#dedupe-across-sources) and [design.md](../design.md#the-pipeline) set it out, and both point here.

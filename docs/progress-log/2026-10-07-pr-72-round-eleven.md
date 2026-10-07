# Pull request 72, round eleven

Melian's eleventh round, Sonnet 5.5 lenses with an Opus 5.5 verifier, found one wrong result and three advisories. All four were confirmed.

- `ComparisonSet.backlog()` took an owed golden's title only from the round holding the newest judgement. When that round had dropped the finding and an earlier round still held it, the title fell back to the finding ID. The title now comes from the judged round, else the newest round of the changeset that holds the finding. A test reproduces the case.
- `renderStats` printed the clone-wide pending and reasonless counts from the clone-wide set, but no test gave the clone a nonzero count outside a filter. A test now does, and switching either line to the filtered set fails it.
- Step 15 returns to `[~]` in the plan until [pull request #72](https://github.com/melian-agent/melian/pull/72) lands, so it no longer contradicts its open sub-items.
- Print-only `backlog --markdown` and stdout-first export now have a decision file, [comparison-prints-not-writes](../decisions/2026-10-07-comparison-prints-not-writes.md).

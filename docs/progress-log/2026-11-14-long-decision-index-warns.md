A long decision index no longer refuses a review, for [issue #411](https://github.com/melian-agent/melian/issues/411). Melian warns that the decision log is long and recommends compacting it, by the maintainer's ruling of 2026-11-14. Before this, an index past 64 KiB refused every review that ran the design lens, and this repository's index, at 49 KB and growing about 155 bytes a decision, would have reached that in about three and a half weeks.

The index is built whole at any size. `DecisionFiles.warning()` in `packages/decisions/src/decision-files.ts` gives the warning once the rendered index passes 64 KiB. It says the log is long, with the index's size and decision count, that long context costs tokens and can dilute a reviewer's attention, and how to compact it. `melian review` prints it on stderr and adds it to `--json` as `warnings`, beside the verdict. `melian doctor` gives a `decision index` line read at `HEAD`. It never fails, and is left out where there is nothing to read. The warning never changes the verdict or the exit code.

A short attacking review of the rule, before it was built, found six ways the first plan would break, and the build follows its fixes.
- It confirmed that a pull request's head cannot grow the index a model reads: a head adding 5,000 decision files left the base index at 47 bytes.
- The first plan loaded the index in the CLI on every review. Today only the design lens loads it, so a broken decision graph refuses nothing in a review without that lens, and the CLI's load would have added a refusal. `DecisionIndexWarning.read` now reads the index only when the verdict records the design lens as having run, failed or ended, and an index it cannot read gives no warning.
- Matching pi-ai's overflow patterns alone reads a rate limit as an overflow. `contextOverflowed` in the pipeline asks pi-ai's `isContextOverflow`, which excludes rate limits. When the design lens or the verifier failed on such a request, the warning adds that the index's size may explain it.
- The first advice was to supersede old decisions, as the issue said, but superseding lengthens the index, since inactive decisions stay listed. The coordinator answered on 2026-11-14 to recommend steps that shorten it, and to say superseding does not. A test holds that claim: the advised steps give a shorter index, and superseding alone a longer one. Whether the index should leave inactive decisions out is a product question, now [issue #413](https://github.com/melian-agent/melian/issues/413).

The 64 KiB rule sat in [the active-base decision](../decisions/2026-10-08-design-lens-active-decisions-at-base.md), which the index already shows as inactive. [The Markdown decision](../decisions/2026-10-08-decisions-package-markdown-on-mdast.md) supersedes it for its parser alone and says its byte-bound choices remain. So [the long-index decision](../decisions/2026-11-14-long-decision-index-warns.md) amends that statement. The decisions guideline gains the section the warning links to, on compacting a decision log.

No stored shape or key changes. The index's text is the same, so the design lens's instruction fingerprint and the verifier's version are too. The round workflow's comment does not carry the warning, since its public copy keeps only the fields it lists.

Each test of a changed behaviour failed first on `main` at `370411bd`:
- the decision index tests, because `warning()` and `decisionIndexWarning` did not exist and the index was refused;
- the CLI tests, because the class did not exist;
- the doctor tests, because the line did not exist.

This repository's headroom test, which failed the gate past 56 KiB, now checks that the warning fires exactly when the index passes 64 KiB.

The first gate failed twice. `models.ts` imported pi-ai directly, and only the harness wrapper may, so `856b8aa3` reaches `isContextOverflow` through `harness.ts`. Doctor pads every name to the longest, which in this checkout is now `decision index`, so `ff2a98fd` widens the doctor test's columns. That test also checks the line as `ok` or `warn`, so it still holds once this repository's index passes 64 KiB.

Codex's adversarial review of `6a897a53` found that the warning read the decision index a second time, after the review's timing was recorded. On this repository's 317 decisions that took about 3.5 seconds, growing with the log and showing nowhere. The design lens's own load is not kept, and a repeat review reuses its result without loading at all, so the CLI keeps its read. `09affda7` runs it in a `decision-index` step of the review's spans, before the output step, so its cost appears in the stage telemetry. The test that `--json` records that step failed on `6a897a53` and passes after.

The mutation inventory, `2026-11-14-issue-411-mutants.json`, lists 137 mutants of `origin/main...09affda7`, each run at that head:
- 89 killed, each by its named test run alone;
- 43 string literals Stryker ignores under the repository's configuration;
- 5 equivalent, each with its reason: four fields of the message `contextOverflowed` builds that `isContextOverflow` never reads, and the fallback for a verdict with no `ran`, which a fresh review never lacks.

The first run left five more survivors, in the filter that decides which failures the warning names and in doctor's plural. The tests in `0028a248` kill them. The runner misses one of those kills, `check.error && check.reason`, because its name pattern does not anchor a test name holding backticks. Run by hand at `09affda7` against its named test alone, it was killed, with exactly one test collected.

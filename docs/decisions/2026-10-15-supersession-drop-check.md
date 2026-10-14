# A deterministic check flags a superseding decision that drops a clause

Problem: the decision index retires a superseded decision whole, and the design lens reads only active decisions. So a new decision that supersedes an old one, to change one clause, silently retires every clause it does not restate. Reviewers catch it by reading both files side by side, one pull request at a time.

Example: the shape recurred on three pull requests in a row. On [pull request #111](https://github.com/melian-agent/melian/pull/111), a review of record found a decision that changed cause by location without a `Supersedes:` line (C3 in [its record](../../packages/evals/comparisons/2026-10-13-pr-111.md)), and the fix pass had to add one and restate the surviving clauses. On [pull request #116](https://github.com/melian-agent/melian/pull/116) the review of record found it again (C8 in [its record](../../packages/evals/comparisons/2026-10-14-pr-116.md)). On [pull request #117](https://github.com/melian-agent/melian/pull/117) the design lens found it in rounds one, two and four, and it stopped only when the new decision restated every surviving clause ([its record's patterns](../../packages/evals/comparisons/2026-10-14-pr-117.md#patterns)). A lens that finds it in some rounds and not others is sampling; the question has a mechanical answer.

Choice: a deterministic check, `static.supersession`, on every decision file the head adds or changes that has a `Supersedes:` line.

- The decisions package already parses both files: `DecisionFile.parse` reads the declaration, and `MarkdownDocument` gives each paragraph's decoded text. The check reads the retired file at the base and the new file at the head.
- It splits the retired file's prose into sentences with `Intl.Segmenter` at sentence granularity, and does not split by hand. Headings, code and the `Supersedes:` line itself are not clauses.
- A sentence counts as kept when its text, after Unicode normalisation, whitespace collapsing and case folding, appears in the new file. Quoting it under a heading such as "Retired" counts as keeping it, so an author retires a clause by naming it.
- Every sentence not kept is listed in one finding, rule `supersession/dropped-clause`, P2, located on the new file's `Supersedes:` line. Under the default table P2 is `acknowledge`, so the author restates, quotes, or dismisses with a reason.
- A declaration whose target is absent at the base is already refused by the index, and the check adds nothing to it.

Why a check and not only a lens rule: the design lens's rule against a conflicting decision without `Supersedes:` stays, and separate work on lens prompts proposes a design-lens rule for the shape. The lens judges whether the drop matters; the check guarantees that every drop is seen.

What this gives up: a clause rephrased in the new file is not recognised, so the author either quotes the old sentence or dismisses the finding. A decision retired whole, as the unconfined decision on [pull request #98](https://github.com/melian-agent/melian/pull/98) retires the sandbox decision, draws one finding listing every sentence, which the author dismisses with that reason. The check reads only the file a `Supersedes:` line names; a decision that changes another without declaring it stays the design lens's to find.

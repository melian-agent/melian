# Supersession compares parsed prose and reports uncarried sentences

Supersedes: [2026-10-15-supersession-drop-check.md](2026-10-15-supersession-drop-check.md)

Status: step 26, phase 1. Proposed for attack before implementation.

## Problem and surviving direction

`DecisionFiles.from` retires a target whole. The design lens uses only active base decisions. A replacement saying “only for X” therefore loses every other clause unless it restates them.

On [pull request #116](https://github.com/melian-agent/melian/pull/116), reviewers found omitted reasons for lowering, the pre-existing acknowledgement case, strongest-cause merging and named goldens. [Pull request #117](https://github.com/melian-agent/melian/pull/117) repeated the omission across sampled rounds. Every surviving obligation must appear in the replacement. A deterministic check makes textual omissions visible; the design lens judges their significance. Its existing rule against conflicting decisions without `Supersedes:` remains. This check cannot discover an undeclared replacement, as [pull request #111](https://github.com/melian-agent/melian/pull/111) required.

## Authority and clauses

Use `MarkdownDocument` in the decisions package. Its authority is `mdast-util-from-markdown` 2.1.0, with the existing YAML/TOML front matter extensions. Reuse its Supersedes grammar and `LocalDestination`; do not reconstruct Markdown with line splitting. `DecisionFile` currently exposes only title and targets: clause extraction needs a new instance method over that same tree.

A clause is one non-empty sentence segment from a mdast `paragraph`, including paragraphs inside lists. Render that paragraph with `mdast-util-to-string`, with `includeHtml: false` and `includeImageAlt: false`, then use `Intl.Segmenter("en-AU", { granularity: "sentence" })`. Segment before collapsing ECMAScript whitespace to one space and trimming. Preserve case, punctuation and decoded inline-code text. Retain the paragraph's parser-provided source range for evidence.

Exclude blockquote descendants, front matter, headings, definitions, HTML nodes and code blocks. Exclude an entire root paragraph containing a declaration recognised by the existing Supersedes grammar, including an absence sentinel. Declaration recognition must share the parser's implementation, not use a second recogniser.

A root heading whose rendered, trimmed text is exactly `Retired` opens an excluded section until the next root heading of equal or lesser depth. Apply these exclusions to both files. Other headings organise prose but supply no clauses. CommonMark is the grammar; no GFM table extension is added.

## Kept, retired and unknown

A target clause is mechanically “kept” when its normalised sentence equals a clause in the successor's included prose. Order and duplicate counts do not matter. Another file's restatement does not count. Links retain their labels, not destinations; changed destinations remain for design review.

This proves textual presence, never equivalence or continued force. A paraphrase, changed punctuation, an intentional replacement and a missing obligation all produce the same gap. Negation or contradictory surrounding prose can also defeat semantic preservation despite an exact match. The lens retains that work.

Quoting old text in a blockquote or under `Retired` does not count as keeping it. Retiring a decision whole has no wildcard exemption: it produces one advisory notice per target, just like partial retirement. The notice invites review of the stated retirement; it requires no dismissal under default policy. Deliberate retirement is a valid human answer, not a parser error.

## Scope, output and failure

Run through `melian review`'s existing `guardrails` dispatch in the pipeline, which can depend on decisions without making core import its adapter. Use check `guardrails`, rule `guardrail/supersession-drop`, severity P3. The default resolution is advisory; existing per-rule policy may raise it. No model decides whether to emit it, and no verifier is needed.

When any changed old or new path matches the existing decision discovery domain, validate the complete head graph. Resolve all declarations, including inactive decisions and multiple targets, with `DecisionFiles`. A target absent at head makes the graph invalid, even when it exists at base. A target existing nowhere is therefore diagnosed during its own review. Cycles, unreadable sources, symlinks, oversized files, unavailable segmentation and parser errors fail the check and leave the review `not reviewed`. They never become advisory successes. Retain the existing 256 KiB file bound; never truncate inputs.

After validation, compare each head edge whose declaring file or target changed. Use the target's base text, following Git's reported old path for a rename. Use head text only when neither base path exists. This covers targets added in the same change and prevents editing or renaming an old target to erase the baseline. Renames and deletions count through both paths. Unchanged historical edges create no recurring notices. Changes outside the decision tree do not invoke this check.

For any missing clauses, emit one notice on the successor's declaration, discriminated by target path. Give the target, total missing count and first missing paragraph location; count everything before bounding display text. A target with no included clauses gets one advisory “no comparable prose” notice instead of a clean comparison. Whole retirement never creates a sentence-by-sentence finding list.

## Hand application and goldens

At `ac4e8c07`, the [census and adjudications](../progress-log/2026-10-18-step26-phase1-supersession-rule.md#hand-census) cover all 86 literal declaration lines: 85 real declarations and one fenced template. The parser resolves 80 edges; nine declarations use absence sentinels. All 80 edges have textual gaps and would advise in a whole-tree audit; none has an absent target or cycle. This proposal's own replacement also advises because it rewords the direction. Normal reviews inspect only affected edges. The table distinguishes useful omission warnings from expected rewrite noise. This cost is why gaps start at P3.

Required goldens, one case each:

- Dropped clause: one notice with the missing paragraph and count.
- Every clause restated: clean, including reordering and duplicate sentences.
- Whitespace, emphasis and entities changed: clean after normalisation.
- Paraphrase or punctuation changed: advisory despite equivalent intent.
- Whole retirement: one advisory, with surviving obligations restated.
- Quotation or `Retired` section: excluded text cannot suppress a notice.
- Heading, list, fence, HTML, metadata and declaration: exact inclusion boundaries.
- Empty comparable target: advisory, never inferred preservation.
- Target nowhere, or removed at head: failed check.
- Same-change target: compare head; existing edited target: compare base.
- Inactive target, multiple targets and contextual links: existing graph semantics.
- Cyclic, unreadable, oversized or unparseable graph: failed check.
- Unavailable segmenter: failed check, with no handwritten fallback.
- Unchanged edge, changed target, rename and deletion: declared scope.
- Conflicting replacement without a declaration: design lens alone.

# Amend narrow decisions; make whole retirement visible

Supersedes: [2026-10-15-supersession-drop-check.md](2026-10-15-supersession-drop-check.md)

The maintainer chose this rule on 2026-10-18 after the attack on [pull request #150](https://github.com/melian-agent/melian/pull/150).

## Problem and choice

The decision index retires a superseded target whole. A replacement saying “only for X” loses every other clause unless it restates them. Reviewers found such omissions on [pull request #116](https://github.com/melian-agent/melian/pull/116) and [pull request #117](https://github.com/melian-agent/melian/pull/117).

`Amends: <target link>, <scope>` declares a narrow change. The target stays active, rendered as `[ACTIVE; amended by Y]`. The design lens reads both files; where they conflict, the amendment wins. The rendered index and lens instructions state that precedence. Nothing is retired.

`Supersedes:` means whole retirement. Restate every surviving clause in the replacement. Every new or changed edge draws one P3 `guardrail/supersession-drop` notice on the declaring file, even when every clause is restated. The notice says which target is retired and asks the author to restate what survives. Uncarried sentences are evidence, never the trigger. Exact text cannot distinguish a rewrite from a lost obligation.

The attack counted 36 partial Supersedes lines. They are a follow-up audit under plan step 26. Existing edges keep their whole-retirement meaning. This change edits no decision on main. Other repositories' layouts belong to [issue #151](https://github.com/melian-agent/melian/issues/151).

## Declaration authority

Use `MarkdownDocument` in the decisions package, backed by `mdast-util-from-markdown` 2.1.0 and its existing front matter extensions. `LocalDestination` resolves links. The parser decides what is a link; labels, code, HTML and images remain opaque for edges. Root paragraphs alone supply declarations. Both forms keep the existing absence sentinels and bare filenames.

Only the first sentence of a declaration's physical line supplies targets. Later links are context. The golden copied from verifier-on-codex-subscription proves that verification-pass remains active. Both edge kinds participate in missing-target and cycle validation.

## Evidence authority and limits

A clause is a non-empty sentence from a parsed paragraph, including a list paragraph. Collapse ECMAScript whitespace before `Intl.Segmenter("en-AU", { granularity: "sentence" })` segments it. Inline code stays whole during segmentation; preserve its decoded text in the result. Keep the parser's paragraph range for evidence. Links contribute labels, not destinations.

Exclude front matter, headings, definitions, HTML nodes, code blocks and blockquotes. Exclude only a recognised declaration's physical line, including an absence declaration, never its whole paragraph. A root heading exactly `Retired` excludes its section until the next root heading of equal or lesser depth. Apply exclusions to both files. Keep the original parsed paragraph when removing a declaration line; reparsing can turn an indented continuation into a code block. A cooked inline-code span crossing an excluded line refuses extraction because mdast no longer supplies its decoded line map.

The repository has no GFM table extension. Until it has one, a table contributes one clause per source row, including its header and delimiter. Read rows only within parser-provided paragraph ranges. This fallback can include a pipe-delimited prose paragraph; it is evidence, never a reason to trigger or suppress a notice.

A target sentence is carried when its normalised text equals a successor clause. Order and duplicates do not matter. Another successor's restatement does not count. Paraphrases and punctuation changes appear uncarried; negation and contradictory context can leave false matches. The design lens retains semantic judgement and the rule against undeclared conflicting replacements. These notices compare a successor with its direct target only. They cannot recover earlier losses in a chain.

## Scope, output and failure

The pipeline adds the check to `melian review`'s guardrails dispatch, avoiding a core dependency on decisions. Core's `defaultConfig.guardrails` registers `supersession-drop`, with `enabled: true`. Its only setting is the enabled switch. The notice has fixed P3 severity; ordinary per-rule resolution can raise or silence its default advisory requirement.

When an old or new changed path belongs to docs/decisions and any touched decision has the guardrail enabled, validate the complete head graph through `DecisionFiles`. Missing targets, cycles, unreadable files, symlinks, files beyond 256 KiB, parser errors and unavailable segmentation fail the check. An absent target fails even when it existed at base. No model or verifier runs.

Compare each head Supersedes edge with its declaring file's base declaration, following Git's old path for a rename. An added target or changed declaration draws one notice per direct target. Unchanged declarations do not recur when only their body or target changes. Amendment edges draw no retirement notice.

Use the direct target's base text, following Git's old path for a rename. Use head text only when it did not exist at base. Count all uncarried clauses before bounding display text. The explanation names the target, the full missing count and the first missing paragraph location. No comparable prose is stated explicitly. Evidence never creates sentence-by-sentence findings or suppresses a whole-retirement notice.

## Goldens

The deterministic suite covers a dropped clause, every clause restated, a target that exists nowhere, an amendment leaving its target active, and the late contextual link. It also covers evidence boundaries, whitespace, inline code, table rows, unchanged declarations, changed declarations, renames, base authority and invalid graphs. No live measurement is needed for this deterministic notice.

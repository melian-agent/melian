# Claude Code's review angles

Which angles Claude Code's review skill runs, at which effort, and how the model picks the template.

Source: the prompt templates in the [Claude Code](https://github.com/anthropics/claude-code) 2.1.252 binary, the newest version installed when this was read. The templates are plain text in the bundled source. The plugin reviewers come from the `code-review`, `pr-review-toolkit`, and `feature-dev` plugins in the same repository. The templates are described here and not quoted.

This note corrects four statements in [the comparison of review tools](2026-10-04-review-tools-compared.md): the cleanup angles, angle E, the caps, and the model-family templates. [The last section](#what-this-corrects) lists each.

## The ten angles

Five angles hunt bugs. The templates letter them A to E.

| Angle | Name | What it does |
|---|---|---|
| A | Line-by-line diff scan | Reads every hunk, then the function around it. An unchanged line in a touched function is in scope. |
| B | Removed-behaviour auditor | For each deleted or replaced line, names the invariant it held and finds where the new code restores it. |
| C | Cross-file tracer | Finds the callers of each changed function and checks each call site, then the callees. |
| D | Language-pitfall specialist | Looks for the classic traps of the diff's language: a falsy zero, loose equality, a mutable default, a write to a nil map, daylight saving, float equality. |
| E | Wrapper and proxy correctness | For a type that wraps another, checks that every method reaches the wrapped instance and that the wrapper forwards each method its callers use. |

Five more angles are separate finders, each under its own heading.

| Angle | What it does |
|---|---|
| Reuse | New code that repeats something the codebase has. The finder searches shared and nearby modules and names the helper. |
| Simplification | Redundant or derivable state, copies with small variations, deep nesting, dead code. It names the simpler form. |
| Efficiency | Repeated computation or I/O, independent work run in sequence, blocking work on a hot path, and long-lived closures that hold a whole scope. |
| Altitude | Whether the fix sits at the right depth. A special case added to shared infrastructure signals a shallow fix. |
| Conventions | A breach of a `CLAUDE.md` file, flagged only when the finder can quote the exact rule and the exact line. With no such file it returns nothing. |

The templates call reuse, simplification, and efficiency the three cleanup angles. Altitude and conventions are counted apart. Correctness outranks all five when the output cap forces a cut, and a cleanup finding must state its concrete cost.

## Angles by effort

These are the default templates, used by any model the model table does not name.

| Effort | Angles | Pipeline | Cap |
|---|---|---|---|
| Low | None | One pass over the hunks, with no subagents and no full-file reads. Test and fixture hunks are skipped. | 4 |
| Medium | 8: A, B, C, and the five above | Find, deduplicate, verify with one vote. Tuned for precision. | 8 |
| High | The same 8 | The same, tuned for recall. The verifier defaults to plausible. | 10 |
| Extra-high | 10: the 8 plus D and E | Find, deduplicate, verify, then a gap sweep. | 15 |
| Max | The same 10 | The same as extra-high. Only the lead-in differs. | 15 |

The cloud level above max has no prompt in the binary. Only its dispatch is there, with a fall back to a local max review.

## The pipeline

1. Gather the diff: the branch against its upstream, falling back to the default branch or the previous commit, plus uncommitted changes. A pull request number, branch, or path replaces the scope.
2. Find. One finder per angle runs as a subagent. Each returns up to six candidates at medium and high, and up to eight at the top two levels. A candidate has a file, a line, a summary, and a failure scenario. Finders are told to pass on every candidate whose failure they can name, because silent drops cause most misses. At the top two levels one angle's conclusions must not suppress another's.
3. Deduplicate: the same defect at the same place for the same reason is one candidate. The most concrete failure scenario is kept.
4. Verify. One verifier per candidate gets the diff, the relevant files, and the candidate. It answers confirmed, plausible, or refuted. Confirmed needs the trigger named and the line quoted. Plausible means the mechanism is real and the trigger uncertain. Refuted needs the proving line. Confirmed and plausible candidates are kept.
5. Sweep, at the top two levels only. One more finder reads the verified list and looks for defects not on it, up to eight. It looks at moved code that lost a guard, second-tier traps, asymmetric test setup and teardown, and flipped configuration defaults. The templates do not say the sweep's candidates are verified.
6. Report, most severe first, cut at the cap. Each finding has a file, line, summary, a short summary of at most 60 characters, a failure scenario, a category, and a verdict when a verify pass ran.

The plausible default belongs to high effort alone. There a candidate may not be refuted for being speculative when the state it needs is realistic. A refutation must be constructible: the claim is wrong, impossible, already handled in the diff, or pure style. The top two levels use the plain rubric and add that one vote short of refuted carries the finding.

Without the subagent tool the same angles run in one context, in sequence. No verify pass runs, each candidate gets a self-check, and the caps become 8, 10, 15, and 15. The summary must say the review was single-pass.

A flag changes the cap. Other flags post the findings as inline comments or apply the fixes.

## How the model picks the template

The skill picks a template by model and effort. A table names three models; every other model uses the defaults above.

| Model | Low | Medium | High | Extra-high | Max |
|---|---|---|---|---|---|
| Any other | Default | Default | Default | Default | Default |
| Sonnet 5 | Its own low template | Default | Default, with a finder-count hint | The same | The same |
| Opus 4.8 | Its own: hunks only, cap 8 | 8 angles inline, no verify, cap 8 | 8 angles inline, no verify, cap 10 | 10 angles inline, a sweep, no verify, cap 15 | Default |
| Opus 5 | Default | A minimal single pass | The same minimal pass | Opus 4.8's extra-high template | Default |

- Sonnet 5's low template asks for at least as many findings as files changed, up to four. It takes a second pass over the largest file. Its hint at higher levels sizes the finder count to the diff, between two and eight.
- The Opus 4.8 templates run every angle in one context and spawn nothing. They deduplicate and verify nothing. They set a floor of half the cap and tell the model not to invent findings to reach it.
- The Opus 5 minimal template names no angles. It asks for one careful pass over the diff with the surrounding context, and allows fifteen findings.

The prompt that ran as Melian's shadow reviewer on 2026-10-03 had eight inline angles, deduplication, and no verify. That is Opus 4.8's high template.

## The plugin reviewers

The `code-review` plugin is a pull request workflow, separate from the built-in skill.

- Small-model agents check eligibility, find the `CLAUDE.md` files, and summarise the change.
- Five reviewers run in parallel. Two read the change: one for compliance with `CLAUDE.md`, one for obvious bugs in the changed lines. Two read history: git blame, and earlier pull requests on the same files with their comments. The fifth reads guidance in code comments.
- A scorer rates each issue from 0 to 100 against a rubric, and anything under 80 is dropped.
- A list of false positives excludes pre-existing issues, anything a linter catches, and lines the pull request did not touch.

`pr-review-toolkit` holds six agents: a code reviewer for `CLAUDE.md` and style, a simplifier, a comment analyser, a test analyser, a hunter of silent failures, and a type-design analyser. `feature-dev` holds one reviewer with confidence filtering, beside an explorer and an architect that review nothing.

## What this corrects

In [the comparison of review tools](2026-10-04-review-tools-compared.md):

1. Cleanup is not one finder. The earlier note grouped five separate angles under it. The templates call three of them cleanup: reuse, simplification, and efficiency. Altitude and conventions stand apart, and the conventions angle reads `CLAUDE.md` files.
2. Angle E, wrapper and proxy correctness, is missing. It joins with language pitfalls at the top two levels, so those levels run ten angles.
3. The caps are 4, 8, 10, 15, and 15. The sweep adds at most eight candidates before the cap.
4. The model-family templates differ more than the note says. Opus 4.8's medium and high templates verify nothing. Opus 5's are a minimal single pass with no angles. Low's cap of four holds for the default and Opus 5 only.

The earlier note says the shadow prompt ran under 2.1.287. That version was not installed, so this note covers 2.1.252 only.

## Not found

- The cloud level's prompt.
- Whether the sweep's candidates pass a verifier.
- What a model outside the table maps to, beyond the lookup's default.

# Review tools compared

How three agentic reviewers turn a diff into findings, and what each does that Melian does not.

## The Codex plugin's adversarial review

Source: the OpenAI Codex plugin for Claude Code, version 1.0.6: its `prompts/adversarial-review.md`, `schemas/review-output.schema.json`, and the scripts under `scripts/`.

The prompt casts the reviewer as an attacker. In the plugin's words, the job is to "break confidence in the change", find "the strongest reasons" it should not ship, and "default to skepticism", giving no credit for intent or likely follow-up. It names an attack surface, from authorisation and data loss to retries, races, version skew, and observability gaps. Each finding says what goes wrong, why, the impact, and a fix. The verdict is `needs-attention` if any material risk can be supported, else `approve`. The plugin prefers "one strong finding over several weak ones" and allows an empty list. It never invents files or lines, and labels any conclusion that rests on inference.

Past two files or 256 KB, Codex gets the file list instead of the diff and reads the rest from a read-only sandbox. A JSON schema enforces the output: a verdict, a summary, and findings with severity, file, line range, `confidence`, and a recommendation. Three layers keep it review-only: the sandbox, a verbatim relay, and a skill that forbids fixes.

## Claude Code's review skill

Source: the prompt templates in the [Claude Code](https://github.com/anthropics/claude-code) 2.1.252 binary, and the prompt that ran in Melian's review subagents on 2026-10-03 under 2.1.287, which matches them closely.

The skill reviews the branch against its upstream, with any uncommitted changes. Independent finders each take one angle, as separate subagents in the variants that use them:

- Line by line: read every hunk, then the whole function around it, since a defect on a line the change left alone, inside a function it edited, still counts.
- Removed behaviour: for each deleted line, name the invariant it held and find where the new code restores it.
- Cross-file tracing of callers and callees, and at the top levels language pitfalls.
- Cleanup: reuse, simplification, efficiency, altitude, and conventions, where a breach counts only if the finder can cite the standard's own wording and point to the line that breaks it.

Correctness outranks cleanup at the cap. Finders are told to forward every candidate whose failure they can describe concretely, because most misses come from finders silently discarding what they only half believe.

Effort sets the pipeline. Low reads the diff once and reports at most four bugs visible in a hunk. Medium biases to precision and high to recall, each with eight angles and a verify. The top levels add angles and a gap sweep. The model family picks the template, and some run every angle in one context, deduplicate, and verify nothing. The prompt that ran on Melian's shadow reviews was one of those: high effort, eight inline angles, dedup, no verify.

In the variants that use subagents, the verify pass is the precision mechanism. After dedup, one verifier per candidate returns confirmed when the trigger can be named and the line quoted, plausible when the mechanism is real but the trigger uncertain, and refuted when the claim is wrong or guarded elsewhere. At high effort the default is plausible, and a candidate may not be refuted for being speculative. A finding carries file, line, summary, failure scenario, category, and verdict. A review run without subagents must say it was single-pass.

## A private repository's low-cost review skill

Source: a Claude Code skill in a private Rails repository, read with the maintainer's access. It carries no licence, so this note describes it and quotes nothing.

It mirrors the repository's Anthropic-only multi-agent review at one to five percent of the cost, on inexpensive models from other families. Parallel finders each take one dimension, such as correctness, integration, tests, or security, and may report nothing outside an explicit file list. Every finding needs a concrete failure scenario and file and line evidence, enforced by an output schema.

Before the finders run, the orchestrator pastes in, as data, the callers of each changed class outside the diff, from [Enola](2026-10-04-enola.md)'s code graph. A walk by search timed out at 600 seconds twice; the precomputed version finished in 331.

Deduplication uses no model: drop off-scope findings, merge on file, line, and category, then cap. One verifier prompt per finding runs on a different model family, a cheap substitute for a stronger judge; it defaults to refuting and tries to reproduce the failure. Deep runs add two angles, on the guards and on the claim, across three families, and vote. The orchestrator then reads each surviving location itself and reports only what it can see. The report discloses uncovered dimensions, discards, cap drops, and cost.

## What Melian takes

- **Independent angles as lenses.** Each angle is its own conversation, as Melian's lenses already are; removed behaviour and conventions that cite the rule become lenses.
- **A verify pass.** Every candidate is attacked before it counts, with confirmed, plausible, and refuted verdicts.
- **The adversarial stance.** Look for reasons not to ship, give no credit for intent, and allow an empty answer.
- **Precomputed blast radius.** Callers outside the diff arrive as data from a code graph.
- **A mandatory failure scenario and evidence.** A verifier has nothing to attack without them.
- **Scrutiny levels.** Effort sets budgets and verification, chosen per lens rather than per review.
- **Coverage disclosure.** What did not run is said out loud, as Melian's check manifest already does.

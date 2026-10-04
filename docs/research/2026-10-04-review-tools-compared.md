# Review tools compared

How three agentic reviewers turn a diff into findings, and what each does that Melian does not.

## The Codex plugin's adversarial review

Source: the OpenAI Codex plugin for Claude Code, version 1.0.6: its `prompts/adversarial-review.md`, `schemas/review-output.schema.json`, and the scripts under `scripts/`.

The prompt casts the reviewer as an attacker. In the plugin's words, the job is to "break confidence in the change", find "the strongest reasons" it should not ship, and "default to skepticism", with no credit for intent, partial fixes, or likely follow-up work. It names an attack surface: authorisation and tenant isolation, data loss, rollback, retries and idempotency, races and re-entrancy, degraded dependencies, schema drift and version skew, and observability gaps. Each finding must say what goes wrong, why the path is vulnerable, the impact, and a fix. The verdict is `needs-attention` if any material risk can be supported and `approve` only if none can. The plugin prefers "one strong finding over several weak ones" and allows an empty list. It never invents files or lines, and labels any conclusion that rests on inference.

The diff is inlined only up to two files and 256 KB; past that Codex gets the file list and reads the rest itself from a read-only sandbox. A JSON schema enforces the output: a verdict, a summary, and findings with severity, file, line range, `confidence`, and a recommendation. The renderer never shows `confidence`. Review-only holds in three layers: the sandbox, a command that relays output verbatim, and a skill that forbids applying fixes.

## Claude Code's review skill

Source: the prompt templates in the Claude Code 2.1.252 binary, and the prompt that ran in Melian's review subagents on 2026-10-03 under 2.1.287, which matches them almost exactly. [Claude Code](https://github.com/anthropics/claude-code) runs the skill as a forked agent.

The skill reviews the branch against its upstream, with uncommitted changes when there are any. Independent finders each take one angle and run as separate subagents:

- Line by line: read every hunk, then the whole function around it, because a bug on an unchanged line of a touched function is in scope.
- Removed behaviour: for each deleted line, name the invariant it held and find where the new code restores it.
- Cross-file tracing of callers and callees, and at the top levels language pitfalls.
- Cleanup: reuse, simplification, efficiency, altitude, and conventions, where a violation counts only when the exact rule and the exact line can both be quoted.

Correctness outranks cleanup at the cap. Finders are told to pass on every candidate with a nameable failure scenario, because finders that quietly drop half-believed candidates cause most misses.

Effort sets the pipeline. Low reads the diff once and reports at most four bugs visible in a hunk. Medium biases to precision and high to recall, each with eight angles and a verify. The top levels add angles and a gap sweep for what the list lacks. Some model families run every angle in one context with no verify.

The verify pass is the precision mechanism. After dedup, one verifier per candidate returns confirmed when the trigger can be named and the line quoted, plausible when the mechanism is real but the trigger uncertain, and refuted when the claim is wrong or guarded elsewhere. At high effort the default is plausible, and a candidate may not be refuted for being speculative. A finding carries file, line, summary, failure scenario, category, and verdict. A review run without subagents must say it was single-pass.

## A private repository's low-cost review skill

Source: a Claude Code skill in a private Rails repository, read with the maintainer's access. It carries no licence, so this note describes it and quotes nothing.

It runs the same shape as the repository's Anthropic-only multi-agent review at one to five percent of the cost, with every model stage on inexpensive models from other families. Parallel finders each take one dimension: correctness, integration, tests, security, plus repository overlays for conventions and paired obligations. Each finder gets the explicit file list and may report nothing outside it. Every finding needs a concrete failure scenario and evidence as file and line references, and the command line's schema flag enforces the shape.

Before the finders run, the orchestrator asks [Enola](2026-10-04-enola.md)'s code graph for the callers of each changed class outside the diff and pastes them into the prompt as data. A walk by search timed out at 600 seconds twice; the precomputed version finished in 331.

Deduplication uses no model: drop off-scope findings, deduplicate on file, line, and category, then cap, printing the counts. Verification runs one prompt per finding on a different model family, because cross-family checking is the cheap substitute for a stronger judge. The verifier defaults to refuting and tries to reproduce the failure. Deep runs add two more angles, checking the guards and the claim itself, on three families, and vote. The orchestrator then reads each surviving location itself and reports only what it can see. The report discloses uncovered dimensions, off-scope discards, cap drops, and cost. Reviewers run in an operating-system sandbox.

## What Melian takes

- **Independent angles as lenses.** Each angle is its own conversation with its own focus, which Melian's lenses already are; removed behaviour and quote-the-rule conventions become lenses.
- **A verify pass.** Every candidate is attacked before it counts, with confirmed, plausible, and refuted verdicts.
- **The adversarial stance.** Lens prompts look for reasons not to ship, give no credit for intent, and allow an empty answer.
- **Precomputed blast radius.** Callers outside the diff arrive as data from a code graph instead of a search walk.
- **A mandatory failure scenario and evidence.** A verifier has nothing to attack without them.
- **Scrutiny levels.** Effort sets angles, budgets, and verification, chosen per lens rather than per review.
- **Coverage disclosure.** What did not run is said out loud, which Melian already does through the check manifest.

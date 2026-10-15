# A round after a fix pass reviews the change since the last reviewed head

Problem: every Melian round reviews the whole pull request again. Lenses sample what they read, so a round re-reads unchanged code and finds something new in it, and "one clean round" depends on which lines a lens happened to read. Each round also costs the whole pull request's time and tokens, however small the fix.

Example: on [pull request #116](https://github.com/melian-agent/melian/pull/116), the late rounds found untested paths one at a time, in code no fix pass had touched, and the review of record found one more. On [pull request #98](https://github.com/melian-agent/melian/pull/98), rounds ran one to two hours against 13,000 changed lines.

Choice: a round after a fix pass reviews the diff from the last reviewed head to the new head, with the full range as context. Prior findings on lines the delta did not touch stay open. A full round runs at the start of a pull request and as the last round before the queue. Until this is built, every round runs in full.

This decision records the problem and the direction only. The step that builds it, plan step 24, writes the full decision against the code first and has it attacked before any code. Designing the stored shapes and the trust rules here, ahead of the step, drew a new hole in each review of this decision; [the convergence rules](2026-10-15-review-loop-convergence-rules.md) say to stop at that point.

Open questions for the step:

- Round identity and attachment. A delta round and the full round after it can sit at the same base and head, which [review identity](2026-10-03-review-identity.md) and [review attachment](2026-10-03-review-attachment.md) use as the key for tasks, verdict and sightings. Found by Melian's fourth round on [pull request #122](https://github.com/melian-agent/melian/pull/122). The step decides the key, and supersedes both decisions in part with every surviving clause restated.
- Carried sightings. Publication diffs each revision's findings by ID, so a finding a delta round does not sight reads as resolved and its thread closes. Found by the same round. The step decides who writes what at the new revision so a carried finding stays open.
- Re-judging changed findings. A prior finding whose cause lines the delta changed needs a fresh judgement; sending it to the verifier against the new head is the first idea, not a settled one.
- The status. A delta round reviews a sample, so it must not pass `melian/review` and let the queue take a pull request. Found by Codex's adversarial review of [pull request #122](https://github.com/melian-agent/melian/pull/122). The step decides what status a delta round sets.
- Which rounds run in full: the first, the last before the queue, and any after a base change or a rewritten history. The step decides who marks the last one.

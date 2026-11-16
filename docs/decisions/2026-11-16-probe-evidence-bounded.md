# A verifier's probe evidence fits a fixed budget

Amends: [A trust-boundary level that runs probes](2026-11-07-trust-boundary-level-that-probes.md), "The verifier's prompt renders every claim's probe evidence whole", which [issue #357](https://github.com/melian-agent/melian/issues/357) bounds
Amends: [A finished probing run is never reused](2026-11-14-probing-runs-not-reused.md), "The verifier's version hashes how a claim's probe evidence is worded and rendered", for the wording of a cut
Amends: [Request keys as built](2026-11-14-request-keys-as-built.md), the verification's request contents, for a verification whose candidates carry probe evidence

Status: the maintainer ruled on 2026-11-16, as the coordinator relayed in its session, to turn probing on for Melian's own rounds before this bound exists, on the condition that it comes next. The budget, keeping both ends of a cut part, repeating the plan for each claim, and keying the cut only where probe evidence is shown are the coordinator's answers on approach, given on 2026-11-16 in its session. They are not maintainer rulings.

## The problem

The verifier's prompt rendered every claim's probe evidence whole: the plan, a script of up to 32 KiB, files of up to 128 KiB and two outputs of up to 16 KiB each. Nothing bounded the total against the verifier model's context.

For example, a merged defect of four probing claims at their limits renders about 1 MB of evidence. The verifier's request fails on context length, and the review ends not reviewed after every probe has already run twice.

## Choice

- A candidate's probe evidence, every claim's block as the prompt joins them, renders within 128 KiB, counted in UTF-8 bytes.
- Evidence that fits renders exactly as before, byte for byte.
- Past the budget, Melian cuts each part a model or the head's code wrote: the plan, the script, each file, what the probe printed for the prober, why Melian could not run it again, and what it printed for Melian. It finds the largest size every part may keep and still fit, so the longest parts lose the most and a part shorter than that size loses nothing.
- A cut part keeps its first and last halves, at character boundaries, around a line that says how many bytes were cut there.
- Melian's own text is never cut: the headings, the line that says how the probe ended each time, the judging rule and the files' paths.
- A note outside the review's boundary says which parts were cut and by how much. It names a file by its number, never its path, since the path is the head's text.
- When anything was cut, the verifier reads a rule for cut evidence. It may confirm what the shown parts show. It must not refute or lower a claim because the part that would show it was cut. When the lines that decide the claim fall in a cut, it answers plausible and says which part was cut.
- The stored records stay whole. The cut is made in the verifier's prompt alone. The candidate's probes and the review's probe reruns keep every byte, and a rerun runs the stored probe.
- The verifier's version does not hash the cut's wording, so the cut judges no stored claim again. A verification's request keys the budget, the cut's wording and a cut rendered over fixed samples, and only when one of its candidates' claims carries probe evidence. Every other verification keeps the key it had.
- A test reads the committed verifier route's model, fallbacks and accepted models, and fails, naming the model, when one has a context of fewer than twice the budget in tokens. Counting a byte of evidence as at most one token leaves the other half for the instructions, the claims and the verifier's reads.

## Why

A review that fails on context length after its probes ran reports nothing. A cut that keeps both ends shows a script's setup and its assertions, and an output's first lines and its exit. An attack's deciding lines usually fall in those places.

Refuting a claim because its evidence was cut would turn Melian's own limit into a verdict against the claim. Confirming one from parts the verifier never read would turn it into a verdict for the claim. Plausible says the claim stands unproven, which is what a verifier knows when the deciding lines are gone. The rule cannot confirm a probe that passed again, because how each run ended is Melian's text and is never cut.

Hashing the cut's wording into the verifier's version would judge every stored claim again, those with no probe evidence included. A verifier shown no probe evidence never reads a cut, so its key need not hold one. [Pull request #490](https://github.com/melian-agent/melian/pull/490) keys each lens's own judging rule the same way.

## What it gives up

- The tightest accepted models, `openai/gpt-5.5` and `openai-codex/gpt-5.6-terra`, have a context of 272,000 tokens. Twice the budget is 262,144, so the budget can grow only about 3% before the test fails.
- Each claim repeats the plan, as before, so a merged defect spends its budget on copies of one plan. The copies are cut like any other part.
- Melian's own text is not bounded. With up to 16 file paths of 200 characters, it comes to about 6.3 KiB a claim, so a candidate would need about 20 probing claims to pass the budget on that text alone. A candidate merges the claims lens runs made of one defect, and only a probing run's claims carry evidence, so it stays far below that.
- A verification of probe evidence stored before this change has a new key, so it runs again once.

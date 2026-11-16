# A verifier's probe evidence fits a fixed budget

Amends: [A trust-boundary level that runs probes](2026-11-07-trust-boundary-level-that-probes.md), "The verifier's prompt renders every claim's probe evidence whole", which [issue #357](https://github.com/melian-agent/melian/issues/357) bounds
Amends: [A finished probing run is never reused](2026-11-14-probing-runs-not-reused.md), "The verifier's version hashes how a claim's probe evidence is worded and rendered", for the wording of a cut
Amends: [Request keys as built](2026-11-14-request-keys-as-built.md), the verification's request contents, for a verification whose candidates carry probe evidence

Status: the maintainer ruled on 2026-11-16, as the coordinator relayed in its session, to turn probing on for Melian's own rounds before this bound exists, on the condition that it comes next. The budget, keeping both ends of a cut part, repeating the plan for each claim, are the coordinator's answers on approach, given on 2026-11-16 in its session. So is keying the evidence each cut candidate is shown, given after Melian's second round found that a cut over fixed samples left a real prompt's changes outside the key. Failing closed when even the least cut does not fit is the coordinator's answer on approach, given on 2026-11-16 in its session after Codex's adversarial review found the overflow. So is keeping whole the row of the attack a probe answered, given after the review of record found it could fall in the cut. They are not maintainer rulings.

## The problem

The verifier's prompt rendered every claim's probe evidence whole: the plan, a script of up to 32 KiB, files of up to 128 KiB and two outputs of up to 16 KiB each. Nothing bounded the total against the verifier model's context.

For example, a merged defect of four probing claims at their limits renders about 1 MB of evidence. The verifier's request fails on context length, and the review ends not reviewed after every probe has already run twice.

## Choice

- A candidate's probe evidence, every claim's block as the prompt joins them, renders within 128 KiB, counted in UTF-8 bytes.
- Evidence that fits renders exactly as before, byte for byte.
- Past the budget, Melian cuts each part a model or the head's code wrote: the plan's attacks before and after the one the probe answered, the script, each file, what the probe printed for the prober, why Melian could not run it again, and what it printed for Melian. It finds the largest size every part may keep and still fit, so the longest parts lose the most and a part shorter than that size loses nothing.
- A cut part keeps its first and last halves, at character boundaries, around a line that says how many bytes were cut there.
- The plan's row for the attack the probe answered is never cut, since it says what a failing probe of that attack shows. Without it a verifier cannot tell a probe that failed again from one that passed, and could confirm nothing.
- Melian's own text is never cut: the headings, the line that says how the probe ended each time, the judging rule and the files' paths.
- When the evidence passes the budget even with every part cut to nothing, Melian asks no verifier of that candidate. Its verification fails, and the review reads not reviewed. The check's reason names the budget and the count of the candidate's probing claims.
- A note outside the review's boundary says which parts were cut and by how much. It names a file by its number, never its path, since the path is the head's text.
- When anything was cut, the verifier reads a rule for cut evidence. It may confirm what the shown parts show. It must not refute or lower a claim because the part that would show it was cut. When the lines that decide the claim fall in a cut, it answers plausible and says which part was cut.
- The stored records stay whole. The cut is made in the verifier's prompt alone. The candidate's probes and the review's probe reruns keep every byte, and a rerun runs the stored probe.
- The verifier's version does not hash the cut's wording, so the cut judges no stored claim again. A verification's request keys, for each candidate whose evidence was cut, the evidence its verifier is shown, from the same call the prompt makes. It cuts under the review's nonce, as the prompt does, and then names the boundary by a fixed nonce, since a head's text that holds the fixed nonce renders shorter under it. A candidate no cut fits keys the reason it is asked nothing. Every other verification keeps the key it had.
- A test reads the committed verifier route's model, fallbacks and accepted models, and fails, naming the model, when one has a context of fewer than twice the budget in tokens. Counting a byte of evidence as at most one token leaves the other half for the instructions, the claims and the verifier's reads.

## Why

A review that fails on context length after its probes ran reports nothing. A cut that keeps both ends shows a script's setup and its assertions, and an output's first lines and its exit. An attack's deciding lines usually fall in those places.

Refuting a claim because its evidence was cut would turn Melian's own limit into a verdict against the claim. Confirming one from parts the verifier never read would turn it into a verdict for the claim. Plausible says the claim stands unproven, which is what a verifier knows when the deciding lines are gone. The rule cannot confirm a probe that passed again, because how each run ended is Melian's text and is never cut.

Hashing the cut's wording into the verifier's version would judge every stored claim again, those with no probe evidence included. A verifier shown no probe evidence, or evidence that fits, never reads a cut, so its key need not hold one. Keying the cut each candidate is shown, rather than a cut over fixed samples, means any change that reaches a prompt reaches its key. [Pull request #490](https://github.com/melian-agent/melian/pull/490) keys each lens's own judging rule the same way.

## What it gives up

- The tightest accepted models, `openai/gpt-5.5` and `openai-codex/gpt-5.6-terra`, have a context of 272,000 tokens. Twice the budget is 262,144, so the budget can grow only about 3% before the test fails.
- The budget is fixed, whatever model the verifier's route names. A repository's `melian.yaml` can route the verifier to a model of under twice the budget in tokens, which the catalogue test does not check. A byte of evidence is at most one token, so a 200,000-token model keeps about 69,000 tokens for the instructions, the claims and its reads. A smaller one can still overflow, and its review reads not reviewed, as it did before this change. A budget taken from the route's smallest context is the fix, and it is not built. Codex's adversarial review found the gap, and the coordinator's answer on approach, given on 2026-11-16 in its session, is to record it here.
- Each claim repeats the plan, as before, so a merged defect spends its budget on copies of one plan. The copies are cut like any other part, except each claim's answered row.
- The answered row is never cut, so a candidate refuses at fewer merged claims than it would if the row were cut: up to about 2.5 KiB more of each claim's evidence stays whole. Keeping it whole is the coordinator's answer on approach, given on 2026-11-16 in its session after the review of record found the row could fall in the cut.
- Melian's own text is not cut. With up to 16 file paths of 200 characters, it comes to about 6.3 KiB a claim, so a candidate of about 20 probing claims passes the budget on that text alone. Such a candidate is never judged: its review reads not reviewed until it merges fewer probing claims or the budget grows. A candidate merges the claims lens runs made of one defect, and only a probing run's claims carry evidence, so it stays far below that.
- Melian refuses a candidate when its evidence passes the budget with every part cut to nothing. Cutting a part adds a line inside it and an entry in the note, so a part of a few bytes renders longer cut than whole. For many such parts, keeping a few bytes of each renders smaller than keeping none, and Melian refuses evidence that a larger keep would fit. Codex's adversarial review gave an example: 41 merged probing claims, each with 16 files of one byte. Keeping one byte fits within the budget, yet Melian asks no verifier and the review reads not reviewed. For the same reason, a cut that does fit can keep fewer bytes than the largest keep that fits. A search that skips a part a cut would not shorten is the fix, and it is not built. This is the coordinator's answer on approach, given on 2026-11-16 in its session.
- A verification task stored past its spawn phase before this change resumes with the prompt it was given then, whole, since the task's version is unchanged. Such a review can still fail on context length and read not reviewed, as it could before. Rerunning the review starts a new task, which bounds the evidence. This is the coordinator's answer on approach, given on 2026-11-16 in its session, since a new task version would collide with [issue #481](https://github.com/melian-agent/melian/issues/481)'s version 5.
- A verification whose candidate's evidence is cut, or refused, has a new key, so one stored before this change runs again once.

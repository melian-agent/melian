# The verifier may lower a severity and set a pre-existing scope

Status: planned for milestone 2, step 17, "The verifier lowers severity and sets scope". Nothing here is built.

Problem: the verifier can keep a finding or drop it, and nothing in between. A lens sets the severity, and a verifier that confirms the mechanism also confirms that severity, however narrow the failure turns out to be. The verifier also answers whether the failure was there before the change, and nothing reads that answer.

Example: a lens reports a P2 on a parse call that fails for one malformed input. The verifier reads the callers and confirms it. It also finds that the only caller validates that input first, so the failure needs a second defect to appear. The finding is real, so it is not refuted. It stays P2 and the author must acknowledge it.

Two tools show the same gap from outside. In [the CodeRabbit sample](../research/2026-10-12-coderabbit-categories.md), authors dismissed 15% of major findings and 4% of minor ones. The severity the reviewer was surest of was the one most often rejected. And the `code-review` plugin for Claude Code lists a pre-existing issue as a false positive that its scorer drops, as [the note on its review angles](../research/2026-10-12-claude-code-review-angles.md) records. Melian asks its verifier that question and then ignores the answer.

A second example, for scope: a change moves a function to another file unedited. Every line of it is an added line, so a null dereference a lens finds there reads as `introduced` and can block. The same code sat at the old path on the base.

Choice: the verifier may lower a finding's severity, and never raise it. Its answer to "was the failure there before the change" sets the finding's cause to `pre-existing`. Both move a finding one way only, toward requiring less.

- A lowering is a typed severity from the rubric, below the lens's own, with a reason. It is recorded in the `verification` record beside the lens's severity, which stays stored. Adjudication resolves the finding at the lowered severity.
- A lowering is shown with the original, wherever the finding is shown: the terminal, the JSON, the review comment, and the ledger. An author reads "P3, lowered from P2" and the reason.
- A lowering needs the same read-back evidence a refutation does: locations Melian reads back and stores. A lowering without them is refused, and the finding keeps the lens's severity.
- A lowering rides on a `confirmed` or `plausible` verdict. The strongest-verdict rule is unchanged: `confirmed` outranks `plausible`, which outranks `refuted`. A lowering counts only when the verdict that speaks for the claim carries it.
- A deterministic finding is never lowered. A static, guardrail, or mutation finding carries its own proof, and its severity comes from configuration. A defect a deterministic check co-reported keeps that check's severity.
- A merged finding takes the highest severity among its claims after lowering. A claim no verifier judged keeps its own.
- A pre-existing answer needs a base location that Melian reads back, holding the code that fails. With it, the finding's cause reads `pre-existing`, and the lens's own cause stays stored beside it. The finding is then capped at advisory, as every `pre-existing` finding is.
- The verifier never promotes. It cannot make a finding `affected` or `introduced`, and it cannot raise a severity.

A correction stays what it was: text shown beside the finding, which changes nothing. The lowering is a separate typed field. So this refines [the verification pass](2026-10-04-verification-pass.md) and [the verifier as built](2026-10-05-verifier-as-built.md), and replaces neither.

Lowering is not scoring. Milestone 4 plans a decision model that scores severity and confidence as calibrated probabilities. A lowering has no number. It is a typed lower severity with a reason, and only the LLM verifier writes it. `confidence` stays reserved for the decision model. Each lowering, stored beside the lens's severity and joined to what the author did next, becomes calibration data for that scoring. Until calibration shows a decision model's lowerings hold, a decision-model executor may not lower, as it may not refute.

What this gives up: a second model can now unblock a real defect without refuting it. A P1 lowered to P2 stops blocking under the default table. The verifier reads the head, which the author writes, so an author can try to argue a severity down. The guards are the evidence rule, the original severity shown beside the lowered one, and goldens that aim an injection at the lowering. The failure to design against is unchanged: a real P1 lost on a model's word.

The step's goldens:

- a confirmed finding whose narrow trigger earns a lowering;
- a severe finding that must keep its severity;
- a lowering refused for want of evidence;
- a moved function whose defect becomes `pre-existing`;
- a defect the change did introduce, which must stay `introduced`;
- a deterministic co-report that keeps its severity;
- an injection that asks for a lowering.

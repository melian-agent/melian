# 2026-10-25: high signal, low noise enforces what reading can check

Codex's adversarial review of [pull request #214](https://github.com/melian-agent/melian/pull/214) at `36012c6e` found two medium gaps. First, "every line earns its place" was the enforced rule, and only judgement can apply it, so a lens could flag any added line. [The decision](../decisions/2026-10-25-high-signal-low-noise.md) now keeps it as the reason and enforces three rules a lens and a verifier can check by reading. A fact is stated once in one surface. Named diagnostic classes stay out of the pull-request comment and the review body: caller-context, triage-input and hand-off-size notes, listed with the code that produces them. A table sets what each surface shows and omits. The maintainer added a fourth rule: in comments and review bodies, a section that asks the reader to act stays open, and one the reader needs only to dig in is collapsed in `<details>`, with a `<summary>` giving a count and a noun; [pull request #217](https://github.com/melian-agent/melian/pull/217) builds it. Wording, tone and added context are never a finding under it.

Second, the verifier could not hold `contradicts-documented-decision` to its limits: it received the decision index but not the design index the lens reads. `reviewChangeset` now passes Design sections at base and Design files at base to every design verification candidate, and the verifier's instructions mirror the fallback. A claim is refuted when it cites inactive or head-only text or descriptive words, when the change only rewords or adds context, or when a more specific rule names the defect. The design lens's body says the same of rewording and added context. Its version moves to `768a63490995`.

Goldens can now script the verifier's verdicts in `verifier.json`, by finding ID. Four new clean goldens have the design lens over-report and the verifier refute:
- `design-contradicts-documented-decision-added-context-clean`
- `design-contradicts-documented-decision-wording-clean`
- `design-contradicts-documented-decision-inactive-clean`
- `design-contradicts-documented-decision-head-only-clean`

The two positive goldens now script `confirmed` with a reason. The two earlier clean twins report nothing, so no claim reaches their verifier.

Failing first: the verifier tests failed on the missing instruction sentences and the missing design sections. With `verifier.json` still ignored, the four new goldens failed with precision 0. All pass after the change.

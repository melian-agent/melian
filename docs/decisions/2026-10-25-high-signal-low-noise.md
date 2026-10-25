# High signal, low noise

Status: accepted by the maintainer, 2026-10-25.

Amends: [Findings read in one register](2026-10-24-finding-register.md), what a renderer shows a reader and where an element's defined place may be.

## Problem

The README promised that Melian is **Quiet**: "Good changes pass without ceremony." Nothing turned that promise into a rule a renderer or a review can check, so each new note found its way into every place a verdict prints.

Example: [pull request #201](https://github.com/melian-agent/melian/pull/201#pullrequestreview-5641448520)'s published review has a section "Lenses that ran with a note". It repeats seven "Callers unavailable for <file>: line N: directory-scoped name is ambiguous" notes, and "triage input was cut, so no lens could skip", under each of eight lenses. That is about 50 lines. A reviewer can act on none of them, and none changes what the review covered: caller context is an optional input, and a lens a budget ended, that failed, or that was skipped already appears under the checks that did not run. [Issue #212](https://github.com/melian-agent/melian/issues/212) records the case and the maintainer's ruling on it.

## Decision

The principle is **high signal, low noise**. It governs everything Melian shows a person, not only its findings: a pull-request comment, a review body, the `melian/review` status, the terminal's default output, a CLI message and a skill's reply. What Melian shows a person is what that person needs to act on the change or to judge how far to trust the verdict. Everything else is noise, however true.

"Every line earns its place" is the reason for what follows, not a test: a line earns it when its reader can act on it, or when it changes how far the reader can trust the verdict. Whether a line earns its place is judgement, and judgement is not something a lens or a verifier can check by reading. So this decision enforces four rules that they can, and nothing else.

1. **A fact is stated once in one surface.** The same note, count or finding printed twice in one pull-request comment, one review body, one ledger or one terminal output breaks the rule: once per lens, once per finding, once per round, or once in each of two sections. A note several lenses share prints once, naming the lenses where that matters. Each instance of a repeated shape stays its own finding, as [the shape decision](2026-10-15-each-finding-names-its-shape.md) sets, and is printed once.
2. **Named diagnostic classes stay out of the pull-request comment and the review body.** These lines explain how Melian ran, not what the reader must do or trust:
   - caller-context notes: "Callers unavailable: …" and "Callers unavailable for <file>: …", from `CallerContext` in `packages/pipeline/src/callers.ts`, and "Callers unavailable: the host supplied no graph context", from `packages/pipeline/src/review.ts`;
   - triage-input notes: "triage input was cut, so no lens could skip", "triage failed, so it ran at its default level: …", "triage did not run, so it ran at its default level: …" and "triage could not choose <level>, …", from `packages/pipeline/src/review.ts`;
   - hand-off-size notes: "kept the defects it hands to …, whose files here would list past …", from `packages/pipeline/src/review.ts`.

   A new diagnostic joins this list in the change that adds it. One exception: a single line may summarise a diagnostic that reduces what the review covered, such as "callers unavailable for every changed site, so no lens saw the blast radius", printed once.
3. **Each surface shows and omits what this table says.**

| Surface | Shows | Omits |
|---|---|---|
| Inline comment | One finding, in the register's parts | Diagnostics and every other finding |
| Review body | The review outcome and status mapping, counts, advisories, attested dismissals, checks that did not run, provisional checks, lenses a budget ended that count as run, checks that left the committed routes, resolved and dismissed findings, trust-floor summaries, and at most one coverage line under rule 2 | The diagnostic classes of rule 2 |
| `melian/review` status | Its plain description | Everything else |
| Ledger | Every round's record, every diagnostic included | Nothing Melian recorded |
| Terminal default | The verdict, the findings that need attention, checks that did not run and plan warnings | The diagnostic classes of rule 2, which a flag shows |
| `--json` and `melian telemetry` | Everything stored | Nothing |

4. **A section stays open when it asks the reader to act, and is collapsed when the reader needs it only to dig in.** In a pull-request comment or a review body, a collapsed section sits in `<details>`, with a `<summary>` that states what is inside as a count and a noun, such as "3 advisories". Open: the verdict and status, blocking and acknowledgement findings in full, and checks that did not run. Collapsed: advisories, attested dismissals grouped by their shared reason, run details with a summary line outside and the table inside, the walkthrough, and trust notes that change nothing the reader must act on. Inline comments stay open. The maintainer set this rule on 2026-10-25, and [pull request #217](https://github.com/melian-agent/melian/pull/217) builds it.

Nothing on the review body's list is ever cut: each changes what the reader must do or how far the verdict can be trusted. Nothing Melian records is dropped; a line that leaves a reader's surface stays in the ledger, the JSON or telemetry. Wording, tone and added context are never a finding under this decision. A line that rewords another, or adds context without repeating a fact or printing a named diagnostic, breaks none of the four rules.

The table is the target. Today the review body still prints the rule-2 diagnostics under "Lenses that ran with a note"; [issue #212](https://github.com/melian-agent/melian/issues/212) moves them.

This amends the register decision where the two meet. The register says every element a current renderer prints keeps a defined place. Under this rule, that place may be the ledger, the JSON or telemetry rather than the comment or the terminal. Where the register's table, or a renderer's tests, keep a line on a reader's surface that this rule moves, this rule wins, and the change that moves it updates the table row and the tests together. Row 21's "note" is the first such element.

The `design` lens enforces the four rules through its fallback rule, `contradicts-documented-decision`, once this decision is active at the base. The verifier receives the same base decision and design index the lens does, and refutes a claim under that rule that cites inactive or head-only text, descriptive rather than prescriptive words, a wording change or added context, or a defect a more specific rule names. The rule is generic, so it reads each repository's own decisions and imposes this one on nobody else. The goldens `design-contradicts-documented-decision-noise`, `-noise-clean`, `-added-context-clean` and `-wording-clean` exercise rule 1 and its limits; `-diagnostic-clean`, `-surface-clean` and `-collapse-clean` exercise rules 2, 3 and 4 with output that follows them. Scripted, they prove the plumbing only. Whether the lens and verifier stay quiet on them is a live measurement.

A test holds a renderer to rule 1 by rendering a review whose lenses all share one note and counting the note's lines in each surface's output. It holds a renderer to rule 2 by asserting that no line of a named class appears in the comment or the review body.

## Why

A reader who meets 50 lines they cannot act on stops reading, and then misses the one line that matters. Each repeat looks harmless to the change that adds it, because it is one more line. Only a written rule makes the sum visible and gives a renderer's tests and a review something to hold a change to.

The rules stop at what reading can settle, because a rule a reviewer must judge produces findings two reviewers disagree on, and each disagreement is more noise. The carve-outs follow the principle. A blocking finding, the status line and the checks that did not run are what a reader acts on. Attested dismissals, a counted budget end and the trust-floor notes say how far to trust a green verdict. Cutting them would make the output quieter by making it less honest.

Moving diagnostics to the ledger, the JSON and telemetry keeps everything for the person tuning Melian, where they already look, and away from the person reviewing the change.

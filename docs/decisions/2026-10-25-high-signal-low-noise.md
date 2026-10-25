# High signal, low noise

Status: accepted by the maintainer, 2026-10-25.

Amends: [Findings read in one register](2026-10-24-finding-register.md), what a renderer shows a reader and where an element's defined place may be.

## Problem

The README promised that Melian is **Quiet**: "Good changes pass without ceremony." Nothing turned that promise into a rule a renderer or a review can check, so each new note found its way into every place a verdict prints.

Example: [pull request #201](https://github.com/melian-agent/melian/pull/201#pullrequestreview-5641448520)'s published review has a section "Lenses that ran with a note". It repeats seven "Callers unavailable for <file>: line N: directory-scoped name is ambiguous" notes, and "triage input was cut, so no lens could skip", under each of eight lenses. That is about 50 lines. A reviewer can act on none of them, and none changes what the review covered: caller context is an optional input, and a lens a budget ended, that failed, or that was skipped already appears under the checks that did not run. [Issue #212](https://github.com/melian-agent/melian/issues/212) records the case and the maintainer's ruling on it.

## Decision

The principle is **high signal, low noise**. It governs everything Melian shows a person, not only its findings: a pull-request comment, a review body, the `melian/review` status, the terminal's default output, a CLI message and a skill's reply. What Melian shows a person is what that person needs to act on the change or to judge how far to trust the verdict. Everything else is noise, however true.

The rules that follow from it:

1. **Every line earns its place.** A line earns it when its reader can act on it, or when it changes how far the reader can trust the verdict.
2. **A fact is stated once.** Once per surface, never per lens, per finding or per round. A note several lenses share prints once, naming the lenses where that matters. A finding prints once per instance, and never in two places of one comment; this keeps [the shape decision](2026-10-15-each-finding-names-its-shape.md), so each instance stays its own finding.
3. **Diagnostics go to the ledger, `--json` or telemetry.** A line that explains how Melian ran, rather than what the reader must do or trust, goes to the ledger, `melian findings --json`, `melian telemetry` or a flag such as `--all`. The ledger is the record of what Melian did, which a reader opens to audit a round, so it keeps what the other surfaces leave out. Nothing Melian records is dropped.
4. **A trust-changing note is one line.** A diagnostic reaches a reader's surface only when it changes how far the reader can trust the review, such as "callers unavailable for every changed site, so no lens saw the blast radius". It then prints once, as one line.
5. **What the rule never cuts.** A blocking or acknowledge finding; the status line; the review outcome and its status mapping; attested dismissals; checks that did not run, provisional checks, and a lens a budget ended that its level counts as run; checks that left the committed routes; and the trust-floor notes the register keeps. Each changes what the reader must do or how far the verdict can be trusted, so each keeps its place.

This amends the register decision where the two meet. The register says every element a current renderer prints keeps a defined place. Under this rule, that place may be the ledger, the JSON or telemetry rather than the comment or the terminal. Where the register's table, or a renderer's tests, keep a line on a reader's surface that this rule moves, this rule wins, and the change that moves it updates the table row and the tests together. Row 21's "note" is the first such element: [issue #212](https://github.com/melian-agent/melian/issues/212) moves it.

A test holds a renderer to the rule by rendering a review whose lenses all share one note and asserting the line's count in the output: zero for a note that changes nothing, one for a note that changes trust.

## Why

A reader who meets 50 lines they cannot act on stops reading, and then misses the one line that matters. Each repeat looks harmless to the change that adds it, because it is one more line. Only a written rule makes the sum visible and gives a renderer's tests and a review something to hold a change to.

The carve-outs follow the same test. A blocking finding, the status line and the checks that did not run are what a reader acts on. Attested dismissals, a counted budget end and the trust-floor notes say how far to trust a green verdict. Cutting them would make the output quieter by making it less honest.

Moving diagnostics to the ledger, the JSON and telemetry keeps everything for the person tuning Melian, where they already look, and away from the person reviewing the change.

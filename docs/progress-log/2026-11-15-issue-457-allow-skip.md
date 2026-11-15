# Issue #457: a golden's own allowSkip no longer excuses a lens

Builder agent: Codex's adversarial review of [pull request #462](https://github.com/melian-agent/melian/pull/462), at `a2dfdea6`, raised one medium finding. It is fixed here.

## The finding

"Loaded allowSkip entries can bypass the new completeness gate", at `goldens.ts:402-408`. `runGolden` added the host checks to the golden's own `checks.allowSkip`, which can name a lens. A golden that disables `lens.conventions` and lists it in `allowSkip` read as reviewed and scored, without the lens it claims to measure.

## The test, before and after

**fails a scripted run whose policy disables a lens and lets that lens skip**, in `goldens.test.ts`, copies `clean-rename` with that policy. It expects the run to fail as not reviewed, naming the disabled lens.

At `a2dfdea6` it fails for the reported reason:

```
AssertionError: promise resolved "{ golden: { …(5) }, findings: [], …(4) }" instead of rejecting
```

At `dd5dd7dd` it passes, run alone, and `goldens.test.ts` and `live-output.test.ts` pass, 171 of 171.

## The fix

`runGolden` sets `allowSkip` to the host checks alone, replacing the golden's list rather than adding to it. A golden measures its lenses, so nothing else may skip with leave. No committed golden sets `allowSkip`.

## Mutants

The fix commit adds 2 mutants, both on line 408, and both were killed by **scripted clean-rename > finds exactly what the golden expects, with its cause, failure scenario, and evidence**, run alone, with one test collected. Emptying the whole config crashes the run. Emptying `checks` leaves the host checks without leave, so the run reads not reviewed.

The commit changed `goldens.ts` and `goldens.test.ts`, which every earlier claim names, so every claim was rerun at `dd5dd7dd`, over `f7c66a0d...dd5dd7dd`. The branch's merge base with `main` is `f7c66a0d`. [The inventory](2026-11-15-issue-457-allow-skip-mutants.json) records each of the 38 mutants, none omitted:

- **26 killed**, each by its named test, run alone, with one test collected. The fix replaced line 408, so the three mutants the old line held are gone, and its two new ones are among the 26.
- **1 equivalent**: `["Stryker was here"]` for the unprobed check's fallback, as before.
- **11 ignored** string literals, which Stryker does not generate.

`node scripts/enumerate-mutants.mjs --sample` accepts the inventory.

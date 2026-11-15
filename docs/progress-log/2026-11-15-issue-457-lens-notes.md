# Issue #457: a golden's lens notes print once each, under MELIAN_EVAL_SHOW

Builder agent: the second round on [pull request #462](https://github.com/melian-agent/melian/pull/462), at `3d5fc182`, raised one finding above advisory. It is fixed here.

## The finding

`15add9b3ff7dcc5e`, P2 acknowledge, `lens.design`, at `live-output.ts:66-67`. The live report printed every reason a check that ran recorded, by default, once per lens. [The high-signal decision](../decisions/2026-10-25-high-signal-low-noise.md) states a fact once, and keeps the diagnostic classes, caller context among them, out of the terminal's default output. A live golden whose lenses ran without caller graph context printed "Callers unavailable: the host supplied no graph context" once for each lens, under the score, by default.

## The test, before and after

**prints a note several lenses share once, and only when MELIAN_EVAL_SHOW asks**, in `live-output.test.ts`, gives two lenses that note. It expects the default output to hold only the score and corpus lines, and `MELIAN_EVAL_SHOW=1` to print the note once, naming both lenses.

At `3d5fc182` it fails for the reported reason:

```
AssertionError: expected [ …(4) ] to deeply equal [ …(2) ]
+   "    lens.correctness: Callers unavailable: the host supplied no graph context",
+   "    lens.contracts: Callers unavailable: the host supplied no graph context",
```

## The fix

`GoldenRun` carries `notes`, from `Verdict.lensNotes()`, in place of the verdict's `ran` records. That method already gives each distinct note once with the checks that carry it, as the rendered review does. `reportGoldens` prints them only under `MELIAN_EVAL_SHOW=1`, the flag that already prints the rendered review. A note is a diagnostic, so it stays out of the default output. The first `reportGoldens` test now sets the flag, and the sandbox test reads the probing lens's note from `notes`.

[Issue #356](https://github.com/melian-agent/melian/issues/356)'s measurement now sets `MELIAN_EVAL_SHOW=1` to see each probing golden's attacks and probes. The flag also prints the rendered review.

At `f458fb2b`, `live-output.test.ts` and `goldens.test.ts` pass, 170 of 170.

## Mutants

The fix commit adds 7 mutants; 3 are ignored string literals. Each other was killed by its named test, run alone, with one test collected:

- `MELIAN_EVAL_SHOW === "1"` forced true, and its operator flipped, by the new test.
- The condition forced false, and the print's call emptied, by **prints each note a lens recorded under the golden's score when MELIAN_EVAL_SHOW asks, such as a probing lens's attacks**.

The commit changed `goldens.ts`, `live-output.ts` and both test files, which every earlier claim on this branch names. So every claim was rerun at `f458fb2b`, against `26bf134d...f458fb2b`: 39 mutants, none omitted. [The inventory](2026-11-15-issue-457-notes-mutants.json) records each:

- **27 killed**, each again by its named test, run alone, with one test collected.
- **1 equivalent**: `["Stryker was here"]` for the unprobed check's fallback, as before.
- **11 ignored** string literals, which Stryker does not generate.

`node scripts/enumerate-mutants.mjs --sample` accepts the inventory.

# Issue #457: a scripted golden probes in the sandbox unless its caller vouches for the corpus

Builder agent: for [issue #457](https://github.com/melian-agent/melian/issues/457), `runGolden` now takes the choice to run a scripted golden's probes unconfined from its caller, and defaults to the host's sandbox.

## The finding

[Pull request #309](https://github.com/melian-agent/melian/pull/309)'s last Actions round raised `5f48f5cf1b1d3ad2`. `runGolden` gave every scripted run `unconfinedSandbox()`, since the corpus's probes are committed scripts. `loadGoldens` and `runGolden` are exported and take a directory, so a caller who loaded a corpus from anywhere else and ran it scripted would run that corpus's probes outside any sandbox.

The maintainer read the finding on 2026-11-15, in the coordinator's session, and agreed to close it here rather than in #309, as [the coordinator's record](https://github.com/melian-agent/melian/pull/309#issuecomment-6889300676) says.

## The fix

The scripted arm of `GoldenMode` gains `probes?: "unconfined"`. Only that value hands the harness `unconfinedSandbox()`. Without it, a scripted golden probes in the host's sandbox, as a live one always has. The live arm has no such field, so model-written probes can't run unconfined from any type-correct call. `live.ts` needs no change.

The eval tests that run probing goldens pass the field: the corpus loop, the sandbox test, and the claim golden's budget test. The rest run goldens that never probe, so they keep the default.

The head's trust stays fixed at `{ trusted: true, by: "reviewer" }`. `runGolden` runs the lenses alone and no static check, so that trust only lets the head's code run inside whichever sandbox the harness holds. [The evals guideline](../guidelines/evals.md#a-level-that-probes) says so, and names the condition that would end it: a static check in `runGolden`, which runs a trusted head's code unconfined. This is the coordinator's answer of 2026-11-15, not a ruling.

## Test

**probes a scripted golden in the host's sandbox unless its caller says it runs the committed corpus**, in `goldens.test.ts`. It runs the claim golden scripted, with no `probes`, on a host whose sandbox-runtime is unavailable. It expects `GoldenRunError` naming the fallback, and the host's sandbox as the only one asked.

At `cfeda060`, before the fix:

```
× probes a scripted golden in the host's sandbox unless its caller says it runs the committed corpus
AssertionError: promise resolved "{ golden: { …(5) }, …(5) }" instead of rejecting
Tests  1 failed | 143 skipped (144)
```

After the fix, all 378 tests in the evals package pass, 2 skipped.

## Mutants

`node scripts/enumerate-mutants.mjs origin/main...HEAD` at `9b510355` listed 39, with none omitted. This commit's line has 10. [The inventory](2026-11-15-issue-457-probe-trust-mutants.json) records every claim and its run. Each claimed mutant ran against its named test alone, with one test collected:

- **27 killed.**
  - This commit's 7: the condition forced true or false, `&&` as `||`, both equality swaps, the second operand forced true, and the emptied `{ probeSandbox }`. The sandbox test kills those that change which backend a scripted or live run gets. The new test kills those that hand a scripted run without the field the unconfined backend.
  - The branch's earlier 20, all killed again. This commit changed `goldens.ts`, which most of them mutate, and `goldens.test.ts`, where most of their named tests live.
- **3 equivalent.** Forcing `mode.kind === "scripted"` true leaves `mode.probes === "unconfined"` deciding, and only the scripted arm has `probes`. The other two are the `["Stryker was here"]` fallbacks for `ran ?? []`, as [the earlier entry](2026-11-15-issue-457-not-reviewed-goldens.md) says.
- **9 ignored** string literals.

This is trust code: it decides which probes run outside a sandbox.

# Issue #457: the review of record's two findings

Builder agent: the Opus review of record for [pull request #462](https://github.com/melian-agent/melian/pull/462), at `26bf134d...fda13c77`, raised two findings. Both are fixed here.

## R1, P2: a claimed equivalent mutant guards a live call

[The probe-trust inventory](2026-11-15-issue-457-probe-trust-mutants.json) called this mutant at `goldens.ts:412` equivalent: forcing `mode.kind === "scripted"` true. Its reason was that only the scripted arm of `GoldenMode` has `probes`. But TypeScript checks for excess properties only on an object literal written in the call. A live mode built first, as a shared options bag would be, can carry `probes: "unconfined"` and still type-check. Under the mutant, that live run gets `unconfinedSandbox()`, so model-written probes run outside any sandbox, and no test failed.

The code was right; the proof was missing. **probes a live golden in the host's sandbox even when its mode carries the corpus's probes field**, in `goldens.test.ts`, builds such a mode on a host whose sandbox-runtime is unavailable. It expects `GoldenRunError` naming the fallback, and the host's sandbox as the only one asked.

The test passes at `8f4ae9f3`:

```
Tests  1 passed | 144 skipped (145)
```

With the mutant applied, it fails, run alone, with one test collected:

```
Error: promise resolved "{ golden: { …(5) }, findings: [], …(4) }" instead of rejecting
```

The inventory now claims the mutant killed by that test. The probe-trust entry and the pull request no longer say that no type-correct call reaches the unconfined backend. The test commit adds no mutants of its own: `node scripts/enumerate-mutants.mjs fda13c77...8f4ae9f3` lists none.

## R2, P3: the inventories' ignored rows had no claim

`node scripts/enumerate-mutants.mjs --sample` refused both of this pull request's inventories, because their ignored string-literal rows had no `claim`, `evidence` or `survivorClasses`. Those rows now say what the [inventory](2026-11-14-issue-408-mutants.json) for [issue #408](https://github.com/melian-agent/melian/issues/408) says of its own rows: equivalent, "not generated: Stryker ignores this string literal under the repository's configuration", with no survivor class. The sampler accepts both files.

# 2026-10-24: a static survivor's advice reads how the run chose its tests

Codex's adversarial review of [pull request #186](https://github.com/melian-agent/melian/pull/186) found that the new advice blamed Vitest's `related` filter after a whole-suite run. The runner falls back to the whole suite when Vitest's listing fails, relates every test or none, or a related run reports NoCoverage, and the report still carries `static`, `coveredBy` and `testFiles`.

Every fallback reaches Stryker the same way: the runner passes an empty `testFiles` and `vitest.related: false`, and Stryker writes both into its report's `config`. The advice now reads that record. A narrowed run keeps the related-filter advice; a whole-suite run says every test file was a candidate, so the survivor is an assertion gap. Both tests read reports the host's runner wrote for one probe, with and without a changed file no test relates to.

The final round also flagged the advice under the `dynamic-import` guardrail, because the string held the text of a dynamic import. It now says "a literal dynamic import of the module". No other changed source line matches a forbidden pattern; the test files sit outside the rule's `packages/*/src/**` paths.

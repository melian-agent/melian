# Mutation test selection asks Vitest

Supersedes: [the mutation decision](2026-10-08-mutation-testing-as-a-static-check.md), only for dry-run and related-test selection.

This also replaces [literal configuration parsing](2026-10-12-related-tests-require-a-literal-config.md) and [configured-root refusal](2026-10-12-related-tests-refuse-configured-root.md).

Problem: Melian’s configuration parser and import graph disagree with Vitest. A covered mutant then reads as uncovered or surviving.

Example: rounds eight to eleven of [pull request #98](https://github.com/melian-agent/melian/pull/98) each found another disagreement. Spec names, coverage.include, an indirect test object, project includes and CommonJS require edges all exposed gaps. Findings 7ac7b952e059fbbd and b01efd71fb00b423 are the latest examples. Adding another parser case repeats the problem.

Choice: ask Vitest inside the head-code sandbox. Use its listing and related APIs, which implement vitest list --filesOnly --json and vitest related semantics. Leave the head’s Vitest configuration untouched. Query each mutated file, union its test files and pass them to Stryker’s testFiles option. Stryker’s second related filter is disabled. Its shipped vitest.related option only warns when no test relates; it cannot supply the required fallback.

An empty, failed or unreadable query runs the whole suite. A related run that errors, writes no readable report or reports NoCoverage repeats with every candidate test. The repeat discards the subset’s incremental results. Only Stryker’s coverage analysis after that whole-suite run may report an uncovered mutant. Notes record the related or whole-suite path and why it ran. Setup, global setup and project setup remain Vitest’s responsibility; a setup-only dependency that its graph misses selects the whole suite.

Cache partitions advance to version 2. Both incremental and durable run identities include the selection version, rather than a compiler-selected test set. A version-one cache written by the old implementation is reopened in a regression and cannot seed a new run.

What it gives up: one more dependency on Vitest and its runner’s listing and explicit-file behaviour. A run is slower when Vitest relates nothing or a subset needs whole-suite confirmation. Melian no longer predicts configuration or runtime imports itself.

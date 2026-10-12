# Related tests refuse a configured root

Supersedes: [the mutation decision](2026-10-08-mutation-testing-as-a-static-check.md), only for configured test roots.

Problem: Vitest interprets include patterns and setup files relative to its configured root. The compiler selector matches repository-relative paths. A root of app can make a covered source appear to have no tests.

Choice: an explicit root or test directory in the configuration closure selects the whole suite. Shorthand and computed options take the same fallback. Never infer NoCoverage from paths matched against the wrong root.

Cost: these configurations lose the cheaper related-test dry run. Rebasing effective include and setup paths is deferred; the full-suite fallback keeps coverage meanwhile.

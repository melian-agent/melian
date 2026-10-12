# Related tests require a literal configuration

Supersedes: none.

Problem: a shorthand test option hid its include patterns from the parser. A specs/grade.check.ts test reached changed code, but Vitest’s defaults filtered it out. The check reported NoCoverage without running that test.

Choice: accept only an exported inline config object or defineConfig with one inline object argument. Its test option must be an inline object. Include must be an array of literal strings. Only a proven absence uses Vitest’s defaults. Follow explicit default re-exports through the configuration closure.

Shorthand test, indirect values, spreads, computed keys, merged and function configs select the whole suite. This includes spreads inside config arrays. Unrelated objects cannot establish the exported configuration’s options. This preserves coverage at the cost of a larger dry run.

[Pull request #98](https://github.com/melian-agent/melian/pull/98) adds parser and compiler-child regressions for this fallback.

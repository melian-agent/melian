# 2026-10-21: vite 8.3.4 for the launch-editor advisories

`npm audit --audit-level=high`, part of `npm run check`, began failing on main: vite 8.3.1 depends on launch-editor, which has high-severity advisories (Windows argument escaping and editor CLI flag misinterpretation). It failed the merge-group run for pull request #155, whose own code passed.

Vite 8.3.4, published on 2026-10-08 and so outside the two-day release-age window, no longer pulls in launch-editor. The lockfile moves vite to 8.3.4, nanoid to 3.3.20 and postcss to 8.5.31, and tightens the source-map-js and rolldown ranges, which the installed 1.2.2 and 1.2.12 already satisfy. The audit now reports only the two moderate qs advisories, below the gate's threshold. `scripts/check-release-age.mjs` passes. The whole gate passed apart from four tests that timed out at load average 30; all four files pass alone, 505 tests.

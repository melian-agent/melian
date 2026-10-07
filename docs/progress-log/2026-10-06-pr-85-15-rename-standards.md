# Guard standards on both sides of a rename

[Pull request #85](https://github.com/melian-agent/melian/pull/85), eighth-round finding b40ddc9230a08cfe.

The rename regression checked only the lens selected through the destination path. Replacing covers with files in standardsFiles still passed it. A lens selected through the old path then lost the destination's standards.

The regression now runs for each selection path. Each case checks both packages' conventions, the old package's import, root conventions and the lens's recorded standards paths. The same mutation fails the old-path case; the head-path case still passes. Restoring the source passes all eighteen standards tests.

The requested coverage command cannot start because @vitest/coverage-v8 is absent. No package was installed. Coverage measurement and the uncovered-line sweep are skipped. Production behaviour and design decisions stay unchanged.

# Read standards imports with literal filenames

[Pull request #85](https://github.com/melian-agent/melian/pull/85), eleventh round, finding 21d7dc8c3bafe193. Both sources aborted on an import named :(glob)rules.md. Git interpreted the filename as unsupported pathspec magic.

Both ignore checks now prefix repository-relative paths with ./. Tests cover present, missing and force-added ignored imports from both sources. All six fail on the original code.

The finding proposed --literal-pathspecs. Git check-ignore rejects that flag's literal magic too. The ./ prefix keeps the colon in the filename and preserves ignore matching. The core guideline records this constraint. No design decision changes.

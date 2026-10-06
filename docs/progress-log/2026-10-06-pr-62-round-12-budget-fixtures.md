The twelfth review of [pull request #62](https://github.com/melian-agent/melian/pull/62) found the test helper `budgeted(lens, ...)` taking a lens as its first parameter. No runtime caller needs a budget override method.

The three regression fixtures now construct their overridden lens inline through `Lens.from`, retaining all other level settings. The tests still cover refutation at a full findings budget, escalation after a tools budget ends, and a tools budget capped at quick.

# The design lens may report sixteen findings in a round

The maintainer agreed on 2026-11-15, in the coordinator's session, to raise the design lens's findings budget in this repository from 8 to 16.

A lens that reaches its findings budget is cut, and a cut lens leaves the round not reviewed. On [pull request #436](https://github.com/melian-agent/melian/pull/436), which defines the keys that decide what Melian reuses, the design lens had nine findings left after every defect was fixed. Each was a limit the pull request's own decision states. A pull request's own text cannot excuse a departure the lens finds, so each returns every round as a finding for the maintainer to read. At a budget of 8 the lens was cut before it finished, so no round on that pull request could be reviewed. A round with the budget raised to 24 in the round's worktree came back uncut with ten.

[Pull request #351](https://github.com/melian-agent/melian/pull/351) raised the conventions lens to 16 for the same reason on 2026-11-09. A pull request's round reads its lens files from the base, so the budget has to change on `main` before a round can use it.

`.melian/lenses/design/LENS.md` sets the budget, and `packages/core/test/lens.test.ts` pins the design lens's version and budget, so both change here. The token and tool budgets are unchanged.

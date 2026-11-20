# Pull request 613: the misses export's round findings

Builder agent, 2026-11-20. The `melian round` run [44735928409](https://github.com/melian-agent/melian/actions/runs/44735928409) on [pull request #613](https://github.com/melian-agent/melian/pull/613) raised three acknowledge findings, each fixed in its own commit.

- The placement bound in `packages/cli/src/compare.ts` had no test at a file's last line. A new test exports a miss on line 3 of a three-line file and names one on line 4, with and without a closing newline. Changing `last <= lines.length` to `last < lines.length` fails it.
- `PullRequestComparison.misses` had no test. One CLI test writes a pull request's valid miss through `melian compare misses "#7"`, and a unit test checks that the additional-records notice comes back only when an export would print it. Emptying the method's body, returning `{}`, forcing its condition either way and dropping the notice each fail one of the two.
- Added owned rounds now follow mint order, which [the mint-order amendment](../decisions/2026-11-20-added-owned-rounds-follow-mint-order.md) records. The r9 and r10 test fails when the rounds are sorted by ID as text.

The next round, [44743840640](https://github.com/melian-agent/melian/actions/runs/44743840640), raised three more acknowledge findings. The coordinator chose the approach for each; none is a ruling.

- A long file's read can cut the line a miss names. A new test places a miss on the line the cut falls on and checks that the export skips and names it, as it does a line past the file's end.
- One defect reported at several sites wrote one miss per report. The export now writes one miss per group, the first valid report in site order. A test of two reports matched as one defect fails when the group's other reports are kept.
- The export wrote only `needs-execution` misses, which suits the probing measurement and no other. `compare misses` now takes `--reason` once for each reason to write, `needs-execution` by default, and refuses `out-of-scope` and any unknown word. The test of the default, one reason, two reasons and both refusals failed before the option existed, writing both misses for the default.

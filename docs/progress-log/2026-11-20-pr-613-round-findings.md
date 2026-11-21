# Pull request 613: the misses export's round findings

Builder agent, 2026-11-20. The `melian round` run [44735928409](https://github.com/melian-agent/melian/actions/runs/44735928409) on [pull request #613](https://github.com/melian-agent/melian/pull/613) raised three acknowledge findings, each fixed in its own commit.

- The placement bound in `packages/cli/src/compare.ts` had no test at a file's last line. A new test exports a miss on line 3 of a three-line file and names one on line 4, with and without a closing newline. Changing `last <= lines.length` to `last < lines.length` fails it.
- `PullRequestComparison.misses` had no test. One CLI test writes a pull request's valid miss through `melian compare misses "#7"`, and a unit test checks that the additional-records notice comes back only when an export would print it. Emptying the method's body, returning `{}`, forcing its condition either way and dropping the notice each fail one of the two.
- Added owned rounds now follow mint order, which [the mint-order amendment](../decisions/2026-11-20-added-owned-rounds-follow-mint-order.md) records. The r9 and r10 test fails when the rounds are sorted by ID as text.

The next round, [44743840640](https://github.com/melian-agent/melian/actions/runs/44743840640), raised three more acknowledge findings. The coordinator chose the approach for each; none is a ruling.

- A long file's read can cut the line a miss names. A new test places a miss on the line the cut falls on and checks that the export skips and names it, as it does a line past the file's end.
- One defect reported at several sites wrote one miss per report. The export now writes one miss per group, the first valid report in site order. A test of two reports matched as one defect fails when the group's other reports are kept.
- The export wrote only `needs-execution` misses, which suits the probing measurement and no other. `compare misses` now takes `--reason` once for each reason to write, `needs-execution` by default, and refuses `out-of-scope` and any unknown word. The test of the default, one reason, two reasons and both refusals failed before the option existed, writing both misses for the default.

The round after, [44754074831](https://github.com/melian-agent/melian/actions/runs/44754074831), raised one blocking finding and three acknowledge findings. Again the coordinator chose each approach, and none is a ruling.

- The export let a later round's miss replace an earlier round's whenever the two shared a finding ID. A file reviewer's ID hashes its path and `ref`, so a reused `ref: A1` for another defect in round two dropped round one's miss. Now only a GitHub review thread, whose ID names the thread itself, replaces its earlier miss. A file miss stays with its round and is named by the round when two share an ID. The help text, [the CLI guideline](../guidelines/cli.md) and [the identity guideline](../guidelines/identity.md) state the costs: a withdrawn file miss stays, and a repeated one appears once per round. The test of a reused `ref` and the test of a group of two threads followed by one alone both failed on the old export, which kept one miss each.
- A group's miss was its first report that held the reason asked for, so a group whose first report was `owned-missed` and second `needs-execution` wrote a `needs-execution` miss on the second report's lines. The export now takes the group's first valid report and then filters by reason, as `stats` files the group.
- The export printed the left-out misses and the extra-records notice before it wrote the file, so a failed write still printed them. Both now print only after the write succeeds.
- One CLI test now exports a placeable miss beside misses on a deleted file, a symbolic link and a binary file, and checks that only the placeable one is written and each other is named.

# An account main wrote before it named its resolution policy

`recorded.json` holds the records one range review exported, written by main at `4d08b08c` with fake models. Its account is version 1 and names no resolution policy. No record was assembled by hand.

Its verdict does not matter here: the test asks only how today's reader treats the account.

To reproduce, extract `git archive 4d08b08c` to an isolated source directory, install that tree's locked dependencies, and copy `capture.mjs` to its root. Run Node 24 with `--conditions=@melian-agent/source`, followed by the script path, an absolute output directory and the commit.

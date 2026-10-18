# Step 23a: confine round flags to findings

The shared parser in [pull request 152](https://github.com/melian-agent/melian/pull/152) accepted round flags for commands that did not implement them. A real command on `8295107e` ignored `compare --round r1` after `r2` existed and wrote the current comparison. Comparison round writes belong to the next build.

Three regression cases failed at expected exit 64, received 0, for `--round`, `--rounds` and `--no-rounds`. The command guard now rejects them outside `findings` before anything runs. Keeping the boolean undefined when absent distinguishes it from an explicit false value.

All 31 CLI round tests and type checking pass. Tests prove no comparison was written, ordinary comparisons still work, and `findings --no-rounds` keeps its normal output. A native Node probe now exits 64 before the write. The five guard mutations fail their selected tests, bringing the inventory to 74 distinct mutations killed in 80 runs.

No original test assertion or input changes. Stored versions, the plan and comparison records stay unchanged. The local report records this head’s whole gate and CI; the preceding CLI handoff fix passed CI on Node 22, 24 and 26.

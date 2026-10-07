# Prove artifact revision and validation rules

[Pull request #89](https://github.com/melian-agent/melian/pull/89) now tests renamed base reads with different paths, hunk starts and widths. Boundary reads distinguish the last hunk line from the next line.

The tests reject invalid identities, nested fields, positions, ranges and empty test-coverage reasons. All 32 artifact rows have failing mutations. The three restored tests pass.

Mutation trials must use suites that do not invoke another file under mutation. An overlapping pipeline suite produced failures in graph validation, unrelated to the artifact mutation. Those results were discarded. The final artifact trials use the core suite alone.

Inverting a minimum bound proves it where removing it is equivalent to a later consistency check. A trial that writes the same bound is not a mutation and supplies no proof.

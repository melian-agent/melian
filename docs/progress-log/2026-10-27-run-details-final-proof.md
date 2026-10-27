# Run details: final mutation proof

[Pull request #221](https://github.com/melian-agent/melian/pull/221), fix pass 3 on [issue #213](https://github.com/melian-agent/melian/issues/213#issuecomment-6431755745).

The [complete inventory](2026-10-27-run-details-final-mutants.json) enumerates `5ed29934...b404d7d3`: 124 mutants, none omitted. Every mutant ran by hand against the source at `b404d7d3`, including those the earlier pass had already tested. The result is 118 killed and six equivalent, with each equivalent also run and explained. There are no unresolved survivors or timeouts. Identity fields, end coordinates, policy status, claims, survivor classes, commands, named failing tests and output excerpts are retained. The scratch mutation runner and the starting-head reproduction runner are embedded in the inventory.

Mutation probes strengthened two contracts: an absent round ID stays absent from the raw JSON shape, and the durable publish input carries only its own round's run. The adjudication ownership test now points to another real, completed task, so rejection depends on ownership alone. Those three test files pass all 62 tests after the probes. The earlier full targeted run passed 488 tests in 15 files; source has not changed since that run. TypeScript and Biome pass.

The earlier 52-mutant inventory is reformatted as one JSON row per mutant. Its identities and evidence are unchanged. The compact form retains the complete proof.

Source commits: `61851eb9` for missing verifier usage, `e0befe8e` for lens identity, and `b404d7d3` for round binding. `d37e37e8` records the first mutation proof; `4eada1d5` updates the escalation assertion. This commit records the final proof and its stronger assertions. Mutants affected by those assertions were rerun after the assertions changed.

The host still needs to run the full pipeline and CLI suites and `npm run check`. The sandbox ran only targeted test files.

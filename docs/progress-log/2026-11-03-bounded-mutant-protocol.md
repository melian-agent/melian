# Mutation enumeration retains only requested rows

For [pull request #250](https://github.com/melian-agent/melian/pull/250) and [issue #239](https://github.com/melian-agent/melian/issues/239),
the worker now returns requested rows and the true count, within independent source, payload, response, heap and deadline bounds.
The [decision amendment](../decisions/2026-11-03-bounded-mutant-protocol.md) records the adapter contract and refusal limits.

The real dense fixture first failed count-only enumeration on stdout overflow. It now counts 139 mutants with exactly zero rows.
Boundary tests isolate retained bytes from payload bytes, exercise UTF8 and invalid-byte expansion, and validate malformed batches and exit classifications.
The suggested two-operand DEL fixture printed about 36 MiB here. A third operand retains another large replacement and exceeds the old compatibility buffer.
The regression uses that observed case and preserves terminal escaping.

A native transport probe found that empty individual stdio entries lose stderr from Node 24.18.0's synchronous failure result.
Successful JSON parity alone missed this difference. The existing real stderr regression kills those mutations; the CLI guideline records the trap.

Append-only evidence, exact failing/passing counts, mutation inventories and supplemental worker-template probes live under `tmp/pr250-approved-phase-b/`.
The complete protocol inventory contains 341 rows, omitted zero: 333 fail named tests and eight have proved equivalence reasons.
Sixteen separate worker and boundary reversals fail named tests. They have no invented generated IDs.
The focused six-suite run passes 1,078 tests, with one existing sandbox-dependent repository-creation test left for the host.
Biome and repository type checking pass after correcting an unused test parameter.
The static runner remains unchanged; its coordinate-path limitation stays as recorded in the preceding selection amendment.
The coordinator's whole host gate, final exact-head CI, external reviews and comparison record remain pending.

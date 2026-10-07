# Prove the measurement spike

[Pull request #89](https://github.com/melian-agent/melian/pull/89) now tests the spike with a local executable archive and injected downloads. No real analyser or provider runs.

The fixture checks measurements, resident memory, query reuse, mismatched and missing cache identities, unreadable cached answers, missing answer status, bounded diagnostics and missing command arguments. All 21 inventoried mutations fail tests. The restored suite passes both tests.

Repeated compiler and analyser starts need an explicit test timeout. The initial five-second timeout passed alone with the larger limit. Mutation timeouts and module-load failures supply no proof.

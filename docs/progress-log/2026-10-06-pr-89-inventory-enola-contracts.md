# Prove Enola graph contracts

[Pull request #89](https://github.com/melian-agent/melian/pull/89) now tests explicit import indexes, file nodes, symbol declarations, calls without relations, importing locations and dependent node kinds.

The tests also check empty upstream reports, invalid positions and bounded typed error diagnostics. All 28 inventoried rows have failing mutations. The restored five-test suite passes.

Inverted validators that failed while a suite loaded supplied no proof. Removing those validators instead fails assertions in the direct contract tests.

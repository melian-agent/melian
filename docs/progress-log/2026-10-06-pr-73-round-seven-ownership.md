# Ledger discovery checks the review author

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round seven, item 1: confirmed by tracing the candidate scan. An older comment edited to hold a copied signed body won without a known login.

Publication now supplies its recorded review ID. Discovery reads that review's author when needed and requires the ledger author to match. Without an author source it creates a fresh ledger. The decision records the orphan recovery limit.

Validation: the ledger and publication crash suites pass, 48 tests. Regressions cover an edited older copy, recovery through a recorded review, and absence of every author source.

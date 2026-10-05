# Revalidate the target before the ledger write

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round ten, item 2: confirmed as missing coverage. Publication already revalidates before writing the ledger.

The fake moves the pull request's head after accepting the review. The regression checks that no ledger is discovered, written or recorded. Both the thrown error and durable task outcome name the moved head.

Validation: the ledger suite passes. Removing only the revalidation before the ledger write makes the regression fail; the guard is restored.

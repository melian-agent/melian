# Keep setup modules out of the mutation test include list

Codex's review of record for [pull request #98](https://github.com/melian-agent/melian/pull/98) found that related-test selection collected setup modules as test suites. MutationTests now validates setup paths while leaving their execution to Vitest's test.setupFiles.

A gate regression copies the Stryker Vitest configuration into a temporary project with one related test and a setup-only module. Real Vitest passes and the test asserts that setup ran. Restoring setup paths to include fails with "No test suite found in file". The repository's own configuration declares no setupFiles, so its previous run never collected a setup module. The full gate is deferred to the end of this pass.

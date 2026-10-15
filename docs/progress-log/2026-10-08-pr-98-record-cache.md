# Partition mutation results by the installation

Codex's review of record for [pull request #98](https://github.com/melian-agent/melian/pull/98) found that checkout dependencies could change while an identical head reused killed mutants. The cache now includes the checkout lockfile digest and resolved Stryker core, Vitest runner and Vitest versions.

The cache tests start cold after a lockfile change and after each version change. A fake Stryker integration test confirms that the run supplies this identity. Removing the lockfile digest fails the cold-start test. Removing the version type guard fails the malformed-version test. No signal code was mutated. The full gate is deferred to the end of this pass.

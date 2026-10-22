# Builders enumerate Stryker mutants before claiming coverage

Amends: [Tested means a failing mutation](2026-10-07-tested-means-a-failing-mutation.md), builder inventory procedure

Problem: builders choose mutations they expect their tests to kill. Stryker tries operators they did not choose. Five recent pull requests reported complete hand inventories yet left 67 survivors, including 46 test gaps.

Choice: use `scripts/enumerate-mutants.mjs` to enumerate the installed Stryker instrumenter's mutants on committed changed production lines. Share the host check's path exclusions and changed-line authority. Include JavaScript for repository scripts without changing the host check's TypeScript scope. Limit output to 200 rows by default, report omissions, and support JSON. Instrument in an empty scratch directory; never load head modules, Babel configuration or test runners. No process listing is needed.

Classify every mutant as killed by a named existing test, needing a new test, or equivalent with a one-line reason. Run every new-test mutant and equivalence claim by hand. Sample at least one in five existing-kill claims. Record results as work proceeds and increase the output limit until none are omitted. The host's `static.mutation` remains the authority; this script generates mutants and proves no kills.

# Integrate main into the pull request membership branch

For [pull request #256](https://github.com/melian-agent/melian/pull/256), the coordinator merged main into the branch without committing. The merge joins two parents:

- Original head: `66236a1804e4135c112b6d1d6cca7c9e58013042`.
- Main: `dfcf230599de895553ca7e2a8288494ea02dae9f`, which carries the source mutation capability from [pull request #250](https://github.com/melian-agent/melian/pull/250).

Three files conflicted. Each kept both sides; neither feature replaced the other.

- `packages/cli/src/main.ts`: the imports of `listMutants` and `sampleMutants` from `./mutants.ts`, and of `PullRequestComparison` from `./pull-request-comparison.ts`. They sit in module-path order.
- `packages/core/src/index.ts`: main’s whole export block from `./mutation-inventory.ts`, then the branch’s whole export block from `./pull-request-rounds.ts`. Each stays with its own module, in module-path order.
- `docs/guidelines/cli.md`: the membership and export paragraph, then main’s complete final-error-handler and compatibility-output paragraph, once each. The branch’s shorter error-handler sentences are already inside main’s longer paragraph. The offline-ownership paragraph after them is unchanged.

No function body, test, dependency version, guard, selection rule or design decision changed. This pass did not touch `docs/design-implementation-plan.md` or `packages/evals/comparisons/`. It wrote no synthetic zero-mutant inventory, made no new mutation claim and relabelled no historical receipt.

This pass ran no test, mutation or provider probe, and reran no original feature’s proof. It edited files and searched for leftover conflict markers.

The coordinator verified that both code files equal Git's automatic merge plus the ordered union of the conflicted imports and exports. Every other byte is unchanged.

The whole host `npm run check` passed on the resolved staged merge: 7,147 tests passed and two skipped across 220 files. It included Biome, type checking and dependency checks, using Node 24.18.0 and npm 11.19.0. Only this validation result was added afterwards. Three fresh reviews remain pending on the combined head.

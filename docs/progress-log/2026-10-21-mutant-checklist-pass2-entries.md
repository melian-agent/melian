# Mutation selectors reject symlinks and submodules

[Pull request #165](https://github.com/melian-agent/melian/pull/165), pass 2, Codex finding 2.

Both selectors use `Revision`’s `newKind` to accept regular and executable files. Rejected entries appear as unmutated with their kind. Static mutation retains the reason when every changed source entry is rejected.

Before the fix, the script’s symlink test failed while parsing the committed link target. The static selector’s test failed because Stryker’s actual argument included the symlink. Both pass after the fix. Tests also cover submodules, executable regular files and symlink-only skips. Configuration-only skips now carry their unmutated log; the two existing exact assertions include that deliberate addition.

The pass report records the failing and passing output, the enumerated inventory and hand probes. The host’s mutation check remains the authority.

The final targeted run passes 31 tests. The final inventory lists 55 mutants with none omitted. Every retained replacement fails a named test. Probes exposed a redundant log guard, which was removed, and a default-array test gap, which the direct render fixtures now cover. Two conditional mutants share a start position; the rechecks distinguish their end positions.

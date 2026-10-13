# Mutation check: round eleven, fix pass A

[Pull request #98](https://github.com/melian-agent/melian/pull/98) fixes the round’s items outside test selection.

- `6052f512` fixes criterion-selection-bias `8458dc520eee0559`, merged with weakened-assertion `ae58da2baab456bb`. Triage version fingerprints must match every earlier record reachable from HEAD. Unreadable or incomplete history fails closed. The scratch repository retains reachable history without remote refs.
- `3afbbea2` fixes secret-exposure `52b701b7e7728a49`. Both sandbox backends grant the Node executable and two optional owned directories, never the prefix. Home, its ancestors and shared prefixes are excluded. A confined runtime startup failure records a skip. Linux no longer binds all /usr.
- `9a0feff4` fixes the Stryker initial-run helper failure. The supervisor imports MutationStderr by its module URL. The fake VM uses the imported class, so Stryker’s helpers stay in their module.

Mutation proofs cover the changed history guards, every excluded runtime prefix, directory ownership, runtime startup and profile balance. Restoring either prefix grant fails the policy tests. An extra closing parenthesis fails without a sandbox. A missing stderr module URL fails the fresh-Node import test.

The instrumenter API produced ten stderr mutants and the helper stryMutAct_9fa48. Serialising that class reproduced the reported ReferenceError. All 54 stderr and fake supervisor tests passed against the instrumented module. No signal-sending code was instrumented or mutated.

Validation: the full gate passed on its first run: 126 files passed, 3 skipped; 4,034 tests passed, 63 skipped. The coordinator must run the host sandbox and process-table proofs, including the new home-shaped prefix probe, and confirm the next real Stryker round. Compiler graph and test selection files are unchanged. No comparison record was edited.

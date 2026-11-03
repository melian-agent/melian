# Prove the default enumeration limit at both boundaries

For [pull request #250](https://github.com/melian-agent/melian/pull/250), close a test gap in `MutationEnumeration.list()`.
The healthy default is 200. This pass changes no production code and reproduces no healthy-head functional failure.
The native review independently found that replacing 200 with 199 survived the old tests.

At starting commit `3379f0fc80860849fc281c2b230cb9c0c888e5af`, this pass applied only that replacement before adding tests.
The existing enumeration suite passed 162 tests with one exact sandbox exclusion, exit 0.
An unexcluded run passed those 162 tests and failed only the unchanged sandbox case:
`rejects a fallback entry inside a reviewed tree even when its manifest is outside it`.
Git initialisation beneath `node_modules` was denied with `Operation not permitted`.
The exclusion uses `-t '^(?!.*rejects a fallback entry inside a reviewed tree even when its manifest is outside it)'`.

Two new cases commit 200 and 201 distinct boolean declarations in isolated Git repositories and run real Stryker.
Each full inventory must contain exactly that many generated `BooleanLiteral` rows.
Default listing must retain exactly 200 rows and match the full inventory's first 200 complete rows and metadata.
The cases require zero and one omitted row respectively.
The existing `counts all dense real mutants without serialising rows at limit zero` test already proves explicit zero and one limits.

With default 199, both new cases fail with `expected [ …(199) ] to have a length of 200 but got 199`, exit 1.
With healthy 200, both pass, exit 0.
A supplemental default-201 probe fails the 201-mutant case with `expected [ …(201) ] to have a length of 200 but got 201`.
Its 200-mutant control passes; the combined probe exits 1.
These replacements are supplemental probes, not enumerated fix-delta mutant IDs.
The scratch runner restores the exact source bytes in `finally` and checks SHA-256 after every run.
The healthy source hash is `b2c9767c3860ec814381ccade69f92697c2e367450d20c24a4014460028503ea`.

After restoration, the focused enumeration suite passes 164 tests with the same one-case exclusion, exit 0.
Repository lint and type checking pass on Node 24.18.0; lint reports five existing informational notices.
The complete fix-only candidate inventory contains zero production rows, total zero and omitted zero.
Committed enumeration matches that inventory, and every production source hash matches the starting commit.
Commands, actual logs, exits, assertion checks, inventories, source hashes and the scratch runner live under `tmp/pr250-default-limit-fix/`.
The whole host gate remains pending with the coordinator; this pass ran no reviews or whole host gate.

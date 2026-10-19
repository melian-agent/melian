# Thinking routes: select live entry mutation tests

[Pull request #157](https://github.com/melian-agent/melian/pull/157) keeps the live entry tests on Vitest's related selection.
`vi.importActual` executes the entry inside each test, but Vitest's dependency scan found no related test for `live.ts`.
A static import, mocked to prevent startup during collection, supplies the dependency edge.
Each test still bypasses that mock to execute the real entry with fake collaborators.

Vitest's `getRelevantTestSpecifications` returned no files before the change and `live-entry.test.ts` afterwards.
Both tests pass, and all five exact live entry mutations still fail.
The static edge prevents these direct tests from disappearing from the mutation runner's related pass.

No production behaviour changes. The implementation plan's status stays unchanged.

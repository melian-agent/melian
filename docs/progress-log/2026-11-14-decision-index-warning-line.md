# The decision index's warning line moves from 48 KiB to 56 KiB

The design lens and the verifier read an index of every active decision. Past 64 KiB, `decisionIndexLimits.bytes`, the index is not built and every review that needs it is refused. A test in `packages/decisions/test/decision-files.test.ts` warns earlier: it fails when this repository's own index passes a line, which was 48 KiB.

On 2026-11-14 the index on `main` was 49,034 bytes, 118 under that line, so the next decision file failed the gate of whichever pull request carried it. [Pull request #296](https://github.com/melian-agent/melian/pull/296), the probing lens level, hit it with four decisions.

The warning did its job, and the fix it asks for is not a one-line change: [issue #411](https://github.com/melian-agent/melian/issues/411) holds it. This moves the line to 56 KiB so pull requests that add a decision can land meanwhile. The 64 KiB refusal is unchanged.

The repository added 61 decisions in the first 14 days of November, about 155 bytes of index each. At that rate the index reaches the new line in about a week and a half, and the refusal in about three and a half weeks. Issue #411 has to land before the first.

# Mutation selection follows Vitest

[Pull request #98](https://github.com/melian-agent/melian/pull/98), fix pass B.

[cfd76159](https://github.com/melian-agent/melian/commit/cfd7615946dec432cb02741697dbe0c94087396f) replaces the compiler selector with Vitest’s own listing and related APIs inside the sandbox. It deletes configuration parsing, reverse-import selection, include overrides and synthetic NoCoverage enumeration. Compiler ground truth and enclosing-function extraction keep their existing callers.

Stryker 10’s related option only warns when it finds no test. Melian instead asks Vitest for each mutated file and passes its answers as explicit testFiles. The head’s Vitest configuration stays intact. Empty or failed queries use the whole suite. A failed or unreadable related run, or one reporting NoCoverage, repeats with every candidate test and a fresh incremental file. Notes record both paths. Only Stryker’s whole-suite coverage analysis may report an uncovered mutant.

Cache partitions advance to version 2. The installation identity includes the selection version, so durable run keys change too. A fixture written by the previous cache implementation proves that reopening cannot reuse its results. Vitest resolves from its installed manifest, avoiding a head package’s self-reference.

Thirty source mutations fail their tests. Twelve real Vitest fixtures cover spec names, custom includes, coverage includes, indirect configuration, project includes, CommonJS require, merged and function configuration, setup, global setup and project setup. Each runs its killing test, then fails when the fixture’s source comparison changes from >= to >. A mixed direct/setup change proves that one related file cannot hide an empty answer for another.

The first gate exposed two fake installs without Vitest and an unstaged deletion still listed by the guardrail test. Four tests shared a roughly five-minute pause. After fixing the installs and staging the changes, the whole gate passed: 126 files, 3,945 tests passed and 63 skipped. The two moderate audit advisories remain below the gate’s threshold.

The coordinator must run the skipped real seatbelt and process-table proofs, the whole host gate and the branch’s own mutation round. No sandbox profile or signal-sending code changed. The implementation plan and comparison records remain unchanged.

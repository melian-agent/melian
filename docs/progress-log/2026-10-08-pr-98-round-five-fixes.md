# [Pull request #98](https://github.com/melian-agent/melian/pull/98): round five fixes

Round five ran on a5622394. This pass started from b401dc36.

- e6569a13 closes the durability blocker. Takeover drops the retired task index in the ownership commit. A throw before task creation, then retry, creates a fresh task and restores the cleared survivor.
- c3e9eba2 closes the installation identity blocker. Durable run identity and incremental cache partition share mutationInstallation. Lockfile, Stryker core, Vitest runner and Vitest changes create fresh same-head runs.
- 0763ac4a closes the missing hook assertion on the actual execute method, through Run.shell with fakes. It also adds the real supervisor launch test with a harmless command. That real test remains unverified here because the outer task sandbox denies ps.
- b13ddb29 closes the standards injection finding. Lenses keep their usual severity; the maintainer applies the advisory convention during adjudication. AGENTS.md, the decision and design use identical wording.
- dd7f99b9 closes the forged-kill guardrail self-matches. Fixture identifiers and property names are built apart. The source scan finds no match; all 72 guardrail and writer-trust tests pass.
- 280db27f closes the prose advisories. Progress headings link the pull request and the flagged sentences are split.
- 7caa2876 closes the internal API documentation advisory. MutationTests, MutationCache and MutationTree and their members carry no TSDoc.
- 8be0da25 closes the storage advisory. Single-session authority tests use memory; reopen tests retain SQLite. All 23 pass.
- 8c108baa corrects an accidental edit to an existing supervisor fake in the hook test change. The full process suite then passes all 41 tests.
- 1c0ae46d closes the report complexity advisory. Validation, collection, ignored output and notes are named steps. The mutation inventory exposed an untested unmutated input; the binary/bounded result test now covers the normaliser too.

Enola 0.4.27 measured normaliseMutationReport at cyclomatic 47 and estimated O(n³) before extraction, and 11 with scaling-loop depth 1 afterwards. The largest extracted step, collectMutants, is 22 and estimated O(n²). This is a structural change; the algorithm’s cost is unchanged. CompilerGraph.read remains 57 and estimated O(n³). Its project, file and AST traversal offers no cheap repeated lookup to replace.

The dry-run failure in item 4 remains unresolved. The outer task sandbox denies nested sandbox-exec, so this pass cannot reproduce the check’s seatbelt run. The generated related-test include list selects 56 files, including the CLI test. The CLI suite passes all 62 tests with that configuration and the check’s stripped environment. This rules out the dropped-variable hypothesis in that reproduction, but does not prove the profile works.

tmp/fix98-r5-dry-run-repro.mjs reproduces the isolated clean CLI test on an unrestricted host, using the real profile, related-test selection, generated Vitest configuration and in-place Stryker dry run. It runs no mutants. The original seatbelt failure’s cause still needs that run or its retained log.

Every changed guard and branch has a failing mutation in tmp/fix98-r5-report.md. Signal code was not mutated. The live 1,250-line budget measurement and the re-parenting window within one 100 ms tick remain deferred.

Validation: the full gate passed on the first run: 118 test files and 3,221 tests passed, with 60 tests skipped. The log is tmp/fix98-r5-check.log. No timeout retry was needed.

# Issue 561: the Actions round's four code findings on 9381896c

Round 44638448079 on PR #582's head 9381896c raised four code findings above advisory. The coordinator directed one pass for all four. Each fix started from a test that failed on 9381896c for the reported reason.

The parity arm gave every configured lens without a route a route of high thinking alone. Core reads a lens route in place of its tier's, so such a lens had no model, and the arm could not start on this repository's policy. A lens with no route now keeps its tier's route, which carries the high thinking. The new `ParityArm` test failed with a received `route: { thinking: "high" }` and passes now. Under main's policy at 16c0d89c, every lens of the `full` tier resolves to a model in both arms.

A resume did not check the host its probes ran on, so a run's two arms could probe under different Nodes or sandbox releases. The results file, now version 2, records the pipeline's `probingHost`, and a resume on another host is refused. A version-1 file, or one of another arm, is refused as not this measurement's. The new resume test failed with a received version 1 and no host. It passes now and changes each host field in turn.

The probe trust gate resolved a miss's base, head and policy with a git that inherited `GIT_DIR` and `GIT_WORK_TREE`. So a shell could make trust vouch for another repository's commits. Those reads now run in core's git environment, which removes the repository-local variables; core exports it for the purpose. The new `Miss` test points both variables at a second repository with its own `feature` branch. On 9381896c the head resolved to that repository's commit; it now resolves in the miss's own.

No test showed `runRange` handing `reviewChangeset` the callers Enola's graph opened. `packages/evals/test/graph-callers.test.ts` now does, with the pipeline module spied, and fails when the callers are dropped.

Mutants: the enumerator listed 16 over the fix commits. One string literal is ignored by configuration. The other 15, and three hand-written deletions the enumerator does not list, were each run by hand against their named test, and all 18 were killed. The deletions dropped the host from a new results file, the git environment and the callers spread.

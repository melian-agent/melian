The twelfth review of [pull request #62](https://github.com/melian-agent/melian/pull/62) confirmed that the replaced-decision crash test reopened with `counting` while the stored key named `parked`. The decision task's mismatch guard aborted it before calling the decider, so the test could pass without the replacement sweep.

The test now reopens with `parked` and checks that the stored key names it. It asserts that the old task ends aborted without calling the decider, and that the replacement entry remains unanswered, without a failure.

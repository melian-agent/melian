# Step 26 pass 4: retire an amendment’s authority with its source

[Pull request #150](https://github.com/melian-agent/melian/pull/150).

Codex’s adversarial review found that superseding an amendment left its policy authoritative. B amended A; C superseded B; the index still told the lens to let B win. New unit and fake-model prompt tests reproduced that failure before the fix. Tests of inactive amendment targets also failed because the graph accepted them.

DecisionFiles now rejects amendments of inactive targets and names their reachable active Supersedes successors to amend instead. It then removes retired sources from effective amendments. Two active amendments of one target still stand. The existing Supersedes precedence for a source declaring both edge kinds to one target is unchanged. The branch-owned decision, design and guidelines state these rules.

Eleven hand mutations failed against the amendment tests. They cover target validation, successor traversal and its leaf fallback, both active predicates, and both empty/non-empty map updates. Source was restored after every run. The report and inventory are under `tmp/step26-pass4-*`.

The decisions package and affected pipeline suites passed all 706 tests. The whole gate reached Vitest and ended with 4,937 passed, 53 skipped and four sandbox failures. Three reported `ps failed: undefined`; the supervisor test’s ps-dependent assertion received `toolFailed` instead of `invalidOutput`. A whole-gate repeat was started. The host must rerun the whole gate outside the Codex seatbelt. No live model calls ran. No stored shape or version changed. This fix leaves the implementation plan and comparison records alone.

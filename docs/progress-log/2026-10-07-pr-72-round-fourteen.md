# [Pull request #72](https://github.com/melian-agent/melian/pull/72), round fourteen

- The GitHub importer added the requested login as a reviewer when it found no thread and no review by that login, so a bot that never ran on the pull request scored recall 0 for every valid defect. It now records a reviewer only when the login wrote a thread or a review. A new test fails with the old fallback; the [decision](../decisions/2026-10-07-silent-reviewer-needs-a-trace.md) narrows the empty-import rule of the earlier comparison decision.

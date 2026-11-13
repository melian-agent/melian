[Pull request #310](https://github.com/melian-agent/melian/pull/310), fixes for Codex's adversarial review of d449ec6. Each began with a test that failed on d449ec6 for the reported reason.

- A second process in the same clone took over the first's live lease, since both share the clone's holder, and could open one JSONL store at once. A checkout now takes `<id>.running` exclusively and touches it every 30 seconds; a lock touched under two minutes ago refuses with `CopyInUse`, and `StateCheckout.close()` releases it.
- The branch reader read a missing or wrong-kind `index.json` or `changesets` as empty and skipped entries it did not know, so its next push would have deleted the rest. A branch this build cannot read whole is now `invalidBranch`, and nothing is pushed over it.
- A push filtered the local copy to the names it knew and reported success for the subset. A copy holding anything else is now `invalidCopy`, and nothing is pushed.

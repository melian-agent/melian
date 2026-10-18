# Step 23a: rounds in the store

[Pull request 152](https://github.com/melian-agent/melian/pull/152) builds item 1 of [the rounds decision](../decisions/2026-10-18-compare-rounds-exact-rule.md). It started on `c3d96b14`, stacked on [pull request 148](https://github.com/melian-agent/melian/pull/148). That parent merged during the gate and its branch was deleted, so the draft targets main.

`melian.rounds` version 1 retains a round for each new adjudication. Minting clears the live verdict, provenance and decision. Attachments and dismissals keep the current round. Adjudication writes the verdict and provenance copy in its verdict commit. Superseded tasks write neither. Distinct automatic check runs mint even when their records are identical.

Legacy verdict and comparison keys read as rounds without writing. Every writer preserves the old verdict and the legacy-first marker in its own transaction. Main’s pending adjudication tasks keep their legacy round. Historical SQLite fixtures and their repository bundle were captured by `ac4e8c07` code with fake models.

`melian findings <range> --rounds` lists a storage’s rounds in legacy-first order. `melian findings --round <id>` reads a frozen verdict from the chosen state directory without resolving its former refs or starting a task. Dismissal prompts remain on current-range reads.

No existing stored version changes. Comparisons remain version 1. The plan status stays unchanged; comparisons by round, membership and pull-request writes belong to the next three build pull requests. The design follows the decision, so design.md needs no amendment.

Validation: 61 distinct hand mutations fail their selected tests. The local builder report records the first failing tests, every mutation and its log. The first whole gate passed 4,881 tests and failed four existing sandbox process tests: three denied `ps` calls and a supervisor `toolFailed` mismatch. The full rerun and host-only checks are recorded in the report separately. No original assertion in an existing test changes.

The sandbox denied the scratch worktree’s metadata and a separate clone’s HEAD. The historical capture instead used an extracted `git archive ac4e8c07` tree and its own locked dependencies. The fixture README records this deviation. Live model reviews remain for the coordinator under this brief’s no-live-call rule.

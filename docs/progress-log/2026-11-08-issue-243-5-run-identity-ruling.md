The maintainer ruled on 2026-11-08, in the builder's session for [issue #243](https://github.com/melian-agent/melian/issues/243), on the class Melian rounds 1 to 3 raised on [pull request #339](https://github.com/melian-agent/melian/pull/339). A lens run's key had no field for who set its route or which credential paid. The ruling: what matters is whether the specific model and the specific level ran. Who set the route does not matter, and nor do the credentials.

- `f9edb6f` reverts fix pass 1's `2b5af58`, `9b1956d` and `b36fced`, which had added a lens route's source to the review index selection. The selection is again the one `main` builds, and the two tests that pinned a rerun on a changed source leave with it.
- `bea85fa` records the ruling in [the run identity decision](../decisions/2026-11-08-lens-run-identity.md). That decision amends the review plan resolution decision's promise that lineage always names the route that ran. `docs/design.md` and the pipeline guideline now say a run is reused for the same models and thinking, and its lineage describes the plan of the review that reads it.
- Rounds 2 and 3 raised two P1 `identity-missing-input` findings, about the credential left out of the key. The ruling answers both, and they are dismissed through a host round.

The revert restores code the build's mutation inventory already covers at `290385d`, so it adds no mutant.

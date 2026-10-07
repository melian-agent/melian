Closed the detached-reader coverage gap in [pull request #72](https://github.com/melian-agent/melian/pull/72). The regression stores a matched external import and adjudicates its Melian match with correctness debt. It then replaces the verdict for that revision with a clean one and reads through `ComparisonReader`.

The detached result retains the external finding, removes the stale match and Melian IDs, and owes no golden. The stored comparison remains unchanged. It uses memory storage and fake models.

Removing only the detached reader's refresh passed the original 22 pipeline comparison tests. With the regression added, the same mutation failed the match, Melian-ID and backlog assertions. The other 22 tests passed. The implementation was restored, and all 23 pipeline comparison tests passed.

# Publication details retain each lens's model lineage

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round eight, item 2: confirmed as a test gap. `reviewChangeset` copies described lineage into publication details, but the plan tests asserted only the verdict's lineage.

A new plan test runs both lenses on a preference-selected model that policy accepts. A fallback inside the committed route has no lineage by design; the preference supplies the non-trivial lineage this test needs. It reads the stored verdict document and checks each lens's publication lineage, including the wanted model and policy acceptance.

Validation: the plan suite passes. Removing the publication lineage assignment makes the new test fail.

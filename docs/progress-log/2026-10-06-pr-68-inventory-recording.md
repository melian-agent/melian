# Recorded GitHub mutation inventory

For [pull request #68](https://github.com/melian-agent/melian/pull/68), inverted the recording helper's branches and removed its early returns. Returning null for an object without page information passed the old suites. A new two-page recording puts an empty object before the connection. It asserts that cursor discovery reaches the second page and fails the mutation. All 72 recording and thread tests pass after restoration. No design decision changed.

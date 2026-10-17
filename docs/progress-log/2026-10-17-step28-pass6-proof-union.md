# Step 28 pass 6: retain every accepted cause

[Pull request #142](https://github.com/melian-agent/melian/pull/142).

The final cold round found that dismissal replaced the accumulated affected proof with the current revision’s citations.
A cites X. B cites only Y while X still stands. Dismissal at B lost X, so changing X to X2 stayed dismissed.

The new regression failed first: expected new, received dismissed.
Dismissal now accepts the union of the lifecycle’s proof and its revision’s citations.
The older-revision test retains both causes too. The design, pipeline guideline and decision’s as-built section state this rule.

Validation: the dismissal-trigger and findings suites passed, as did type checking.
Removing either contribution to the union fails the acceptance test.
Replacing the absent-proof fallback with Stryker’s sentinel fails the replay test.
The inventory and before/after logs are under tmp/step28-pass6*.
The whole gate follows the remaining fixes. The implementation plan stays unchanged for this fix pass.

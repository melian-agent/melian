# Review assertions for omitted standards and task identity

[Pull request #85](https://github.com/melian-agent/melian/pull/85) adds a counted-budget regression with omitted standards. The lens remains ended, retains its budget metadata and omission note, and leaves the verdict not reviewed.

The assertion sweep covers every introduced line in review.ts. New regressions guard supplied check records, tier and context forwarding, interrupted automatic checks, and changes to tools, coverage, prompt and budget ending policy. Unchanged repeats still attach. Mutation probes fail on the missing behaviours and restore the source after each run.

Rendered budget text omits the ending policy. A budget identity test must change ended alone; changing a numeric limit also changes the instructions and can hide a missing raw-budget fingerprint.

No production behaviour or design decision changes. The inventory and mutation logs stay under tmp/fix85j-*.

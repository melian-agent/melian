A pass on [pull request #131](https://github.com/melian-agent/melian/pull/131), after the full round at 65922d2a, closes one class of defect: a verdict feeding back into grouping or the speaker. The round's d19112ac and 9acf210b, the attack's F4 and the record's F2 were each one instance. A repeat review regrouped, cleared its judgements and paid to verify again.

The rule, in the decision and the core guideline:
- Grouping, the speaker's identity, and the severity they order by read only what the lenses reported.
- A refuted claim is handled after grouping. The defect resolves at the highest standing severity, and a refuted speaker shows the standing report's prose under its own ID.
- `readFindings` picks a winner by verdict only in the judged read, never in the read that verification groups from.

The commits:
- 2d68a6d6 holds the failing tests.
- a8530e35 holds the fix.
- fb1e4711 holds the documentation, with the pipeline guideline's dismissal paragraph corrected.
- 8769badf adds the publish plan's test.
- The last commit kills the round's mutation survivors, or names them as equivalent in the inventory.

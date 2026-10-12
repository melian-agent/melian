# Design baseline regressions have scripted goldens

The superseded-at-base clean case keeps both predecessor and successor at base, and expects no finding when the head follows the successor. The terminology-change case adds a conflicting decision without a Supersedes link and expects criterion-selection-bias on that decision, with the active base text as evidence.

The decision-file injection case puts a suppression instruction in a head decision. It expects both the injection and the independent fail-open default. All three use the fake model and the full tier. Their scripts assert tool results. Dropping a report or breaking a tool expectation fails the golden test; the live run must still measure model judgement.

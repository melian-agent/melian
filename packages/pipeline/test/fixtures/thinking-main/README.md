# Main before tier reasoning routes

Recorded from production code at `5175c664`, before changing source files.
The test harness supplied fake finder, failover, verifier, triage and walkthrough models.
It reviewed a removed optional chain and wrote a walkthrough through the normal tasks.

`bodies.json` records the fake provider's unset request bodies, in request order.
`main.sqlite` is the closed SQLite store after that run and a manual compaction.
`recorded.json` contains the task records read through `Harness.getTask`.
Each `initial` checkpoint comes from that version's registered task definition's `initial(input)` factory, called against main's source.

The reopen test writes those captured inputs and initial checkpoints with tokens of their recorded versions, then installs the current definitions.
It also copies and reopens the main database twice, comparing the stored verdict and provenance and checking the new document version.
No fixture invents a previous version's input shape or adds a reasoning level.

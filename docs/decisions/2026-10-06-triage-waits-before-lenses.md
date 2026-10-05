# Triage waits before lenses

A review waits for triage before choosing its lens selection. Pi Durable starts every pending task when it waits. A crashed lens task still named in the review index can therefore ask its models while triage is pending. A SQLite regression observes two such requests before the decider answers.

The decision commit removes any live lens task for that revision from the index. The sweep aborts it before the review waits. A stored answer or failure returns without starting the scheduler. Finished lens tasks remain attachable, and a crashed run with a stored decision still resumes through `runLenses`.

Supersedes: 2026-10-05-triage-as-built.md, for attachment to a live lens task while a new decision remains pending.

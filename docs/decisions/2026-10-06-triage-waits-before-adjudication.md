# Triage waits before adjudication

A lens task may finish before a crash parks its adjudication. Fresh triage kept that adjudication named in the review index. Waiting resumed it, so it could write the old selection's verdict before triage answered.

A pending decision removes the revision's adjudication task from the index in the same commit that removes any live lens task. Finished lens tasks remain attachable. The replacement sweep aborts unnamed adjudications before waiting. Their terminal commits also refuse to write once unnamed, covering a crash before the abort.

A SQLite regression kills a review at adjudication, reopens with a held decider, and changes the selection. It checks that the old adjudication is aborted without writing, then that the new quick review's verdict stands after another resume.

Supersedes: 2026-10-06-triage-waits-before-lenses.md, for adjudication while a new decision remains pending.

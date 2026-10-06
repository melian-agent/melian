# Pending walkthroughs do not spend retry attempts

Choice: count summariser tasks that ended failed or completed without a walkthrough, or that a retry replaced. Count each task once. Resume the indexed pending task before checking the two-attempt limit. Success clears the count; an explicit rerun resets it.

Problem: creating a task was charged as an attempt. A crash after its creation could reach the retry limit before the task made a model call.

Example: storage holds two starts and an unfinished summariser. The next review resumes that task and records its summary, rather than returning at the limit.

The summary index upgrades from version 1 to 2 with the last task marked charged, preserving old counts. Resuming that task while pending refunds its old creation charge. The upgrade is one way, like the other durable documents; an older Melian cannot read the newer summary index.

Supersedes: [2026-10-05-ledger-recovery-and-bounds.md](2026-10-05-ledger-recovery-and-bounds.md) for summariser attempt accounting.

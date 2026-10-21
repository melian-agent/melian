# Review of record on pull request #155

The review of record for [pull request #155](https://github.com/melian-agent/melian/pull/155) approved with nits. Two were fixed.

- Every still-open finding was repeated in full in every review body, even with its thread open. The body now lists a still-open finding only when a human resolved its thread or the thread is gone. Before posting a review, publication reads each still-open thread's state and passes those IDs as `ReviewDraft.carried`. That adds one GraphQL thread listing per review that has still-open threads. The step-29 trust-floor test returns to main's expectation, since it was changed only for the broad body. The human-resolved test now expects that one read.
- A version-2 and version-5 fixture in `packages/github/test/ledger.test.ts` again holds the shape those versions wrote.

Two findings are known limits, with no code change:

- When one finding has two owed threads, reuse takes the oldest. For example, H1 posts F in T1 and its reply fails. A human resolves T1, H3 posts F in T2, and that reply fails too. The human reopens T1, and when F returns it reuses T1, leaving T2 open beside it until F is fixed. Both close then. Main would start a third thread. Preferring the newest owed thread would match "goes back to its own thread".
- One malformed thread anywhere on a pull request stalls every thread action. `readThreads` rejects the whole listing when any thread, a human's included, lacks exactly one comment node. `replyResolved` and review posting now read it. Each failure comes after the status is set, so trust holds. Skipping a thread whose first comment is not Melian's root would remove the stall.

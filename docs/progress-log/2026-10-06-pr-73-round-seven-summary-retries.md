# Pending walkthrough tasks resume at the retry limit

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round seven, item 3: confirmed by tracing the early attempt-limit return. A pending-task regression fails there and passes after the fix.

The live-task check now precedes the limit. Accounting counts each finished or replaced task once. The summary index migration preserves old counts and refunds a pending task's creation charge.

Validation: the summariser suite passes. It covers a pending version 1 index at the old limit, repeated blocked reviews with zero charged attempts, and the existing two-failure limit and explicit rerun.

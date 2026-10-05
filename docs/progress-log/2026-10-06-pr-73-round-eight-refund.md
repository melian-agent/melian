# The summary migration test checks the refund

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round eight, item 3: confirmed as a test gap. The version 1 summary-index test checked successful recovery only. Success clears the attempt counter, masking a missing pending-task refund.

The test now resumes the migrated task while its extension is absent. It checks that the old counter falls from two to one and stays at one on the next review. It then installs the extension and checks successful recovery as before.

Validation: the summariser suite passes. Removing the decrement makes the new assertion fail with two attempts instead of one.

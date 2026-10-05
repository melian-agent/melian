# Ledger status recovery avoids repeated writes

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round eight, item 1: confirmed. The ledger-link guard read only the locally recorded URL. A crash after GitHub accepted the status and before the commit repeated that write.

The provider now reads the latest review status for the head. Publication records a matching state and target URL without writing another status. A different state or URL still takes a write.

Validation: the crash fixture parks after the fake accepts the linked status and before its response returns. Recovery posts nothing when the status matches, and repairs a newer status with a different state or URL.

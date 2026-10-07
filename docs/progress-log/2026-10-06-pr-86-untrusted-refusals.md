# Guard writer trust through publication refusals

[Pull request #86](https://github.com/melian-agent/melian/pull/86) addresses Melian finding 891a44bbcc810a0f. Orphaned-ledger and three-review-refusal cases now run with writer trust on and off. With trust off, every new status must retain the trusted-host reason, including the final status.

Removing the status override must fail the orphaned-ledger case. Removing the abandonment choice must fail the three-refusal case. Both tests use fake GitHub transports.

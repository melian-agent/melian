# Required status: publication attribution

Branch `required-status` records publication identity and writer trust per revision and in ledger run details. Stored records upgrade to version 6; interrupted publish tasks upgrade to version 2. Old records and inputs default to trusted writers without a known poster.

Trust off posts the review and ledger with an error status and a reason. A repeat stays stable. Crash tests cover GitHub accepting a status before the record commit. Authors without write permission remain publishable by the maintainer. The required-status switch and Actions host remain pending.

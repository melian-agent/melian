# Required status: publication attribution

Branch `required-status` records publication identity and writer trust per revision and in ledger run details. Stored records upgrade to version 6; interrupted publish tasks upgrade to version 2. Old records and inputs default to trusted writers without a known poster.

Trust off posts the review and ledger with an error status and a reason. A repeat stays stable. Crash tests cover GitHub accepting a status before the record commit. Authors without write permission remain publishable by the maintainer. The required-status switch and Actions host remain pending.

The first fix pass confirms that a changed publisher could resume with the old attribution. Publisher document version 2 records full attribution. Crash coverage changes both login and permission after the first status and checks the review, ledger and stored attribution.

The public publish API now requires explicit writer trust and refuses omission before writing. CLI regressions cover false trust at the base with true trust at the head, error text and exit 0, and a trusted clean review with success status.
